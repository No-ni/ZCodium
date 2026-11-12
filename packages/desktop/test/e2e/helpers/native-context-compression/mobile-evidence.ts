import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { TID_V4_SESSION_PANE, testId } from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE } from "../desktop-app.js";
import { readMobileTaskView } from "../web-remote-unread.js";
import { assertNativeContextTestPath } from "./environment.js";

export type NativeContextMobileEvidenceStage =
  | "onboarding-before-reload"
  | "onboarding-after-reload"
  | "onboarding-ready"
  | "admission-failed"
  | "task-home-failed"
  | "task-chat-failed"
  | "task-session-failed"
  | "task-main-view-failed"
  | "task-native-entry-failed"
  | "task-open";

/** 只保存可见性、遮盖与身份匹配；不记录 URL、配对 proof、路径、正文或原始错误。 */
export async function recordNativeContextMobileEvidence(
  page: Page,
  diagnostics: string,
  stage: NativeContextMobileEvidenceStage,
  taskId?: string,
) {
  const stages: readonly string[] = [
    "onboarding-before-reload",
    "onboarding-after-reload",
    "onboarding-ready",
    "admission-failed",
    "task-home-failed",
    "task-chat-failed",
    "task-session-failed",
    "task-main-view-failed",
    "task-native-entry-failed",
    "task-open",
  ];
  const safeStage = stages.find((item) => item === stage) ?? "unknown";
  const captureId = Date.now();
  const path = await assertNativeContextTestPath(join(diagnostics, "native-view-evidence.jsonl"));
  let writeFailed = false;
  const persist = async (
    part: "begin" | "surface" | "main" | "screenshot",
    detail: Record<string, unknown> = {},
  ) => {
    try {
      await appendFile(
        path,
        JSON.stringify({ stage: safeStage, captureId, part, ...detail }) + "\n",
      );
    } catch {
      // 原因：一次落盘失败也不能阻止其它可读证据和 PNG；最后用安全 code 报告存储失败。
      writeFailed = true;
    }
  };
  const read = async <T>(action: () => Promise<T>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve()
          .then(action)
          .then(
            (value) => ({ code: "ok" as const, value }),
            () => ({ code: "read-failed" as const }),
          ),
        new Promise<{ code: "read-timeout" }>((resolveRead) => {
          timer = setTimeout(() => resolveRead({ code: "read-timeout" }), 5_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  // 原因：旧实现等 DOM 和 Main 都完成才写文件；reload 失败或 Main 挂起会丢失整个现场。
  // 这里仅限制诊断读取，既有业务准入和 Main 查看强断言的等待不变，也不重试/写入连接状态。
  await persist("begin");
  const surface = await read(() =>
    page.evaluate(
      ({ paneId, session }) => {
        const selectors = {
          home: '[data-mobile-page="home"]',
          chat: '[data-mobile-page="chat"]',
          pane: `[data-testid="${paneId}"]`,
          startup: '[data-testid="root-startup-loading"]',
          database: '[data-testid="database-startup-status"]',
          workspace: "[data-root-workspace-surface]",
          occupation: '[data-testid="onboarding-page"]',
          migration: "[data-wizard-step]",
          sidePane: '[data-mobile-side-pane-overlay][aria-hidden="false"]',
          reconnect: '[data-web-remote-control-reconnect-notice="true"]',
          native: '[data-testid="native-context-entry"]',
          alert: '[role="alert"]',
          status: '[role="status"]',
        };
        const visible: Record<string, boolean> = {};
        const present: Record<string, boolean> = {};
        for (const [key, selector] of Object.entries(selectors)) {
          const node = document.querySelector<HTMLElement>(selector);
          const rect = node?.getBoundingClientRect();
          present[key] = Boolean(node);
          let painted = Boolean(node && rect && rect.width > 0 && rect.height > 0);
          let depth = 0;
          for (
            let current = node;
            current && painted && depth < 64;
            current = current.parentElement
          ) {
            const style = getComputedStyle(current);
            painted =
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              style.visibility !== "collapse" &&
              style.opacity !== "0";
            depth += 1;
            if (depth === 64 && current.parentElement) painted = false;
          }
          visible[key] = Boolean(
            painted &&
            rect &&
            rect.x < innerWidth &&
            rect.y < innerHeight &&
            rect.x + rect.width > 0 &&
            rect.y + rect.height > 0,
          );
        }
        const pageKind = document
          .querySelector("[data-mobile-page]")
          ?.getAttribute("data-mobile-page");
        const pane = document.querySelector(`[data-testid="${paneId}"]`);
        const workspace = document
          .querySelector("[data-root-workspace-surface]")
          ?.getAttribute("data-root-workspace-surface");
        const startupBusy = document.querySelector(selectors.startup)?.getAttribute("aria-busy");
        const databaseBusy = document.querySelector(selectors.database)?.getAttribute("aria-busy");
        return {
          visibility: document.visibilityState === "visible" ? "visible" : "hidden",
          focused: document.hasFocus(),
          viewport: {
            width: Math.min(8192, Math.max(0, Math.round(innerWidth))),
            height: Math.min(8192, Math.max(0, Math.round(innerHeight))),
          },
          mobileViewport: window.matchMedia("(max-width: 767px)").matches,
          page: pageKind === "home" || pageKind === "chat" ? pageKind : null,
          homePresent: present.home,
          homeVisible: visible.home,
          chatPresent: present.chat,
          chatVisible: visible.chat,
          panePresent: present.pane,
          paneVisible: visible.pane,
          paneInert: Boolean(pane?.closest("[inert]")),
          paneSessionPresent: Boolean(pane?.getAttribute("data-session-id")),
          paneSessionMatches: session ? pane?.getAttribute("data-session-id") === session : null,
          rootStartupPresent: present.startup,
          rootStartupVisible: visible.startup,
          rootStartupBusy: startupBusy === "true" ? true : startupBusy === "false" ? false : null,
          databaseStartupPresent: present.database,
          databaseStartupVisible: visible.database,
          databaseStartupBusy:
            databaseBusy === "true" ? true : databaseBusy === "false" ? false : null,
          workspaceSurface: workspace === "interactive" || workspace === "inert" ? workspace : null,
          workspaceSurfaceVisible: visible.workspace,
          alertPresent: present.alert,
          alertVisible: visible.alert,
          statusPresent: present.status,
          statusVisible: visible.status,
          occupationOnboardingVisible: visible.occupation,
          migrationDialogVisible: visible.migration,
          sidePaneOverlayVisible: visible.sidePane,
          reconnectNoticeVisible: visible.reconnect,
          nativeContextEntryVisible: visible.native,
        };
      },
      { paneId: testId(TID_V4_SESSION_PANE, "workspace-main"), session: taskId },
    ),
  );
  await persist("surface", {
    code: surface.code,
    surface: surface.code === "ok" ? surface.value : null,
  });

  const main = await read(readMobileTaskView);
  if (main.code === "ok") {
    const result = main.value;
    const view = result?.view;
    const valid =
      typeof result?.connected === "boolean" &&
      (view === null ||
        (typeof view?.taskId === "string" &&
          typeof view.workspacePath === "string" &&
          (view.workspaceIdentity === undefined || typeof view.workspaceIdentity === "string")));
    await persist("main", {
      code: valid ? "ok" : "invalid-result",
      main: valid
        ? {
            readable: true,
            connected: result.connected,
            viewPresent: Boolean(view),
            taskMatches: taskId ? view?.taskId === taskId : null,
            workspaceMatches: view ? view.workspacePath === DEFAULT_WORKSPACE : null,
            workspaceIdentityAbsent: view ? view.workspaceIdentity === undefined : null,
          }
        : null,
    });
  } else await persist("main", { code: main.code, main: null });

  if (safeStage.endsWith("-failed")) {
    // PNG 独立于 DOM/Main 是否可读；只截当前 viewport，关闭 context 前完成或记录诊断超时。
    const screenshot = await read(async () => {
      const png = await assertNativeContextTestPath(
        join(diagnostics, `native-view-${safeStage}-${captureId}.png`),
      );
      await page.screenshot({ path: png, fullPage: false, timeout: 5_000 });
    });
    await persist("screenshot", { code: screenshot.code });
  } else await persist("screenshot", { code: "not-requested" });
  if (writeFailed) throw new Error("NCTX_MOBILE_EVIDENCE_WRITE_FAILED");
}
