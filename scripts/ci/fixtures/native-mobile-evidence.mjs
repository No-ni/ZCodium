import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { loadComponentCallback } from "./component-callback.mjs";
import { assertProjectPath, createProjectTestFixture } from "../project-test-sandbox.mjs";

export const directory = "packages/desktop/test/e2e/helpers/native-context-compression/";

export const task = "SYNTHETIC_TASK_ID_DO_NOT_RECORD";

export const workspace = "SYNTHETIC_WORKSPACE_PATH_DO_NOT_RECORD";

export const rawError = new Error("SYNTHETIC_RAW_ERROR_DO_NOT_RECORD");

export async function withinBoundary(action) {
  let timer;
  try {
    return await Promise.race([
      action(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("actual collector exceeded diagnostic boundary")),
          300,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function fixture({
  domFailure,
  mainFailure,
  pngFailure,
  appendFailureAt,
  hidden = false,
} = {}) {
  const diagnostics = await createProjectTestFixture("native-mobile-evidence");
  const dom = new JSDOM(
    `<section data-mobile-page="chat">
    <div data-root-workspace-surface="interactive">
      <main data-testid="synthetic-pane" data-session-id="${task}">
        <button data-testid="native-context-entry"></button>
      </main>
    </div>
  </section><div data-testid="root-startup-loading" aria-busy="true"></div>
  <div data-testid="database-startup-status" aria-busy="false"></div>
  <div data-testid="onboarding-page" hidden></div><div data-wizard-step="session" hidden></div>`,
    { pretendToBeVisual: true },
  );
  const document = dom.window.document;
  document.body.dataset.sensitive = rawError.message;
  const surface = document.querySelector("[data-root-workspace-surface]");
  if (hidden) surface.style.opacity = "0";
  dom.window.Element.prototype.getClientRects = () => [{ width: 100, height: 80 }];
  dom.window.Element.prototype.getBoundingClientRect = () => ({
    x: 10,
    y: 10,
    width: 100,
    height: 80,
  });
  document.elementFromPoint = () => document.querySelector('[data-testid="native-context-entry"]');
  const events = [];
  const timers = new Set();
  let releaseMain;
  let writes = 0;
  const value = (failure, success) =>
    failure === "pending"
      ? new Promise(() => {})
      : failure === "reject"
        ? Promise.reject(rawError)
        : Promise.resolve(success);
  const page = {
    evaluate: async (callback, argument) => {
      events.push("dom-read");
      return value(domFailure, domFailure ? null : callback(argument));
    },
    screenshot: async (options) => {
      events.push("png-attempt");
      assert.equal(options.fullPage, false, "failure screenshots must remain viewport bounded");
      assert.equal(options.timeout, 5000);
      const path = await assertProjectPath(options.path);
      if (pngFailure) return value(pngFailure, undefined);
      await writeFile(path, Buffer.from("synthetic screenshot port bytes"));
    },
    setDefaultTimeout: () => {},
    bringToFront: async () => {},
    waitForFunction: async () => {},
  };
  const record = await loadComponentCallback(
    directory + "mobile-evidence.ts",
    "recordNativeContextMobileEvidence",
    {
      appendFile: async (path, text) => {
        const item = JSON.parse(text);
        events.push("write-" + (item.part ?? "legacy"));
        if (writes++ === appendFailureAt) throw rawError;
        await appendFile(await assertProjectPath(path), text);
      },
      join,
      assertNativeContextTestPath: assertProjectPath,
      readMobileTaskView: () => {
        events.push("main-read");
        if (mainFailure === "held")
          return new Promise((resolveMain) => {
            releaseMain = resolveMain;
          });
        return value(
          mainFailure,
          mainFailure === "invalid"
            ? { connected: "invalid", view: {} }
            : { connected: true, view: { taskId: task, workspacePath: workspace } },
        );
      },
      TID_V4_SESSION_PANE: "synthetic",
      testId: () => "synthetic-pane",
      DEFAULT_WORKSPACE: workspace,
      document,
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
      innerWidth: 390,
      innerHeight: 844,
      window: { matchMedia: () => ({ matches: true }) },
      setTimeout: (callback, delay) => {
        assert.equal(
          delay,
          5000,
          "only the finite diagnostic clock is accelerated in this source harness",
        );
        const timer = setTimeout(callback, 20);
        timers.add(timer);
        return timer;
      },
      clearTimeout: (timer) => {
        timers.delete(timer);
        clearTimeout(timer);
      },
    },
  );
  return {
    diagnostics,
    page,
    events,
    record,
    releaseMain: () =>
      releaseMain?.({ connected: true, view: { taskId: task, workspacePath: workspace } }),
    outstandingTimers: () => timers.size,
    run: (stage = "admission-failed") =>
      withinBoundary(() => record(page, diagnostics, stage, task)),
    rows: async (target = diagnostics) =>
      (await readFile(join(target, "native-view-evidence.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    close: () => {
      for (const timer of timers) clearTimeout(timer);
      dom.window.close();
    },
  };
}

export async function creator(f, { admissionError = rawError, cleanupError } = {}) {
  const context = {
    pages: () => [f.page],
    close: async () => {
      f.events.push("context-close");
      if (cleanupError) throw cleanupError;
    },
  };
  return loadComponentCallback(directory + "mobile.ts", "createNativeContextMobileBrowser", {
    appendFile,
    mkdir,
    join,
    assertNativeContextTestPath: assertProjectPath,
    process: { env: { ZCODIUM_E2E_MOBILE_URL: "http://127.0.0.1:5173" } },
    chromium: {
      launchPersistentContext: async () => {
        f.events.push("launch-port");
        return context;
      },
    },
    obtainNativeContextPairingUrl: async () => "synthetic pairing kept in memory",
    openMobilePairingPage: async () => {
      if (admissionError) throw admissionError;
    },
    useNativeTabVisibility: async () => {},
    prepareNativeContextMobileOnboarding: async () => ({ handledAfter: true }),
    recordNativeContextMobileEvidence: f.record,
  });
}
