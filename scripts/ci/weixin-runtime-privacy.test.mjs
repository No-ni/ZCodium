import assert from "node:assert/strict";
import { test } from "node:test";
import { createWeixinChannelRuntime } from "../../packages/services/src/bots/weixinChannelRuntime.ts";
import { assertProjectPath } from "./project-test-sandbox.mjs";

await assertProjectPath(process.env.PROJECT_TEST_SANDBOX_ROOT);
const sensitive = "synthetic-private-provider-detail";
const botId = "synthetic-private-bot-id";
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(overrides = {}) {
  const statuses = [];
  const logs = [];
  const error = deferred();
  const report = deferred();
  let releases = 0;
  const deps = {
    credentialService: { load: async () => "synthetic-test-token" },
    ensureBotStorageMigrated: async () => {},
    readConfig: async () => ({ version: 3, bots: [] }),
    readWeixinGetUpdatesBuf: async () => undefined,
    writeWeixinGetUpdatesBuf: async () => {},
    processProviderCallback: async () => ({ ok: true }),
    acquirePollingLock: async () => ({
      release: async () => {
        releases += 1;
      },
    }),
    getUpdates: async () => {
      throw new Error(sensitive);
    },
    logger: Object.fromEntries(
      ["debug", "info", "warn"].map((level) => [
        level,
        (...args) => {
          logs.push([level, ...args]);
          report.resolve();
        },
      ]),
    ),
    statusSink: {
      getRuntimeStatus: () => statuses.at(-1),
      setRuntimeStatus: (status) => {
        statuses.push(status);
        if (status.status === "error") error.resolve();
      },
    },
    ...overrides,
  };
  const runtime = createWeixinChannelRuntime(deps);
  const config = {
    version: 3,
    bots: [
      {
        id: botId,
        provider: "weixin",
        enabled: true,
        credentialRef: "fixture",
        allowedWorkspaces: [],
      },
    ],
  };
  return { runtime, config, statuses, logs, error, report, releases: () => releases };
}

test(
  "polling/provider and release failures expose stable status and release before disposal",
  { timeout: 10_000 },
  async () => {
    const releaseDone = deferred();
    let releases = 0;
    const f = fixture({
      acquirePollingLock: async () => ({
        release: async () => {
          releases += 1;
          await releaseDone.promise;
          throw new Error(sensitive);
        },
      }),
    });
    try {
      await f.runtime.refresh(f.config);
      await f.error.promise;
      let disposed = false;
      const closing = f.runtime.dispose().then(() => {
        disposed = true;
      });
      for (let i = 0; i < 12; i++) await Promise.resolve();
      assert.equal(releases, 1);
      assert.equal(disposed, false);
      releaseDone.resolve();
      await closing;
      assert.equal(
        f.statuses.find((status) => status.status === "error").messageId,
        "bots.runtime.weixinPollingFailedRetrying",
      );
      assert.ok(
        f.logs.some((entry) => String(entry).includes("release Weixin polling lock failed")),
      );
      assert.equal(JSON.stringify(f.logs).includes(botId), false);
      assert.equal(JSON.stringify(f.logs).includes(sensitive), false);
      assert.equal(
        f.statuses.some((status) => status.message.includes(sensitive)),
        false,
      );
    } finally {
      releaseDone.resolve();
      await f.runtime.dispose();
    }
  },
);

test(
  "lock acquisition failure preserves retry state without exposing raw IO errors",
  { timeout: 10_000 },
  async () => {
    const f = fixture({
      acquirePollingLock: async () => {
        throw new Error(sensitive);
      },
    });
    try {
      await f.runtime.refresh(f.config);
      await f.error.promise;
      assert.equal(f.statuses.at(-1).messageId, "bots.runtime.weixinPollingLockFailedRetrying");
      assert.equal(f.statuses.at(-1).message.includes(sensitive), false);
      assert.equal(f.releases(), 0);
    } finally {
      await f.runtime.dispose();
    }
  },
);

test(
  "raw diagnostics and bot identity do not enter numeric polling logs",
  { timeout: 10_000 },
  async () => {
    let reads = 0;
    const f = fixture({
      getUpdates: async ({ signal }) => {
        reads += 1;
        if (reads > 1 && !signal.aborted)
          await new Promise((done) => signal.addEventListener("abort", done, { once: true }));
        return { messages: [], rawMessageCount: 3, rawMessageDiagnostics: [sensitive] };
      },
    });
    try {
      await f.runtime.refresh(f.config);
      await f.report.promise;
      assert.equal(JSON.stringify(f.logs).includes(botId), false);
      assert.equal(JSON.stringify(f.logs).includes(sensitive), false);
      assert.ok(f.logs.some((entry) => String(entry).includes("diagnostics count=1")));
    } finally {
      await f.runtime.dispose();
    }
    assert.equal(f.releases(), 1);
  },
);
