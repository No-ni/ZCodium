import assert from "node:assert/strict";
import test from "node:test";
import { ConversationTopicPublisher } from "../../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-topic-publisher.ts";
import { SessionEventType } from "../../../apps/zcode-cli/packages/contracts/src/index.ts";
import {
  PROTOCOL_V4_LIMITS,
  conversationTopicFrameSchema,
  v4ConversationRowsRangeResultSchema,
} from "../../../packages/shared/src/zcode-protocol-v4/index.ts";
import { build } from "esbuild";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { setImmediate as settled } from "node:timers/promises";
import { assertProjectPath, projectRoot } from "../project-test-sandbox.mjs";

const sandbox = await assertProjectPath(process.env.PROJECT_TEST_SANDBOX_ROOT ?? "");
const artifact = await assertProjectPath(join(sandbox, "history-publisher-ui.mjs"));
const bundle = await build({
  stdin: {
    contents:
      'export {ConversationProjectionStore} from "./packages/ui/src/v4/conversationProjectionStore.ts"; export {buildConversationTurnRenderUnits} from "./packages/ui/src/v4/conversationTurnRenderUnits.ts";',
    resolveDir: projectRoot,
    loader: "ts",
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  packages: "external",
  alias: { "@": join(projectRoot, "packages/ui/src") },
});
await writeFile(artifact, bundle.outputFiles[0].text);
const { ConversationProjectionStore, buildConversationTurnRenderUnits } = await import(
  pathToFileURL(artifact).href
);

async function fixture(
  profile,
  hiddenReasoning = false,
  count = PROTOCOL_V4_LIMITS.snapshotTailWindowRows + 4,
) {
  const publisher = new ConversationTopicPublisher("publisher-audit", "publisher-epoch", {
    now: () => 1700000001000,
  });
  let seq = 0;
  const ingest = (type, payload, turnId = "fixture-turn") =>
    publisher.ingest({
      id: `event-${++seq}`,
      sessionId: "publisher-audit",
      turnId,
      type,
      payload,
      timestamp: new Date(1700000000000 + seq),
      sequenceNumber: seq,
      traceId: "fixture-trace",
    });
  const stream = (kind, extra = {}) =>
    ingest(SessionEventType.ModelStreaming, { kind, delta: "", done: false, ...extra });
  ingest(SessionEventType.TurnStarted, {
    turnNumber: 1,
    input: "fixture",
    messageId: "fixture-message",
  });
  if (hiddenReasoning) {
    stream("reasoning_start", {
      assistantMessageId: "fixture-reasoning",
      partId: "fixture-reasoning-part",
    });
    stream("reasoning_delta", { delta: "old" });
    for (let i = 0; i < count; i++)
      stream("tool_input_start", { toolCallId: `fixture-tool-${i}`, toolName: "Bash" });
  } else {
    for (let i = 0; i < count; i++) {
      stream("reasoning_start", {
        assistantMessageId: `fixture-message-${i}`,
        partId: `fixture-part-${i}`,
      });
      stream("reasoning_delta", { delta: "fixture" });
      stream("reasoning_end");
    }
  }
  let subscription;
  let store;
  const requests = [];
  const transport = {
    subscribe: async (params) => {
      subscription = publisher.subscribeReserved({
        connectionId: "fixture-connection",
        deliveryProfile: profile,
        base: params.base,
      });
      return { ack: subscription.ack };
    },
    activate: () => {
      assert.ok(subscription.reservation.commit());
      store.handleFrame(conversationTopicFrameSchema.parse(subscription.frame), {
        deliveryKind: "initial",
      });
    },
    unsubscribe: async (id) => publisher.unsubscribe(id),
    onFrame: () => () => {},
    onAssemblyFault: () => () => {},
    onRuntimeRestart: () => () => {},
    rowsRange: async (params) => {
      const request = {
        params,
        captured: v4ConversationRowsRangeResultSchema.parse(
          publisher.getRowsRange(params, profile),
        ),
        resolved: false,
        resolve: null,
      };
      requests.push(request);
      return await new Promise((resolve) => {
        request.resolve = resolve;
      });
    },
  };
  store = new ConversationProjectionStore(publisher.topic, transport);
  await store.connect();
  assert.equal(
    store.getState().snapshot.rows.window.length,
    PROTOCOL_V4_LIMITS.snapshotTailWindowRows,
  );
  assert.equal(
    store.getState().snapshot.rows.window.some((row) => row.kind === "turnHeader"),
    false,
  );
  const hiddenReason = publisher.getSnapshot().rows.window.find((row) => row.kind === "reasoning");
  if (hiddenReasoning)
    assert.ok(hiddenReason.rowId < store.getState().snapshot.rows.window[0].rowId);
  const flush = () => {
    const reservation = publisher.reserveFlush(subscription.ack.subscriptionId);
    assert.ok(reservation);
    const frame = conversationTopicFrameSchema.parse(reservation.frame);
    assert.ok(reservation.commit());
    store.handleFrame(frame, { deliveryKind: "online" });
    return frame;
  };
  return {
    store,
    publisher,
    stream,
    hiddenReason,
    ingest,
    flush,
    requests,
    resolve(fresh = false, index = requests.length - 1) {
      const request = requests[index];
      assert.ok(request && !request.resolved);
      request.resolved = true;
      request.resolve(
        fresh
          ? v4ConversationRowsRangeResultSchema.parse(
              publisher.getRowsRange(request.params, profile),
            )
          : request.captured,
      );
    },
    async waitForRequests(count) {
      for (let i = 0; i < 100 && requests.length < count; i++) await settled();
      assert.equal(requests.length, count);
    },
    async allFresh() {
      const loading = store.loadAllOlder();
      let completed = false;
      void loading.then(() => {
        completed = true;
      });
      for (let i = 0; i < 100 && !completed; i++) {
        await settled();
        for (const [index, request] of requests.entries())
          if (!request.resolved) this.resolve(true, index);
      }
      assert.equal(completed, true);
      return loading;
    },
    snapshotReplace() {
      const reservation = publisher.resyncReserved(subscription.ack.subscriptionId, {
        base: null,
        forceSnapshot: true,
      }).reservation;
      assert.ok(reservation.commit());
      const frame = conversationTopicFrameSchema.parse(reservation.frame);
      store.handleFrame(frame, { deliveryKind: "recovery" });
      return frame;
    },
    complete() {
      ingest(SessionEventType.TurnComplete, {
        response: "",
        tokenCount: 0,
        toolCallCount: 0,
        duration: 1000,
        resultType: "success",
      });
      const frame = flush();
      const delta = frame.payload.deltas.find(
        (delta) => delta.op === "row.upserted" && delta.row.kind === "turnHeader",
      );
      assert.equal(delta.row.state, "completedSuccess");
      assert.ok(delta.row.rowId < store.getState().snapshot.rows.window[0].rowId);
      return frame;
    },
    units() {
      const snapshot = store.getState().snapshot;
      return buildConversationTurnRenderUnits(snapshot.rows.window, {
        sessionPhase: snapshot.control.phase,
      });
    },
    async retryFresh() {
      const loading = store.loadOlder();
      this.resolve(true);
      await loading;
    },
  };
}

for (const profile of ["continuous", "replayable"]) {
  test(`${profile}: publisher旧查询晚于真实TurnComplete不恢复运行header`, async () => {
    const f = await fixture(profile);
    try {
      const loading = f.store.loadOlder();
      f.complete();
      f.resolve();
      await loading;
      assert.equal(f.units().at(-1).isRunning, false);
    } finally {
      await f.store.close();
    }
  });
  test(`${profile}: publisher完成后取到当前历史页可正常加载`, async () => {
    const f = await fixture(profile);
    try {
      f.complete();
      const loading = f.store.loadOlder();
      f.resolve();
      await loading;
      assert.equal(f.units().at(-1).isRunning, false);
      assert.ok(f.store.getState().snapshot.rows.window.some((row) => row.kind === "turnHeader"));
    } finally {
      await f.store.close();
    }
  });
  test(`${profile}: 未加载reasoning row.delta使旧文本查询失效`, async () => {
    const f = await fixture(profile, true);
    try {
      const loading = f.store.loadOlder();
      f.stream("reasoning_delta", { delta: "-current" });
      const frame = f.flush();
      assert.ok(
        frame.payload.deltas.some(
          (delta) => delta.op === "row.delta" && delta.rowId === f.hiddenReason.rowId,
        ),
      );
      f.resolve();
      await loading;
      const old = f.store
        .getState()
        .snapshot.rows.window.find((row) => row.rowId === f.hiddenReason.rowId);
      assert.ok(old === undefined || old.text === "old-current");
      if (!old) await f.retryFresh();
      assert.equal(
        f.store.getState().snapshot.rows.window.find((row) => row.rowId === f.hiddenReason.rowId)
          .text,
        "old-current",
      );
    } finally {
      await f.store.close();
    }
  });
  test(`${profile}: 未加载reasoning row.upserted不恢复streaming旧态`, async () => {
    const f = await fixture(profile, true);
    try {
      const loading = f.store.loadOlder();
      f.stream("reasoning_end");
      const frame = f.flush();
      assert.ok(
        frame.payload.deltas.some(
          (delta) => delta.op === "row.upserted" && delta.row.rowId === f.hiddenReason.rowId,
        ),
      );
      f.resolve();
      await loading;
      const old = f.store
        .getState()
        .snapshot.rows.window.find((row) => row.rowId === f.hiddenReason.rowId);
      assert.ok(old === undefined || old.state === "complete");
      if (!old) await f.retryFresh();
      assert.equal(
        f.store.getState().snapshot.rows.window.find((row) => row.rowId === f.hiddenReason.rowId)
          .state,
        "complete",
      );
    } finally {
      await f.store.close();
    }
  });
  test(`${profile}: same-epoch snapshot同cursor替换撤销在途旧查询`, async () => {
    const f = await fixture(profile);
    try {
      const loading = f.store.loadOlder();
      const before = f.store.getState().snapshot;
      const frame = f.snapshotReplace();
      assert.equal(frame.payload.snapshot.seq, before.seq);
      assert.equal(frame.payload.snapshot.rows.window[0].rowId, before.rows.window[0].rowId);
      f.resolve();
      await loading;
      assert.equal(
        f.store.getState().snapshot.rows.window.length,
        PROTOCOL_V4_LIMITS.snapshotTailWindowRows,
      );
    } finally {
      await f.store.close();
    }
  });
  test(`${profile}: 历史补拉单飞直到旧flight结算，新flight保留自己的loading`, async () => {
    const f = await fixture(profile);
    try {
      const loading = f.store.loadOlder();
      assert.equal(f.store.loadOlder(), loading);
      assert.equal((await f.store.loadAllOlder()).status, "stale");
      assert.equal(f.requests.length, 1);
      f.snapshotReplace();
      f.resolve();
      await loading;
      assert.equal(f.store.getState().loadingOlder, false);
      const next = f.store.loadOlder();
      assert.equal(f.requests.length, 2);
      await settled();
      assert.equal(f.store.getState().loadingOlder, true);
      f.resolve(true);
      await next;
      assert.equal(f.store.getState().loadingOlder, false);
      assert.ok(f.store.getState().snapshot.rows.window.some((row) => row.kind === "turnHeader"));
    } finally {
      await f.store.close();
    }
  });
  test(`${profile}: 无关tail append推进seq仍允许历史加载`, async () => {
    const f = await fixture(profile);
    try {
      const loading = f.store.loadOlder();
      f.stream("text_start", { assistantMessageId: "tail-append" });
      f.stream("text_delta", { delta: "current tail" });
      f.flush();
      f.resolve();
      await loading;
      assert.ok(f.store.getState().snapshot.rows.window.some((row) => row.kind === "turnHeader"));
      assert.equal(f.store.getState().snapshot.rows.window.at(-1).text, "current tail");
    } finally {
      await f.store.close();
    }
  });
  test(`${profile}: query atSeq已覆盖旧row更新的帧末水位则正常加载`, async () => {
    const f = await fixture(profile, true);
    try {
      const loading = f.store.loadOlder();
      f.stream("reasoning_delta", { delta: "-current" });
      f.flush();
      f.resolve(true);
      await loading;
      assert.equal(
        f.store.getState().snapshot.rows.window.find((row) => row.rowId === f.hiddenReason.rowId)
          .text,
        "old-current",
      );
    } finally {
      await f.store.close();
    }
  });
  test(`${profile}: 批帧中途的header页无法证明覆盖帧末，保守拒绝后重查恢复`, async () => {
    const f = await fixture(profile);
    try {
      f.ingest(SessionEventType.TurnComplete, {
        response: "",
        tokenCount: 0,
        toolCallCount: 0,
        duration: 1000,
        resultType: "success",
      });
      const loading = f.store.loadOlder();
      const page = f.requests[0].captured;
      const header = page.rows.find((row) => row.kind === "turnHeader");
      assert.equal(header.state, "completedSuccess");
      f.ingest(
        SessionEventType.TurnStarted,
        { turnNumber: 2, input: "next fixture", messageId: "next-fixture-message" },
        "next-fixture-turn",
      );
      const frame = f.flush();
      assert.ok(frame.fromSeq < page.atSeq && page.atSeq < frame.toSeq);
      assert.ok(
        frame.payload.deltas.some(
          (delta) =>
            delta.op === "row.upserted" &&
            delta.row.kind === "turnHeader" &&
            delta.row.state === "completedSuccess",
        ),
      );
      assert.ok(
        frame.payload.deltas.some(
          (delta) =>
            delta.op === "row.appended" &&
            delta.row.kind === "turnHeader" &&
            delta.row.turnId !== header.turnId,
        ),
      );
      f.resolve();
      await loading;
      assert.equal(
        f.store.getState().snapshot.rows.window.some((row) => row.rowId === header.rowId),
        false,
      );
      await f.retryFresh();
      assert.equal(
        f.store.getState().snapshot.rows.window.find((row) => row.rowId === header.rowId)?.state,
        "completedSuccess",
      );
    } finally {
      await f.store.close();
    }
  });
  test(`${profile}: loadAllOlder同样拒绝完成前取得的旧header页`, async () => {
    const f = await fixture(profile);
    try {
      const loading = f.store.loadAllOlder();
      f.complete();
      f.resolve();
      const result = await loading;
      assert.equal(result.status, "stale");
      assert.equal(f.units().at(-1).isRunning, false);
      await f.allFresh();
      assert.equal(
        f.store.getState().snapshot.rows.window.find((row) => row.kind === "turnHeader").state,
        "completedSuccess",
      );
    } finally {
      await f.store.close();
    }
  });
  test(`${profile}: loadAllOlder读取完成后的当前事实正常补齐`, async () => {
    const f = await fixture(profile);
    try {
      f.complete();
      await f.allFresh();
      assert.equal(f.units().at(-1).isRunning, false);
      assert.equal(
        f.store.getState().snapshot.rows.window.length,
        f.publisher.getSnapshot().rows.window.length,
      );
    } finally {
      await f.store.close();
    }
  });
  test(`${profile}: loadAllOlder同epoch和cursor的snapshot撤销整批查询`, async () => {
    const f = await fixture(profile);
    try {
      const loading = f.store.loadAllOlder();
      f.snapshotReplace();
      f.resolve();
      assert.equal((await loading).status, "stale");
      assert.equal(
        f.store.getState().snapshot.rows.window.length,
        PROTOCOL_V4_LIMITS.snapshotTailWindowRows,
      );
      await f.allFresh();
      assert.equal(
        f.store.getState().snapshot.rows.window.length,
        f.publisher.getSnapshot().rows.window.length,
      );
    } finally {
      await f.store.close();
    }
  });
  test(`${profile}: 多页首批返回后旧行更新在最终提交前撤销整批`, async () => {
    const f = await fixture(profile, true, 400);
    try {
      const loading = f.store.loadAllOlder();
      const target = f.requests[0].captured.rows.find((row) => row.kind === "toolCall");
      assert.ok(target);
      f.resolve();
      await f.waitForRequests(2);
      f.stream("tool_call", {
        toolCallId: target.toolCallId,
        toolName: "Bash",
        input: { command: "fixture-current" },
      });
      assert.ok(
        f
          .flush()
          .payload.deltas.some(
            (delta) => delta.op === "row.upserted" && delta.row.rowId === target.rowId,
          ),
      );
      f.resolve(true);
      assert.equal((await loading).status, "stale");
      assert.equal(
        f.store.getState().snapshot.rows.window.length,
        PROTOCOL_V4_LIMITS.snapshotTailWindowRows,
      );
      await f.allFresh();
      assert.deepEqual(
        f.store.getState().snapshot.rows.window.find((row) => row.rowId === target.rowId).input,
        { command: "fixture-current" },
      );
    } finally {
      await f.store.close();
    }
  });
  test(`${profile}: 多页期间无关tail append与delta不阻断整批补齐`, async () => {
    const f = await fixture(profile, true, 400);
    try {
      const loading = f.store.loadAllOlder();
      f.resolve();
      await f.waitForRequests(2);
      f.stream("text_start", { assistantMessageId: "multi-tail" });
      f.stream("text_delta", { delta: "unrelated-tail" });
      f.flush();
      f.resolve();
      await loading;
      const rows = f.store.getState().snapshot.rows.window;
      assert.equal(rows.length, f.publisher.getSnapshot().rows.window.length);
      assert.equal(rows.at(-1).text, "unrelated-tail");
    } finally {
      await f.store.close();
    }
  });
  test(`${profile}: 范围内但未命中本页的旧行变化不阻断该页`, async () => {
    const f = await fixture(profile, true, 400);
    try {
      const loading = f.store.loadOlder();
      assert.ok(f.requests[0].captured.rows.every((row) => row.rowId !== f.hiddenReason.rowId));
      f.stream("reasoning_delta", { delta: "-current" });
      f.flush();
      f.resolve();
      await loading;
      assert.equal(
        f.store.getState().snapshot.rows.window.length,
        PROTOCOL_V4_LIMITS.snapshotTailWindowRows * 2,
      );
      assert.equal(
        f.store.getState().snapshot.rows.window.some((row) => row.rowId === f.hiddenReason.rowId),
        false,
      );
    } finally {
      await f.store.close();
    }
  });
}
