import assert from "node:assert/strict";
import test from "node:test";
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  formatModelPickerValue,
  parseModelPickerValue,
} from "../../packages/shared/src/model-selection.ts";
import { loadComponentCallback } from "./fixtures/component-callback.mjs";
import { assertProjectPath } from "./project-test-sandbox.mjs";

const root = "packages/desktop/test/e2e/helpers/native-context-compression/";
const match = (value) => ({
  toEqual: (expected) => assert.deepEqual(value, expected),
  toBe: (expected) => assert.equal(value, expected),
  toHaveLength: (expected) => assert.equal(value.length, expected),
  toBeLessThanOrEqual: (expected) => assert.ok(value <= expected),
  toBeGreaterThan: (expected) => assert.ok(value > expected),
  toBeLessThan: (expected) => assert.ok(value < expected),
});

async function boundedReads(changePage = (page) => page) {
  const status = { revision: 9, generation: 2, historyVersion: "a".repeat(64) };
  const rows = [18, 16, 13, 8, 2].map((sequence) => ({ id: `observation-${sequence}`, sequence }));
  const sources = ["m1", "m2", "m3"].map((ref) => ({ ref }));
  const cursors = [];
  const offsets = [];
  const target = { sessionId: "fixture-session" };
  const evidence = {
    operationId: "image-operation",
    originalRefs: ["m3"],
    originalSha256: "fixture-original-hash",
    sourceBytes: 3,
  };
  let requestReads = 0;
  const ports = {
    expect: match,
    getUpstreamRequestRecordCount: async () => {
      requestReads++;
      return 7;
    },
    getNativeContextStatus: async () => status,
    listNativeContextObservations: async (_target, _status, options) => {
      if (options.limit === 2) {
        if (cursors.length === 0) assert.equal(Object.hasOwn(options, "cursor"), false);
        cursors.push(options.cursor);
      }
      // 同 SessionStore 的真实语义：cursor 是排他 sequence 上界，不是从零开始的 offset。
      const eligible = rows.filter(
        (item) => options.cursor === undefined || item.sequence < options.cursor,
      );
      const items = eligible.slice(0, options.limit);
      const page = {
        ...status,
        items,
        nextCursor: eligible.length > options.limit ? items.at(-1).sequence : null,
      };
      return options.limit === 2 ? changePage(page) : page;
    },
    listNativeContextRecords: async (_target, _status, { limit }) => ({
      items: [{ operationId: evidence.operationId }].slice(0, limit),
    }),
    readNativeContextRecord: async (_target, _status, _operationId, options) => {
      if (options.sourceLimit === 100) return { sources, sourceTotal: sources.length };
      offsets.push(options.sourceCursor);
      assert.equal(options.summaryLimitChars, 1);
      const items = sources.slice(options.sourceCursor, options.sourceCursor + options.sourceLimit);
      return {
        revision: status.revision,
        viewGeneration: status.generation,
        viewHistoryVersion: status.historyVersion,
        sources: items,
        sourceTotal: sources.length,
        nextSourceCursor:
          options.sourceCursor + items.length < sources.length
            ? options.sourceCursor + items.length
            : null,
      };
    },
    readNativeContextOriginalImage: async () => ({
      sha256: evidence.originalSha256,
      bytes: Buffer.from("abc"),
    }),
  };
  const run = await loadComponentCallback(
    root + "recovery.ts",
    "assertNativeContextBoundedReads",
    ports,
  );
  return { run: () => run(target, evidence), cursors, offsets, requestReads: () => requestReads };
}

test("actual recovery helper omits first sequence cursor, moves DESC and preserves zero-based source offsets", async () => {
  const f = await boundedReads();
  await f.run();
  assert.deepEqual(f.cursors, [undefined, 16, 8]);
  assert.deepEqual(f.offsets, [0, 1, 2]);
  assert.equal(
    f.requestReads(),
    2,
    "read-only pagination must retain its no-new-request assertion",
  );
});

test("actual bounded reads still reject a changed view revision", async () => {
  const f = await boundedReads((page) => ({ ...page, revision: page.revision + 1 }));
  await assert.rejects(f.run(), { name: "AssertionError" });
});

test("actual bounded reads reject nondecreasing continuation without reading repeated pages", async () => {
  const f = await boundedReads((page) => ({ ...page, nextCursor: 16 }));
  await assert.rejects(f.run(), { name: "AssertionError" });
  assert.ok(f.cursors.length <= 2);
});

async function ledgerResumeFixture({ statusPhase = "resume", changeFacts = false } = {}) {
  const homeDir = await assertProjectPath(resolve(process.env.HOME));
  const workspacePath = await assertProjectPath(join(homeDir, "fixture-workspace"));
  const dbPath = await assertProjectPath(join(homeDir, ".zcodium", "cli", "db", "db.sqlite"));
  const manifest = {
    sandboxRoot: process.env.PROJECT_TEST_SANDBOX_ROOT,
    homeDir,
    workspacePath,
    dbPath,
    sessionId: "fixture-ledger-session",
    revision: 0,
    generation: 0,
    historyVersion: "b".repeat(64),
    currentSegmentId: "initial",
    model: { providerId: "E2E_FIXTURE_PROVIDER", modelId: "E2E_PRIMARY" },
    seedFacts: Object.fromEntries(
      ["canonical", "sources", "kernel", "imageReceipts", "observations", "operations"].map(
        (name) => [name + "Sha256", "d".repeat(64)],
      ),
    ),
    resumeExpected: {
      revision: 1,
      generation: 0,
      historyVersion: "c".repeat(64),
      policyVersion: 0,
      currentSegmentId: "initial",
    },
  };
  const requests = [];
  const selected = [];
  const verifiedPhases = [];
  let reads = 0;
  const ports = {
    assert,
    resolve,
    join,
    formatModelPickerValue,
    process: { env: { ZCODE_SESSION_DB_PATH: dbPath } },
    DEFAULT_WORKSPACE: workspacePath,
    resolveE2EHomeDir: () => homeDir,
    assertNativeContextTestPath: assertProjectPath,
    nativeContextLedgerManifestSchema: { parse: (value) => value },
    verifyNativeContextLargeLedgerForE2E: async (input, phase) => {
      assert.equal(input, manifest);
      verifiedPhases.push(phase);
      const version =
        phase === "seed"
          ? {
              revision: manifest.revision,
              generation: manifest.generation,
              historyVersion: manifest.historyVersion,
              currentSegmentId: manifest.currentSegmentId,
              policyVersion: 0,
            }
          : manifest.resumeExpected;
      return {
        version,
        facts:
          changeFacts && phase === "resume"
            ? { ...manifest.seedFacts, observationsSha256: "e".repeat(64) }
            : manifest.seedFacts,
      };
    },
    ServiceChannels: { ZCodeTask: "zcode-task" },
    getUpstreamRequestRecordCount: async () => {
      reads++;
      return 11;
    },
    browser: { execute: async () => true },
    closeNativeContextDetails: async () => {},
    callHandoffHost: async (channel, method, args) => {
      requests.push({ channel, method, args });
      assert.equal(typeof args[0].model, "string", "resumeTask.model is a public string contract");
      assert.deepEqual(
        parseModelPickerValue(args[0].model),
        manifest.model,
        "resumeTask.model must satisfy the public Provider/model selection parser",
      );
    },
    selectV4TaskById: async (id) => selected.push(id),
    getNativeContextStatus: async () => ({
      ...(statusPhase === "seed" ? manifest : manifest.resumeExpected),
      policy: { mode: "manual", policyVersion: 0 },
    }),
  };
  const open = await loadComponentCallback(
    root + "ledger.ts",
    "openNativeContextLargeLedger",
    ports,
  );
  return {
    run: () => open(manifest),
    manifest,
    requests,
    selected,
    verifiedPhases,
    reads: () => reads,
  };
}

test("actual ledger resume passes public Provider/model selection and independently verifies exact seed/resume versions", async () => {
  const f = await ledgerResumeFixture();
  const result = await f.run();
  const { manifest, requests, selected } = f;
  assert.deepEqual(requests, [
    {
      channel: "zcode-task",
      method: "resumeTask",
      args: [
        {
          workspacePath: manifest.workspacePath,
          taskId: manifest.sessionId,
          model: "E2E_FIXTURE_PROVIDER/E2E_PRIMARY",
        },
      ],
    },
  ]);
  assert.deepEqual(selected, [manifest.sessionId]);
  assert.equal(result.requestsBefore, 11);
  assert.equal(f.reads(), 2);
  assert.deepEqual(f.verifiedPhases, ["seed", "resume"]);
  assert.equal(result.status.revision, manifest.resumeExpected.revision);
  assert.equal(result.status.historyVersion, manifest.resumeExpected.historyVersion);
});

test("actual ledger resume rejects canonical seed revision/hash as an observed resumed input version", async () => {
  const f = await ledgerResumeFixture({ statusPhase: "seed" });
  await assert.rejects(f.run(), { name: "AssertionError" });
  assert.deepEqual(f.verifiedPhases, ["seed", "resume"]);
});

test("actual ledger resume rejects a mutated physical observation ledger after its one reconciliation", async () => {
  const f = await ledgerResumeFixture({ changeFacts: true });
  await assert.rejects(f.run(), { name: "AssertionError" });
  assert.equal(f.reads(), 1);
});

test("actual single mobile admission performs onboarding preflight before returning the shared Page", async () => {
  const events = [];
  let failMainView = false;
  let detailsOpen = true;
  let popoverOpen = true;
  const mainViewError = new Error("Main has no actual mobile view");
  const page = {
    setDefaultTimeout() {},
    bringToFront: async () => events.push("foreground"),
    waitForFunction: async () => events.push("visible-barrier"),
    evaluate: async () => "visible",
    getByTestId: (id) => ({
      click: async () => events.push("task-click"),
      isVisible: async () => (id === "native-context-details" ? detailsOpen : popoverOpen),
      locator: () => ({
        click: async () => {
          detailsOpen = false;
          events.push("details-close");
        },
      }),
      waitFor: async (options) => {
        if (options?.state === "hidden") {
          assert.equal(id === "native-context-details" ? detailsOpen : popoverOpen, false);
          events.push(`${id}-hidden`);
        } else events.push("pane-or-entry");
      },
    }),
    locator: () => ({ waitFor: async () => events.push("chat-barrier") }),
    keyboard: {
      press: async (key) => {
        assert.equal(key, "Escape");
        popoverOpen = false;
        events.push("popover-close");
      },
    },
  };
  const context = {
    pages: () => [page],
    close: async () => events.push("close"),
  };
  let launches = 0;
  const ports = {
    join,
    mkdir,
    assertNativeContextTestPath: assertProjectPath,
    process: { env: { ZCODIUM_E2E_MOBILE_URL: "http://127.0.0.1:1234" } },
    obtainUnreadPairingUrl: async () => {
      events.push("direct-pairing");
      return "http://127.0.0.1:1234/mobile.html";
    },
    obtainNativeContextPairingUrl: async (origin, diagnostics) => {
      assert.equal(origin, "http://127.0.0.1:1234");
      await assertProjectPath(diagnostics);
      events.push("desktop-pairing-admission");
      return "http://127.0.0.1:1234/mobile.html";
    },
    chromium: {
      launchPersistentContext: async () => {
        launches++;
        events.push("browser-launch");
        return context;
      },
    },
    openMobilePairingPage: async () => events.push("paired"),
    useNativeTabVisibility: async () => events.push("native-visibility"),
    prepareNativeContextMobileOnboarding: async (selected) => {
      assert.equal(selected, page);
      events.push("onboarding");
      return { cancelled: true, handledAfter: true, handledAfterReload: true, reloaded: true };
    },
    recordNativeContextMobileEvidence: async () => events.push("evidence"),
    appendFile: async () => {},
    // 原因：openTask 新增同文件关闭依赖；装配实际回调，不能漏接依赖或用空实现绕过关闭屏障。
    closeNativeContextMobileDetails: await loadComponentCallback(
      root + "mobile.ts",
      "closeNativeContextMobileDetails",
      {},
    ),
    showMobileTaskHome: async () => events.push("task-home"),
    TID_TASK_ITEM: "task-item",
    TID_V4_SESSION_PANE: "session-pane",
    testId: (prefix, id) => `${prefix}:${id}`,
    DEFAULT_WORKSPACE: "fixture-workspace",
    waitMobileTaskView: async (address) => {
      assert.deepEqual(address, { taskId: "fixture-task", workspacePath: "fixture-workspace" });
      events.push("actual-main-view");
      if (failMainView) throw mainViewError;
    },
  };
  const create = await loadComponentCallback(
    root + "mobile.ts",
    "createNativeContextMobileBrowser",
    ports,
  );
  const evidence = await assertProjectPath(
    join(process.env.PROJECT_TEST_SANDBOX_ROOT, "mobile-helper-evidence"),
  );
  const result = await create(evidence);
  assert.equal(launches, 1);
  assert.equal(result.page, page);
  assert.equal(events.includes("direct-pairing"), false);
  assert.ok(events.indexOf("desktop-pairing-admission") < events.indexOf("browser-launch"));
  assert.ok(
    events.includes("onboarding"),
    "real admission must complete UI onboarding before its caller opens a task",
  );
  assert.ok(events.indexOf("foreground") < events.indexOf("onboarding"));
  assert.equal(events.includes("close"), false);
  await result.openTask("fixture-task");
  assert.ok(events.indexOf("native-context-details-hidden") < events.indexOf("task-home"));
  assert.ok(events.indexOf("native-context-popover-hidden") < events.indexOf("task-home"));
  assert.ok(events.indexOf("chat-barrier") < events.indexOf("actual-main-view"));
  failMainView = true;
  await assert.rejects(result.openTask("fixture-task"), (error) => error === mainViewError);
  assert.equal(events.filter((event) => event === "actual-main-view").length, 2);
});

async function onboardingFixture({
  handledInitial = false,
  writeSucceeds = true,
  regressOnReload = false,
  reappear = false,
} = {}) {
  const events = [];
  let handled = handledInitial;
  let open = !handled;
  let clicked = false;
  let pollsAfterClick = 0;
  const read = await loadComponentCallback(
    root + "mobile-onboarding.ts",
    "readNativeContextFirstRunHandled",
    {
      ServiceChannels: { SettingsSync: "settings-sync" },
      callHandoffHost: async (channel, method) => {
        assert.equal(channel, "settings-sync");
        assert.equal(
          method,
          "getFirstRunPromptState",
          "test helper must never write the handled flag through its port",
        );
        if (clicked && writeSucceeds && ++pollsAfterClick >= 2) handled = true;
        events.push(["owner-read", handled]);
        return { handled };
      },
    },
  );
  const cancel = {
    isVisible: async () => open,
    waitFor: async (options) => {
      if (options?.state === "hidden") assert.equal(open, false);
      else assert.equal(open, true);
    },
    click: async () => {
      assert.equal(open, true);
      events.push(["ui-cancel"]);
      clicked = true;
      open = false;
    },
  };
  const page = {
    getByTestId: (id) => {
      assert.equal(id, "onboarding-wizard-cancel");
      return cancel;
    },
    locator: () => ({
      getAttribute: async () => "session",
      waitFor: async () => events.push(["shared-root"]),
    }),
    reload: async () => {
      events.push(["same-page-reload"]);
      if (regressOnReload) handled = false;
      open = reappear;
    },
    bringToFront: async () => events.push(["foreground"]),
    waitForFunction: async () => events.push(["visible-document"]),
  };
  const prepare = await loadComponentCallback(
    root + "mobile-onboarding.ts",
    "prepareNativeContextMobileOnboarding",
    {
      expect: match,
      readNativeContextFirstRunHandled: read,
      browser: {
        waitUntil: async (predicate) => {
          for (let i = 0; i < 4; i++) if (await predicate()) return;
          throw new Error("first-run owner did not settle");
        },
      },
    },
  );
  return { events, run: () => prepare(page) };
}

test("actual mobile preflight clicks Cancel, waits for Host persistence, then reloads the same Page", async () => {
  const f = await onboardingFixture();
  assert.deepEqual(await f.run(), {
    handledBefore: false,
    cancelled: true,
    handledAfter: true,
    handledAfterReload: true,
    reloaded: true,
  });
  assert.equal(f.events.filter(([event]) => event === "ui-cancel").length, 1);
  const reload = f.events.findIndex(([event]) => event === "same-page-reload");
  assert.ok(f.events.findIndex(([event, value]) => event === "owner-read" && value) < reload);
  assert.ok(f.events.slice(reload + 1).some(([event, value]) => event === "owner-read" && value));
});

test("actual mobile preflight reloads an already handled prompt without a state write or second Cancel", async () => {
  const f = await onboardingFixture({ handledInitial: true });
  const result = await f.run();
  assert.equal(result.cancelled, false);
  assert.equal(result.handledAfterReload, true);
  assert.equal(f.events.filter(([event]) => event === "ui-cancel").length, 0);
  assert.equal(f.events.filter(([event]) => event === "same-page-reload").length, 1);
});

test("actual mobile preflight refuses to claim reload success when UI persistence fails", async () => {
  const f = await onboardingFixture({ writeSucceeds: false });
  await assert.rejects(f.run(), /owner did not settle/);
  assert.equal(
    f.events.some(([event]) => event === "same-page-reload"),
    false,
  );
});

test("actual mobile preflight rejects an overlay that reappears after reload", async () => {
  const f = await onboardingFixture({ handledInitial: true, reappear: true });
  await assert.rejects(f.run(), { name: "AssertionError" });
});
