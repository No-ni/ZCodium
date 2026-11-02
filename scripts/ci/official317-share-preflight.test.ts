import assert from "node:assert/strict";
import test from "node:test";
import { scheduleConversationSharePreflightRequest } from "../../packages/ui/src/conversation-share-interaction/conversationSharePreflightRequest.js";
import { createConversationSharePreflightResponseHandlers } from "../../packages/ui/src/conversation-share-interaction/conversationSharePreflightResponse.js";
import { conversationShareTurnFingerprints } from "../../packages/ui/src/v4/conversationSharePreflightCache.js";
import { logger } from "../../packages/ui/src/logger.js";
import type { ConversationRow } from "../../packages/shared/src/zcode-protocol-v4/index.js";
import type { ConversationSharePreflightResult } from "../../packages/services/src/conversation-share/index.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("Cleanup invalidates an already sent same-scope preflight and a cancelled debounce sends no RPC", async () => {
  const old = deferred<number>(),
    started = deferred<void>();
  const resolved: number[] = [],
    errors: unknown[] = [];
  const close = scheduleConversationSharePreflightRequest({
    request: () => {
      started.resolve();
      return old.promise;
    },
    onResolved: (n) => resolved.push(n),
    onRejected: (e) => errors.push(e),
    onError: (e) => errors.push(e),
  });
  await started.promise;
  close();
  const current = deferred<void>();
  const cancel = scheduleConversationSharePreflightRequest({
    request: async () => 2,
    onResolved: (n) => {
      resolved.push(n);
      current.resolve();
    },
    onRejected: (e) => errors.push(e),
    onError: (e) => errors.push(e),
  });
  await current.promise;
  old.resolve(1);
  await flush();
  cancel();
  assert.deepEqual(resolved, [2]);
  assert.deepEqual(errors, []);
  let sent = 0;
  scheduleConversationSharePreflightRequest({
    request: async () => ++sent,
    onResolved: () => {},
    onRejected: () => {},
    onError: () => {},
  })();
  await flush();
  assert.equal(sent, 0);
});

test("A cancelled in-flight rejection cannot publish into a reopened preflight", async () => {
  const rpc = deferred<number>(),
    started = deferred<void>();
  let applied = 0;
  const close = scheduleConversationSharePreflightRequest({
    request: () => {
      started.resolve();
      return rpc.promise;
    },
    onResolved: () => applied++,
    onRejected: () => applied++,
    onError: () => applied++,
  });
  await started.promise;
  close();
  rpc.reject(new Error("synthetic stale response"));
  await flush();
  assert.equal(applied, 0);
});

function fixture() {
  let active = true,
    updates = 0;
  const rows: ConversationRow[] = [
    {
      kind: "assistantText",
      rowId: 1,
      turnId: "turn",
      productTurnId: "turn",
      createdAt: 1000,
      createdAtSeq: 1,
      text: "[Synthetic report](docs/report.pdf)",
      state: "complete",
    },
  ];
  const cache = { current: new Map() };
  const meta = {
    current: {
      revision: 0,
      logEpoch: "old",
      capabilitiesFingerprint: "old",
      supportedArtifactTypes: [],
    },
  };
  const scope = {
    workspaceKey: "endpoint-identity",
    remoteSessionId: "remote",
    sessionId: "session",
    revision: 1,
    logEpoch: "new",
    capabilitiesFingerprint: "new",
  };
  const handlers = createConversationSharePreflightResponseHandlers({
    sessionId: "session",
    workspacePath: "/synthetic/workspace",
    workspaceIdentity: scope.workspaceKey,
    remoteSessionId: "remote",
    fileReferenceRootPath: "/synthetic/workspace/session-cwd",
    missingProductTurnIds: ["turn"],
    requestRows: rows,
    selectedShareTurnFingerprints: new Map([["turn", "selected"]]),
    sharePreflightCacheRef: cache,
    sharePreflightMetaRef: meta,
    sharePreflightCacheKey: (id) => id,
    isCurrent: () => active,
    onUpdated: () => updates++,
  });
  const result: ConversationSharePreflightResult = {
    revision: 1,
    logEpoch: "new",
    capabilitiesFingerprint: "new",
    supportedArtifactTypes: [],
    blockingIssues: [],
    skippableWarnings: [],
    deferredIssues: [],
    turnResults: [
      { productTurnId: "turn", blockingIssues: [], skippableWarnings: [], deferredIssues: [] },
    ],
  };
  return {
    rows,
    cache,
    meta,
    handlers,
    result,
    scope,
    stop: () => {
      active = false;
    },
    updates: () => updates,
  };
}

test("Preflight fingerprints use session cwd for references and preserve workspace identity for scope", () => {
  const f = fixture();
  f.handlers.onResolved(f.result);
  const expected = conversationShareTurnFingerprints(
    f.rows,
    ["turn"],
    "/synthetic/workspace/session-cwd",
    f.scope,
  ).get("turn");
  const wrongRoot = conversationShareTurnFingerprints(
    f.rows,
    ["turn"],
    f.scope.workspaceKey,
    f.scope,
  ).get("turn");
  assert.notEqual(expected, wrongRoot);
  assert.equal(f.cache.current.get("turn")?.turnFingerprint, expected);
  assert.equal(f.meta.current.revision, 1);
  assert.equal(f.updates(), 1);
  f.stop();
  f.handlers.onResolved({ ...f.result, revision: 2 });
  assert.equal(f.meta.current.revision, 1);
  assert.equal(f.updates(), 1);
});

test("Malformed success keeps old metadata; current failures publish bounded diagnostics only", () => {
  const f = fixture();
  const prior = f.meta.current;
  assert.throws(() =>
    f.handlers.onResolved({
      ...f.result,
      turnResults: [null],
    } as unknown as ConversationSharePreflightResult),
  );
  assert.equal(f.meta.current, prior);
  assert.equal(f.cache.current.size, 0);
  const logs: unknown[][] = [];
  const warn = logger.warn,
    error = logger.error;
  logger.warn = (...args) => {
    logs.push(args);
  };
  logger.error = (...args) => {
    logs.push(args);
  };
  try {
    f.handlers.onError(new Error("secret://synthetic-error"));
    assert.equal(f.cache.current.get("turn")?.turnFingerprint, "selected");
    assert.equal(f.meta.current, prior);
    f.handlers.onRejected({
      name: "secret://name",
      kind: "/secret/kind",
      reasonCode: "secret://reason",
    });
    assert.equal(JSON.stringify(logs).includes("secret"), false);
    const count = logs.length;
    f.stop();
    f.handlers.onRejected({ name: "stale", kind: "stale" });
    assert.equal(logs.length, count);
  } finally {
    logger.warn = warn;
    logger.error = error;
  }
});
