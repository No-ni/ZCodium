import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { setImmediate as settled } from "node:timers/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Emitter } from "../../../packages/rpc/src/index.ts";
import {
  CONTROLLER_TASKS_INDEX_TOPIC,
  V4_WIRE_PROTOCOL_VERSION,
  sessionSummarySchema,
  sessionsIndexTopic,
  windowHostControllerTaskFrameSchema,
} from "../../../packages/shared/src/zcode-protocol-v4/index.ts";
import { readTasks } from "../../../packages/services/src/project-storage/project-repository-queries.ts";
import { createWindowHostControllerRuntime } from "../../../packages/desktop/src/host/windowHostControllerService.ts";
import { getWindowControllerTaskListRegistry } from "../../../packages/ui/src/v4/windowControllerTaskListRegistry.ts";
import { applyProjectTaskActivities } from "../../../packages/ui/src/project-sidebar/view.ts";
import { collectSessionRowActivities } from "../../../packages/ui/src/project-sidebar/projectTreeEquality.ts";
import { readProjectSidebarTree } from "../../../packages/ui/src/project-sidebar/project-tree-reader.ts";
import { mapSessionSummaryToTaskMeta } from "../../../packages/ui/src/v4/mapSessionSummaryToTaskMeta.ts";
import {
  getTaskListAttention,
  getTaskListRowActivity,
} from "../../../packages/ui/src/v4/taskListRowActivity.ts";
import { deriveTaskLeadingIndicator } from "../../../packages/ui/src/lib/taskListItemPresentation.ts";
import { ContextMenu } from "../../../packages/ui/src/components/ui/context-menu.tsx";
import { TaskRowContent } from "../../../packages/ui/src/project-sidebar/grouped/TaskRowContent.tsx";

const BASE = 1_700_000_000_000;
const OLD_PENDING = Object.freeze({ interactionId: "old-persisted", kind: "permission" });
const CURRENT_PENDING = Object.freeze({
  interactionId: "current-live",
  kind: "userInput",
  toolName: "AskUserQuestion",
});
const noop = () => {};
const intl = {
  formatMessage: ({ id }) =>
    id === "taskList.userInputTag"
      ? "WAIT_USER"
      : id === "taskList.permissionTag"
        ? "WAIT_PERMISSION"
        : id,
};

function summary(patch = {}) {
  return sessionSummarySchema.parse({
    sessionId: "session-fixture",
    workspaceId: "workspace-fixture",
    title: "live",
    phase: "running",
    sessionEnded: false,
    hasBackgroundWork: false,
    createdAt: BASE,
    lastActivityAt: BASE + 10_000,
    ...patch,
  });
}

function renderTask(task) {
  const attention = getTaskListAttention(task);
  const hasPendingInteraction = Boolean(task.pendingInteraction) || attention !== null;
  return renderToStaticMarkup(
    createElement(
      ContextMenu,
      null,
      createElement(TaskRowContent, {
        tooltipsDisabled: true,
        rowRef: noop,
        draggable: { attributes: {}, listeners: {} },
        onSelect: noop,
        onKeyDown: noop,
        onRowMouseEnter: noop,
        onRowMouseLeave: noop,
        onRowContextMenu: noop,
        onRowFocusCapture: noop,
        onRowBlurCapture: noop,
        groupedTaskDomKey: "fixture-row",
        task,
        isMobileActive: false,
        isActive: false,
        taskTitle: task.title,
        intl,
        snoozeInteractionAutoResolution: () => true,
        taskAttentionDisplay: attention
          ? attention.kind === "userInput"
            ? "WAIT_USER"
            : "WAIT_PERMISSION"
          : null,
        shouldSuppressTaskMetadata: false,
        leadingIndicator: deriveTaskLeadingIndicator(task, getTaskListRowActivity(task)),
        statusDotClassName: null,
        hasPendingInteraction,
        isTaskCron: false,
        isTaskOffPeak: false,
        taskTimeLabel: "ACTIVITY_TIME",
        shouldMountHoverActions: false,
        canOpenFileTree: false,
        workspaceActionsDisabledReason: undefined,
        onOpenFileTree: noop,
        onMoveTaskToTop: noop,
        onCloseTask: noop,
        workflowRunLinesNode: null,
      }),
    ),
  );
}

async function fixture(initial, options = {}) {
  const persistedPending = Object.prototype.hasOwnProperty.call(options, "persistedPending")
    ? options.persistedPending
    : OLD_PENDING;
  assert.ok(process.env.PROJECT_TEST_SANDBOX_ROOT, "Use the isolated project test entry");
  const target = { workspacePath: join(process.env.PROJECT_TEST_SANDBOX_ROOT, "memory-workspace") };
  // 原生 SQLite 只用 :memory:，不访问业务数据库、用户目录或 sqlite 文件。
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE tasks (
    task_id TEXT, provider TEXT, deleted INTEGER, cli_deleted INTEGER, cli_created_at INTEGER,
    cli_updated_at INTEGER, meta_json TEXT, root_path TEXT, workspace_identity TEXT,
    workspace_key TEXT, title TEXT, title_overridden INTEGER, cli_title TEXT,
    cli_title_source TEXT, cli_last_outcome TEXT, pinned INTEGER, archived INTEGER,
    unread_at INTEGER, project_id TEXT, host_id TEXT
  )`);
  const oldMeta = {
    taskId: "session-fixture",
    traceId: "fixture",
    title: "persisted",
    workspacePath: target.workspacePath,
    createdAt: BASE,
    updatedAt: BASE,
    mode: "build",
    provider: "glm",
    pendingInteraction: persistedPending,
  };
  db.prepare(
    "INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "session-fixture",
    "glm",
    0,
    0,
    BASE,
    BASE,
    JSON.stringify(oldMeta),
    target.workspacePath,
    null,
    target.workspacePath,
    "persisted",
    0,
    "persisted",
    "default",
    "completed",
    1,
    0,
    null,
    null,
    "local",
  );
  const projectService = { readTree: async () => ({ projects: [], tasks: readTasks(db) }) };
  const readTree = async () => (await readProjectSidebarTree({ projectService })).tree;
  const persistedTree = await readTree();
  const persisted = persistedTree.tasks[0];
  assert.deepEqual(persisted.pendingInteraction, persistedPending);
  assert.equal(persisted.pinned, true);
  const wires = new Emitter();
  const restarted = new Emitter();
  const topic = sessionsIndexTopic(target.workspacePath);
  let seq = 0;
  let availability = "online";
  const send = (session, kind = "deltas") => {
    const fromSeq = seq++;
    wires.fire({
      wireVersion: V4_WIRE_PROTOCOL_VERSION,
      kind: "complete",
      deliveryKind: kind === "snapshot" ? "initial" : "online",
      logicalFrameId: `frame-${seq}`,
      logicalFrameOrdinal: seq,
      topic,
      subscriptionId: "sessions-fixture",
      frame: {
        topic,
        subscriptionId: "sessions-fixture",
        fromSeq: kind === "snapshot" ? 0 : fromSeq,
        toSeq: seq,
        sentAt: BASE + seq,
        payload:
          kind === "snapshot"
            ? {
                kind,
                snapshot: {
                  protocolVersion: 1,
                  workspaceId: target.workspacePath,
                  logEpoch: "sessions-epoch",
                  sessions: session ? [session] : [],
                },
              }
            : { kind, deltas: [{ op: "session.upserted", session }] },
      },
    });
  };
  const lifecycle = new Emitter();
  const agentService = {
    onDynamicSessionsIndexFrame: () => wires.event,
    onAgentRuntimeRestarted: restarted.event,
    onAgentRuntimeLifecycle: lifecycle.event,
    subscribeSessionsIndexV4: async () => {
      send(initial, "snapshot");
      return { ack: { subscriptionId: "sessions-fixture", logEpoch: "sessions-epoch", seq0: 0 } };
    },
    unsubscribeSessionsIndexV4: async () => {},
    resyncSessionsIndexV4: async () => assert.fail("Fixture has no sequence gap"),
  };
  const taskService = {
    listTasks: async () => readTasks(db),
    listPinnedTasks: async () => [],
    listArchivedTasks: async () => [],
  };
  const scope = { kind: "local", ...target };
  let id = 0;
  const runtime = createWindowHostControllerRuntime({
    createId: () => `controller-${++id}`,
    readHostTaskList: async () => assert.fail("Use the existing workspace source"),
    resolveSource: () => ({ scope, taskService, agentService, sourceAvailability: availability }),
    onSourceError: (_scope, _operation, error) => assert.fail(error.message),
  });
  const taskFrames = [];
  const controller = {
    ...runtime.service,
    onDynamicControllerFrame: () => (listener) =>
      runtime.service.onDynamicControllerFrame()((frame) => {
        if (frame.topic !== CONTROLLER_TASKS_INDEX_TOPIC) return listener(frame);
        // 必须消费真实 wire parse 的返回值；只校验后继续传原对象会掩盖 schema 静默剥离详情。
        const parsed = windowHostControllerTaskFrameSchema.parse(frame);
        taskFrames.push(frame);
        listener(parsed);
      }),
  };
  const registry = getWindowControllerTaskListRegistry(controller);
  const unsubscribe = registry.subscribe(noop);
  await registry.list(
    "fixture",
    { controllerRevision: 0, taskListVersionSignature: "fixture" },
    { kind: "active", workspaceScopes: [target], sortBy: "updated" },
  );
  await settled();
  const display = (activities) => {
    const projected = applyProjectTaskActivities(persistedTree, activities);
    assert.equal(projected.tasks.length, 1);
    for (const key of [
      "taskId",
      "workspacePath",
      "projectId",
      "hostId",
      "pinned",
      "archived",
      "unreadAt",
      "title",
    ])
      assert.deepEqual(projected.tasks[0][key], persisted[key], `Activity must not change ${key}`);
    return { task: projected.tasks[0], html: renderTask(projected.tasks[0]) };
  };
  return {
    send,
    taskFrames: () => taskFrames,
    persisted,
    getDirectoryRevision: registry.getDirectoryRevision,
    async display() {
      await settled();
      return display(registry.readActivities());
    },
    fallbackDisplay(current) {
      const items = current
        ? [mapSessionSummaryToTaskMeta(current, { ...target, previous: persisted })]
        : [];
      return display(collectSessionRowActivities(items));
    },
    async unavailable() {
      lifecycle.fire({ workspaceKey: target.workspacePath, state: "unavailable" });
      await settled();
    },
    async offline() {
      availability = "offline";
      await runtime.refreshWorkspace(scope);
      await settled();
    },
    dispose() {
      unsubscribe();
      runtime.dispose();
      wires.dispose();
      restarted.dispose();
      lifecycle.dispose();
      db.close();
    },
  };
}

for (const phase of ["running", "completedSuccess", "completedInterrupted", "error"]) {
  test(`真实 ${phase} activity 清掉SQLite旧等待胶囊`, async () => {
    const f = await fixture(summary({ phase }));
    try {
      const { task, html } = await f.display();
      assert.equal(task.pendingInteraction, undefined);
      assert.doesNotMatch(html, /WAIT_PERMISSION|WAIT_USER|data-task-interaction-badge/);
      assert.match(html, /ACTIVITY_TIME/);
    } finally {
      f.dispose();
    }
  });
}

test("新Ask交互替换旧权限ID，并渲染真实Ask胶囊", async () => {
  const f = await fixture(
    summary({
      pendingInteraction: CURRENT_PENDING,
      pendingInteractionSummary: { permissionCount: 0, userInputCount: 1 },
    }),
  );
  try {
    const { task, html } = await f.display();
    assert.deepEqual(task.pendingInteraction, CURRENT_PENDING);
    assert.match(html, /data-task-interaction-badge="userInput"/);
    assert.doesNotMatch(html, /WAIT_PERMISSION|ACTIVITY_TIME/);
  } finally {
    f.dispose();
  }
});

test("Controller真实wire保留autoResolution详情并接受后续替换", async () => {
  const initial = {
    ...CURRENT_PENDING,
    autoResolution: {
      state: "hiddenGrace",
      startedAt: BASE,
      visibleAt: BASE + 5_000,
      deadlineAt: BASE + 10_000,
    },
  };
  const next = {
    ...CURRENT_PENDING,
    autoResolution: { state: "snoozed", startedAt: BASE, snoozedAt: BASE + 1_000 },
  };
  const f = await fixture(
    summary({
      pendingInteraction: initial,
      pendingInteractionSummary: { permissionCount: 0, userInputCount: 1 },
    }),
  );
  try {
    assert.deepEqual((await f.display()).task.pendingInteraction, initial);
    f.send(
      summary({
        pendingInteraction: next,
        pendingInteractionSummary: { permissionCount: 0, userInputCount: 1 },
      }),
    );
    assert.deepEqual((await f.display()).task.pendingInteraction, next);
  } finally {
    f.dispose();
  }
});

test("Controller真实wire拒绝非法轻量交互kind", async () => {
  const f = await fixture(
    summary({
      pendingInteraction: CURRENT_PENDING,
      pendingInteractionSummary: { permissionCount: 0, userInputCount: 1 },
    }),
  );
  try {
    const original = f.taskFrames().at(-1);
    assert.ok(original, "The real Controller must publish a task frame");
    const invalid = structuredClone(original);
    const rows =
      invalid.payload.kind === "snapshot"
        ? invalid.payload.snapshot.tasks
        : invalid.payload.deltas
            .filter((delta) => delta.op === "task.upserted")
            .map((delta) => delta.task);
    assert.ok(rows.length > 0, "The real frame must contain the fixture task");
    for (const row of rows) row.meta.pendingInteraction = { ...CURRENT_PENDING, kind: "invalid" };
    assert.equal(windowHostControllerTaskFrameSchema.safeParse(invalid).success, false);
  } finally {
    f.dispose();
  }
});

test("仅计数的兼容live摘要清旧详情，使用当前userInput attention", async () => {
  const f = await fixture(
    summary({ pendingInteractionSummary: { permissionCount: 0, userInputCount: 1 } }),
  );
  try {
    const { task, html } = await f.display();
    assert.equal(task.pendingInteraction, undefined);
    assert.match(html, /WAIT_USER/);
    assert.doesNotMatch(html, /WAIT_PERMISSION/);
  } finally {
    f.dispose();
  }
});

test("live交互解决后的Controller delta立即清胶囊，无需重拉项目目录", async () => {
  const f = await fixture(
    summary({
      pendingInteraction: CURRENT_PENDING,
      pendingInteractionSummary: { permissionCount: 0, userInputCount: 1 },
    }),
    { persistedPending: undefined },
  );
  try {
    assert.match((await f.display()).html, /data-task-interaction-badge="userInput"/);
    const directoryRevision = f.getDirectoryRevision();
    f.send(summary());
    const cleared = await f.display();
    assert.equal(f.getDirectoryRevision(), directoryRevision);
    assert.equal(cleared.task.pendingInteraction, undefined);
    assert.doesNotMatch(cleared.html, /WAIT_USER|data-task-interaction-badge/);
    assert.match(cleared.html, /ACTIVITY_TIME/);
  } finally {
    f.dispose();
  }
});

for (const state of ["missing", "runtime-unavailable", "source-offline"]) {
  test(`${state} 静态行不由持久交互制造等待`, async () => {
    const f = await fixture(
      state === "missing"
        ? null
        : summary({
            pendingInteraction: CURRENT_PENDING,
            pendingInteractionSummary: { permissionCount: 0, userInputCount: 1 },
          }),
    );
    try {
      if (state === "runtime-unavailable") await f.unavailable();
      if (state === "source-offline") await f.offline();
      const { task, html } = await f.display();
      assert.equal(task.pendingInteraction, undefined);
      assert.equal(getTaskListRowActivity(task), null);
      assert.doesNotMatch(html, /WAIT_PERMISSION|WAIT_USER|data-task-interaction-badge/);
      assert.doesNotMatch(html, /animate-spin/);
      assert.match(html, /ACTIVITY_TIME/);
    } finally {
      f.dispose();
    }
  });
}

test("无历史pending的普通静态行保持原引用和元数据", async () => {
  const f = await fixture(null, { persistedPending: undefined });
  try {
    const { task, html } = await f.display();
    assert.strictEqual(task, f.persisted);
    assert.match(html, /ACTIVITY_TIME/);
  } finally {
    f.dispose();
  }
});

test("fallback真实summary映射与collector携带当前Ask，覆盖SQLite旧权限", async () => {
  const f = await fixture(null);
  try {
    const { task, html } = f.fallbackDisplay(
      summary({
        pendingInteraction: CURRENT_PENDING,
        pendingInteractionSummary: { permissionCount: 0, userInputCount: 1 },
      }),
    );
    assert.deepEqual(task.pendingInteraction, CURRENT_PENDING);
    assert.match(html, /data-task-interaction-badge="userInput"/);
    assert.doesNotMatch(html, /WAIT_PERMISSION|ACTIVITY_TIME/);
  } finally {
    f.dispose();
  }
});

test("fallback当前summary字段缺席清旧等待，保留实时activity", async () => {
  const f = await fixture(null);
  try {
    const { task, html } = f.fallbackDisplay(summary());
    assert.equal(task.pendingInteraction, undefined);
    assert.equal(getTaskListRowActivity(task)?.phase, "running");
    assert.doesNotMatch(html, /WAIT_PERMISSION|WAIT_USER|data-task-interaction-badge/);
    assert.match(html, /ACTIVITY_TIME/);
  } finally {
    f.dispose();
  }
});
