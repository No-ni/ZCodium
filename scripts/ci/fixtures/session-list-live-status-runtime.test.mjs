import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { Emitter } from "../../../packages/rpc/src/index.ts";
import {
  CONTROLLER_TASKS_INDEX_TOPIC,
  V4_WIRE_PROTOCOL_VERSION,
  sessionSummarySchema,
  sessionsIndexTopic,
  windowHostControllerTaskRowSchema,
} from "../../../packages/shared/src/zcode-protocol-v4/index.ts";
import { createWindowHostControllerRuntime } from "../../../packages/desktop/src/host/windowHostControllerService.ts";
import { buildWebRemoteControlSyncPayload } from "../../../packages/ui/src/lib/webRemoteControlSync.ts";

const BASE = 1_700_000_000_000;

function summary(patch = {}) {
  return Object.freeze(
    sessionSummarySchema.parse({
      sessionId: "session-fixture",
      workspaceId: "workspace-fixture",
      title: "fixture",
      phase: "completedSuccess",
      sessionEnded: true,
      hasBackgroundWork: false,
      createdAt: BASE,
      lastActivityAt: BASE + 20_000,
      ...patch,
    }),
  );
}

async function hostFixture(initial, { remote = false, persistedStatus = "completed" } = {}) {
  assert.ok(process.env.PROJECT_TEST_SANDBOX_ROOT, "Run only through the project sandbox entry");
  const workspacePath = join(process.env.PROJECT_TEST_SANDBOX_ROOT, "memory-workspace");
  const target = {
    workspacePath,
    ...(remote
      ? { workspaceIdentity: "fixture-remote", remoteSessionId: "fixture-attachment" }
      : {}),
  };
  const scope = { kind: remote ? "remote" : "local", ...target };
  const meta = Object.freeze({
    taskId: "session-fixture",
    traceId: "fixture",
    title: "fixture",
    mode: "build",
    provider: "glm",
    workspacePath,
    ...(remote ? { workspaceIdentity: target.workspaceIdentity } : {}),
    createdAt: BASE,
    updatedAt: BASE,
    status: persistedStatus,
  });
  const frames = new Emitter();
  const restarted = new Emitter();
  const controllerFrames = [];
  const errors = [];
  const topic = sessionsIndexTopic(target.workspaceIdentity ?? workspacePath);
  let sequence = 0;
  const send = (session, kind = "deltas") => {
    const fromSeq = sequence++;
    frames.fire({
      wireVersion: V4_WIRE_PROTOCOL_VERSION,
      kind: "complete",
      deliveryKind: kind === "snapshot" ? "initial" : "online",
      logicalFrameId: `frame-${sequence}`,
      logicalFrameOrdinal: sequence,
      topic,
      subscriptionId: "sessions-fixture",
      frame: {
        topic,
        subscriptionId: "sessions-fixture",
        fromSeq: kind === "snapshot" ? 0 : fromSeq,
        toSeq: sequence,
        sentAt: BASE + sequence,
        payload:
          kind === "snapshot"
            ? {
                kind,
                snapshot: {
                  protocolVersion: 1,
                  workspaceId: target.workspaceIdentity ?? workspacePath,
                  logEpoch: "sessions-epoch",
                  sessions: session ? [session] : [],
                },
              }
            : { kind, deltas: [{ op: "session.upserted", session }] },
      },
    });
  };
  const agentService = {
    onDynamicSessionsIndexFrame: () => frames.event,
    onAgentRuntimeRestarted: restarted.event,
    subscribeSessionsIndexV4: async (params) => {
      assert.equal(params.runtimePolicy, "existing-only");
      // 与真实 stdio 相同：首帧允许在 ACK 返回前到达，仍由 Host observer 消费。
      send(initial, "snapshot");
      return { ack: { subscriptionId: "sessions-fixture", logEpoch: "sessions-epoch", seq0: 0 } };
    },
    unsubscribeSessionsIndexV4: async () => {},
    resyncSessionsIndexV4: async () => assert.fail("Contiguous fixture must not resync"),
  };
  const taskService = {
    listTasks: async () => [meta],
    listPinnedTasks: async () => [],
    listArchivedTasks: async () => [],
  };
  let id = 0;
  const runtime = createWindowHostControllerRuntime({
    createId: () => `controller-${++id}`,
    readHostTaskList: async () => ({ items: [meta], total: 1, hasMore: false }),
    resolveSource: () => ({ scope, taskService, agentService, sourceAvailability: "online" }),
    onSourceError: (_scope, _operation, error) => errors.push(error),
  });
  const listener = runtime.service.onDynamicControllerFrame()((frame) =>
    controllerFrames.push(frame),
  );
  await runtime.service.subscribeControllerV4({
    topic: CONTROLLER_TASKS_INDEX_TOPIC,
    visibility: "foreground",
  });
  const query = { workspaceScopes: [target], kind: "active", sortBy: "updated" };
  const read = async (host = false) => {
    const result = await runtime.service.listTaskList({
      ...query,
      ...(host ? { workspaceScopes: "host" } : {}),
    });
    assert.deepEqual(errors, []);
    assert.equal(result.items.length, 1);
    const row = controllerFrames
      .filter((frame) => frame.payload.kind === "deltas")
      .flatMap((frame) => frame.payload.deltas)
      .filter((delta) => delta.op === "task.upserted")
      .at(-1)?.task;
    assert.ok(row, "Host must publish a real Controller task row");
    windowHostControllerTaskRowSchema.parse(row);
    const payload = buildWebRemoteControlSyncPayload([target], result.items);
    assert.equal(payload.tasks.length, 1);
    return { item: result.items[0], row, mobile: payload.tasks[0] };
  };
  await read();
  return {
    read,
    send,
    dispose() {
      listener.dispose();
      runtime.dispose();
      frames.dispose();
      restarted.dispose();
    },
  };
}

for (const patch of [
  { goalStatus: "active" },
  { goalStatus: "verifying" },
  { autoContinuePending: true },
]) {
  for (const remote of [false, true]) {
    test(`${remote ? "remote" : "local"} 成功轮续跑 ${JSON.stringify(patch)} 手机仍显示运行`, async () => {
      const f = await hostFixture(summary(patch), { remote });
      try {
        const { item, row, mobile } = await f.read();
        assert.equal(item.liveStatus, "running");
        assert.equal(row.liveStatus, "running");
        assert.equal(mobile.displayStatus, "running");
        assert.equal(item.activity.phase, "completedSuccess");
        assert.equal(item.status, "completed");
        assert.equal(row.meta.status, "completed");
      } finally {
        f.dispose();
      }
    });
  }
}

for (const [label, patch, expected] of [
  ["旧摘要无续跑字段", {}, "completed"],
  ["暂停Goal", { goalStatus: "paused" }, "completed"],
  ["未满足Goal", { goalStatus: "notSatisfied" }, "completed"],
  ["最终已验证Goal", { goalStatus: "verified" }, "completed"],
  ["held queue", { autoContinuePending: false }, "completed"],
  ["仅后台工作", { hasBackgroundWork: true }, "completed"],
  ["失败终态", { phase: "error", goalStatus: "active", autoContinuePending: true }, "error"],
  ["用户打断", { phase: "completedInterrupted", goalStatus: "active" }, "completed"],
]) {
  test(`${label} 保持原列表语义`, async () => {
    const f = await hostFixture(summary(patch));
    try {
      const { item, mobile } = await f.read();
      assert.equal(item.liveStatus, expected);
      assert.equal(mobile.displayStatus, expected);
      assert.equal(mobile.hasBackgroundWork, patch.hasBackgroundWork ?? false);
    } finally {
      f.dispose();
    }
  });
}

test("同phase清空自动队列/完成Goal后Controller delta与手机都收口", async () => {
  const f = await hostFixture(summary({ goalStatus: "active", autoContinuePending: true }));
  try {
    assert.equal((await f.read()).mobile.displayStatus, "running");
    f.send(summary({ goalStatus: "verifying", autoContinuePending: false }));
    assert.equal((await f.read()).mobile.displayStatus, "running");
    f.send(summary({ goalStatus: "verified", autoContinuePending: false }));
    const result = await f.read();
    assert.equal(result.row.liveStatus, "completed");
    assert.equal(result.mobile.displayStatus, "completed");
    assert.equal(result.item.activity.phase, "completedSuccess");
  } finally {
    f.dispose();
  }
});

test("成功轮续跑中的交互仍等待，手机沿既有映射显示运行", async () => {
  const f = await hostFixture(
    summary({
      goalStatus: "active",
      pendingInteractionSummary: { permissionCount: 1, userInputCount: 0 },
    }),
  );
  try {
    const { item, mobile } = await f.read();
    assert.equal(item.liveStatus, "waiting");
    assert.equal(mobile.displayStatus, "running");
  } finally {
    f.dispose();
  }
});

test("Host全局查询使用同一live状态，旧持久running不被当作实时", async () => {
  const live = await hostFixture(summary({ autoContinuePending: true }));
  const history = await hostFixture(null, { persistedStatus: "running" });
  try {
    assert.equal((await live.read(true)).mobile.displayStatus, "running");
    assert.equal((await history.read(true)).mobile.displayStatus, "idle");
  } finally {
    live.dispose();
    history.dispose();
  }
});
