import { lstat, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const CASE_TITLE = "keeps the open model picker responsive when the composer shrinks and expands";
const CASE_SUFFIX =
  "/packages/desktop/test/e2e/conversation-session/conversation-session-v4-composer-toolbar.test.ts";
let observationCounter = 0;

interface ObservationPaths {
  artifacts: string;
  observerSourceSha256: string;
  hookSourceSha256: string;
}

function selected(context: Mocha.Context): boolean {
  const test = context.currentTest;
  return (
    test?.title === CASE_TITLE && Boolean(test.file?.replaceAll("\\", "/").endsWith(CASE_SUFFIX))
  );
}

// 原因：tsx keepNames给闭包注入helper，传远端函数会丢绑定；raw JS只依赖页面内置API。
export const COMPOSER_FIT_BEGIN_SCRIPT = String.raw`return (() => {
  const key = "__qaComposerFitObservationV1";
  window[key]?.finish();
  const started = performance.now();
  const snapshots = [];
  const pendingReasons = new Set();
  let dropped = 0;
  let protected240Frames = 0;
  let firstRaf = 0;
  let secondRaf = 0;
  let stopped = false;
  let boundShell = null;
  let boundToolbar = null;
  const targets = () => {
    const model = document.querySelector('[data-testid="chat-model-select-trigger"]');
    const input = document.querySelector('[data-testid="v4-composer-input"]');
    const shell = model?.closest("[data-composer-layout]") ?? input?.closest("[data-composer-layout]") ?? null;
    const toolbar = model?.closest('[class~="group/toolbar"]') ?? shell?.querySelector('[class~="group/toolbar"]') ?? null;
    return {model, input, shell, toolbar};
  };
  const inspect = (element) => {
    if (!element) return null;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName, testId: element.getAttribute("data-testid"),
      className: element.getAttribute("class"), dataset: {...element.dataset},
      inlineStyle: {width: element.style.width, height: element.style.height},
      rect: rect.toJSON(), computed: {
        display: style.display, visibility: style.visibility, opacity: style.opacity,
        width: style.width, minWidth: style.minWidth, height: style.height,
        fontSize: style.fontSize, lineHeight: style.lineHeight,
        flex: style.flex, flexDirection: style.flexDirection, flexWrap: style.flexWrap,
        gap: style.gap, padding: style.padding, borderWidth: style.borderWidth,
      },
      scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
    };
  };
  const capture = (reason) => {
    if (stopped) return;
    const {model, input, shell, toolbar} = targets();
    const pane = shell?.closest('[data-testid^="v4-session-pane-"]');
    const snapshot = {
      reason, elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
      dpr: window.devicePixelRatio,
      viewport: {width: window.innerWidth, height: window.innerHeight, scale: window.visualViewport?.scale ?? null},
      pane: {testId: pane?.getAttribute("data-testid") ?? null, sessionId: pane?.getAttribute("data-session-id") ?? null},
      shell: inspect(shell), toolbar: inspect(toolbar), model: inspect(model), input: inspect(input),
      leading: inspect(toolbar?.querySelector("[data-composer-leading-actions]") ?? null),
      leadingContent: inspect(toolbar?.querySelector("[data-composer-leading-content]") ?? null),
      trailing: inspect(toolbar?.querySelector("[data-composer-trailing-actions]") ?? null),
      label: inspect(model?.querySelector("[data-composer-open-label]") ?? null),
      icon: inspect(model?.querySelector("[data-composer-open-icon]") ?? null),
      thought: inspect(model?.querySelector("[data-composer-open-thought]") ?? null),
      textSpans: Array.from(model?.querySelectorAll("span") ?? []).slice(0, 12).map((span) => ({...inspect(span), text: (span.textContent ?? "").trim().slice(0, 160)})),
      controls: Array.from(toolbar?.querySelectorAll("[data-composer-collapse-priority]") ?? []).slice(0, 12).map(inspect),
    };
    const is240 = shell?.style.width === "240px" || toolbar?.style.width === "240px";
    snapshot.protected240 = is240 && protected240Frames < 2;
    if (snapshot.protected240) protected240Frames += 1;
    if (snapshots.length >= 24) {
      // 原因：finally恢复宽度仍会产生属性变动，固定初始两帧及首两张240px帧。
      const discardIndex = snapshots.findIndex((item, index) => index >= 2 && !item.protected240);
      snapshots.splice(discardIndex, 1);
      dropped += 1;
    }
    snapshots.push(snapshot);
  };
  const schedule = (reason) => {
    if (stopped) return;
    pendingReasons.add(reason);
    if (firstRaf || secondRaf) return;
    firstRaf = requestAnimationFrame(() => {
      firstRaf = 0;
      const reasons = Array.from(pendingReasons).join(",");
      pendingReasons.clear();
      capture(reasons + ":frame1");
      secondRaf = requestAnimationFrame(() => {
        secondRaf = 0;
        capture(reasons + ":frame2");
        if (pendingReasons.size) schedule("coalesced");
      });
    });
  };
  const attributes = new MutationObserver((records) => {
    const reasons = Array.from(new Set(records.map((record) => {
      const owner = record.target === boundShell ? "shell" : record.target === boundToolbar ? "toolbar" : "control";
      return owner + "." + record.attributeName;
    })));
    schedule(reasons.join(","));
  });
  const bind = () => {
    const {shell, toolbar} = targets();
    if (shell === boundShell && toolbar === boundToolbar) return;
    attributes.disconnect();
    boundShell = shell;
    boundToolbar = toolbar;
    const options = {attributes: true, attributeFilter: ["style", "data-composer-layout", "data-composer-model-icon", "data-composer-provider-compact", "data-composer-compact"]};
    if (shell) attributes.observe(shell, options);
    if (toolbar && toolbar !== shell) attributes.observe(toolbar, {...options, subtree: true});
    schedule("targets-changed");
  };
  const topology = new MutationObserver(bind);
  topology.observe(document.body, {childList: true, subtree: true});
  bind();
  capture("initial");
  schedule("initial-settled");
  const finish = () => {
    if (!stopped) capture("finish");
    stopped = true;
    attributes.disconnect();
    topology.disconnect();
    cancelAnimationFrame(firstRaf);
    cancelAnimationFrame(secondRaf);
    firstRaf = 0;
    secondRaf = 0;
    delete window[key];
    return {present: true, limit: 24, dropped, snapshots};
  };
  window[key] = {finish};
  return {installed: true, limit: 24};
})();`;

export const COMPOSER_FIT_FINISH_SCRIPT = String.raw`return (() => {
  const observation = window.__qaComposerFitObservationV1;
  return observation ? observation.finish() : {present: false, limit: 24, dropped: 0, snapshots: []};
})();`;

async function safeArtifactDirectory(paths: ObservationPaths): Promise<string> {
  const repository = resolve(import.meta.dirname, "../../..");
  const artifacts = resolve(paths.artifacts);
  const rel = relative(repository, artifacts);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error("Composer observer refuses artifact path outside worktree");
  const envArtifacts = process.env.ZCODE_E2E_ARTIFACT_DIR;
  if (!envArtifacts || resolve(envArtifacts).toLowerCase() !== artifacts.toLowerCase())
    throw new Error("Composer observer artifact environment mismatch");
  for (let cursor = artifacts; ; cursor = dirname(cursor)) {
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink() || (await realpath(cursor)).toLowerCase() !== cursor.toLowerCase())
      throw new Error("Composer observer refuses reparse/redirected ancestor");
    if (cursor.toLowerCase() === repository.toLowerCase()) break;
  }
  if (!(await lstat(artifacts)).isDirectory())
    throw new Error("Composer observer artifact directory missing");
  return artifacts;
}

export async function beginComposerFitObservation(context: Mocha.Context): Promise<void> {
  if (!selected(context)) return;
  await browser.execute(COMPOSER_FIT_BEGIN_SCRIPT);
}

export async function finishComposerFitObservation(
  context: Mocha.Context,
  paths: ObservationPaths,
): Promise<void> {
  if (!selected(context)) return;
  const test = context.currentTest!;
  const artifacts = await safeArtifactDirectory(paths);
  const worker = (process.env.WDIO_WORKER_ID || String(process.pid)).replace(
    /[^a-zA-Z0-9_-]/gu,
    "_",
  );
  const counter = ++observationCounter;
  const stem = join(
    artifacts,
    `qa-composer-fit-${worker}-${String(counter).padStart(3, "0")}-${process.pid}-${Date.now()}`,
  );
  const evidence: Record<string, unknown> = {
    capturedAt: new Date().toISOString(),
    evidenceKind:
      "read-only bounded DOM history; screenshot is final cleanup frame, not failure-frame video",
    worker,
    counter,
    ...paths,
    test: {
      title: test.title,
      file: test.file,
      state: test.state,
      assertionError: test.err?.message ?? null,
    },
  };
  let observationError: unknown;
  try {
    const history = (await browser.execute(COMPOSER_FIT_FINISH_SCRIPT)) as { present?: boolean };
    evidence.history = history;
    if (!history.present)
      throw new Error("Composer fit observer history missing; not layout evidence");
    const image = await browser.takeScreenshot();
    await writeFile(stem + ".png", Buffer.from(image, "base64"), { flag: "wx" });
    evidence.screenshot = stem + ".png";
  } catch (error) {
    observationError = error;
    evidence.observationError = error instanceof Error ? error.message : String(error);
  }
  await writeFile(stem + ".json", JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
  if (observationError) throw observationError;
}
