import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  assertProjectPath,
  createProjectTestFixture,
} from "../../../scripts/ci/project-test-sandbox.mjs";
import { appSettingsSchema, type ZCodeTaskMeta } from "@zcode/shared";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { prepareTasksIndexStorage } from "../src/project-storage/startup.js";
import { createTaskAutoArchiveMaintenance } from "../src/session/taskAutoArchiveMaintenance.js";
import { createObservableSettingService } from "../src/setting/observableSettingService.js";
import { createBroadcastService } from "../src/broadcast/broadcastService.js";
import type { ISettingService } from "../src/setting/setting.js";
import { createZCodeTaskServiceAdapter } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";
import { createZCodeTaskIndexSyncer } from "../src/zcode-agent/zcodeTaskIndexSyncer.js";
import { createTaskGroupService } from "../src/task-groups/index.js";
import type { IZCodeAgentService } from "../src/zcode-agent/zcodeAgent.js";

function settingsFixture() {
  let value = appSettingsSchema.parse({
    taskAutoArchiveEnabled: true,
    recentProjects: ["/closed"],
  });
  const service = createObservableSettingService({
    get: async () => value,
    update: async (patch) => {
      value = appSettingsSchema.parse({ ...value, ...patch });
    },
  } as ISettingService);
  return service;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(overrides: Partial<Parameters<typeof createTaskAutoArchiveMaintenance>[0]> = {}) {
  const settings = settingsFixture();
  const calls: Array<{ workspacePath: string; workspaceIdentity?: string; olderThanDays: number }> =
    [];
  let tick: (() => Promise<void>) | undefined;
  let stopped = false;
  const maintenance = createTaskAutoArchiveMaintenance({
    settingService: settings,
    taskService: {
      archiveStaleTasks: async (params) => {
        calls.push(params);
        return [];
      },
    },
    conversationWorkspacePath: () => "/conversation",
    dataSourceKey: "database-a",
    onExternalArchive: () => {},
    schedule: (callback, interval) => {
      assert.equal(interval, 30 * 60 * 1000);
      tick = callback;
      return () => {
        stopped = true;
      };
    },
    ...overrides,
  });
  return { settings, calls, maintenance, tick: () => tick!(), stopped: () => stopped };
}

test("Host startup and periodic scans work without any grouped query, including closed projects and conversations", async () => {
  const f = fixture();
  try {
    await f.settings.update({
      lastWorkspaceSession: [
        { kind: "local", workspacePath: "/closed" },
        { kind: "local", workspacePath: "/open" },
      ],
    });
    await f.maintenance.start();
    assert.deepEqual(f.calls.map((x) => x.workspacePath).sort(), [
      "/closed",
      "/conversation",
      "/open",
    ]);
    f.calls.length = 0;
    await f.tick();
    assert.equal(f.calls.length, 3);
  } finally {
    await f.maintenance.disposeAndWait();
  }
  assert.equal(f.stopped(), true);
});

test("settings commits invalidate old scans and trigger a new retention policy; disable stops future work", async () => {
  const f = fixture();
  try {
    await f.maintenance.start();
    f.calls.length = 0;
    await f.settings.update({ taskAutoArchiveOlderThanDays: 3 });
    await f.maintenance.requestScan();
    assert.ok(f.calls.length > 0);
    assert.ok(f.calls.every((x) => x.olderThanDays === 3));
    await f.settings.update({ taskAutoArchiveEnabled: false });
    await f.maintenance.requestScan();
    f.calls.length = 0;
    await f.tick();
    assert.equal(f.calls.length, 0);
  } finally {
    await f.maintenance.disposeAndWait();
  }
});

test("dispose fences a pending settings read and cannot revive the timer", async () => {
  const gate = deferred();
  const settings = settingsFixture();
  const f = fixture({
    settingService: {
      ...settings,
      get: async () => {
        await gate.promise;
        return settings.get();
      },
    },
  });
  const startup = f.maintenance.start();
  f.maintenance.dispose();
  gate.resolve();
  await startup;
  await f.maintenance.disposeAndWait();
  assert.equal(f.calls.length, 0);
  await f.maintenance.start();
  assert.equal(f.stopped(), true);
});

test("concurrent triggers coalesce; disabling during an accepted archive prevents the next workspace", async () => {
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  const f = fixture({
    taskService: {
      archiveStaleTasks: async () => {
        calls++;
        entered.resolve();
        await release.promise;
        return [];
      },
    },
  });
  const startup = f.maintenance.start();
  await entered.promise;
  const pending = Array.from({ length: 20 }, () => f.maintenance.requestScan());
  await f.settings.update({ taskAutoArchiveEnabled: false });
  release.resolve();
  await Promise.all([startup, ...pending]);
  assert.equal(calls, 1);
  await f.maintenance.disposeAndWait();
});

test("a failed workspace does not prevent the remaining scopes from being scanned", async () => {
  const paths: string[] = [];
  const f = fixture({
    taskService: {
      archiveStaleTasks: async ({ workspacePath }) => {
        paths.push(workspacePath);
        if (workspacePath === "/closed") throw new Error("fixture failure");
        return [];
      },
    },
  });
  try {
    await f.maintenance.start();
    assert.deepEqual(paths, ["/closed", "/conversation"]);
  } finally {
    await f.maintenance.disposeAndWait();
  }
});

test("remote scopes require their current identity and session; offline scopes never fall back locally", async () => {
  let online = false;
  const remoteCalls: string[] = [];
  const f = fixture({
    resolveRemoteTarget: (scope) =>
      online
        ? {
            workspacePath: scope.workspacePath,
            workspaceIdentity: scope.workspaceIdentity,
            remoteSessionId: "current-session",
            archiveStaleTasks: async (params) => {
              remoteCalls.push(params.workspaceIdentity!);
              return [];
            },
          }
        : undefined,
  });
  await f.settings.update({
    lastWorkspaceSession: ["remote-a", "remote-b"].map((workspaceIdentity) => ({
      kind: "remote" as const,
      workspacePath: "/closed",
      workspaceIdentity,
      target: { kind: "ssh" as const, host: "example.invalid", username: "fixture" },
      lastOpenedAt: 1,
      lastConnectionStatus: "connected" as const,
    })),
  });
  try {
    await f.maintenance.start();
    assert.equal(remoteCalls.length, 0);
    assert.ok(f.calls.every((x) => !x.workspaceIdentity));
    online = true;
    await f.maintenance.requestScan();
    assert.deepEqual(remoteCalls.sort(), ["remote-a", "remote-b"]);
  } finally {
    await f.maintenance.disposeAndWait();
  }
});

test("same-source Hosts receive archive invalidation once; different databases and malformed broadcasts are ignored", async () => {
  const broadcast = createBroadcastService(null);
  const invalidations: string[] = [];
  const a = fixture({
    broadcastService: broadcast,
    taskService: { archiveStaleTasks: async () => [{ taskId: "example" } as ZCodeTaskMeta] },
  });
  const b = fixture({
    broadcastService: broadcast,
    onExternalArchive: (scope) => invalidations.push(scope.workspacePath),
  });
  const c = fixture({
    broadcastService: broadcast,
    dataSourceKey: "database-b",
    onExternalArchive: () => assert.fail("cross-database event"),
  });
  try {
    await b.maintenance.start();
    await c.maintenance.start();
    await a.maintenance.start();
    assert.deepEqual(invalidations, ["/closed", "/conversation"]);
    await broadcast.send({
      channel: "task-auto-archive:changed",
      payload: { workspacePath: "/bad" },
    });
    assert.equal(invalidations.length, 2);
  } finally {
    await Promise.all([a, b, c].map((f) => f.maintenance.disposeAndWait()));
  }
});

test("real SQLite preserves all exclusion conditions, identity, update time and cross-connection idempotency", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const dir = await createProjectTestFixture("archive-sqlite");
  const path = join(dir, "tasks.sqlite");
  const first = new TaskIndexRepo(undefined, undefined, path);
  const second = new TaskIndexRepo(undefined, undefined, path);
  const now = Date.now();
  const old = now - 8 * 86400000;
  const meta = (taskId: string, patch: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta => ({
    taskId,
    traceId: `trace-${taskId}`,
    workspacePath: "/closed",
    title: taskId,
    mode: "build",
    provider: "glm",
    createdAt: old,
    updatedAt: old,
    status: "completed",
    ...patch,
  });
  try {
    // Repo 只校验迁移账本；多连接夹具写入前也必须等待唯一异步启动 owner。
    await prepareTasksIndexStorage(path, () => {});
    for (const entry of [
      { meta: meta("eligible") },
      { meta: meta("boundary", { updatedAt: now - 7 * 86400000 }) },
      { meta: meta("recent", { updatedAt: now }) },
      { meta: meta("unread", { unreadAt: old }) },
      { meta: meta("running", { status: "running" }) },
      { meta: meta("pinned"), pinned: true },
      { meta: meta("deleted"), deleted: true },
      { meta: meta("archived"), archived: true },
      { meta: meta("remote", { workspaceIdentity: "other" }) },
    ]) {
      await first.applyCliFacts({
        meta: entry.meta,
        deleted: entry.deleted,
        // 自动归档资格取 CLI 完成事实；运行中且无完成事实不能被当成 completed。
        lastOutcome: entry.meta.status === "completed" ? "completed" : undefined,
      });
      if (!entry.deleted)
        await first.updateTaskState({
          workspacePath: entry.meta.workspacePath,
          workspaceIdentity: entry.meta.workspaceIdentity,
          taskId: entry.meta.taskId,
          patch: { pinned: entry.pinned, archived: entry.archived, unreadAt: entry.meta.unreadAt },
        });
    }
    const params = { workspacePath: "/closed", olderThanDays: 7 };
    const results = await Promise.all([
      first.archiveStaleTasks(params),
      second.archiveStaleTasks(params),
    ]);
    assert.deepEqual(
      results.flat().map((x) => x.taskId),
      ["eligible"],
    );
    assert.equal(
      (await first.getTaskMeta({ workspacePath: "/closed", taskId: "eligible" }))?.updatedAt,
      old,
    );
    assert.deepEqual(await first.archiveStaleTasks(params), []);
    context.mock.timers.tick(1);
    assert.deepEqual(
      (await first.archiveStaleTasks(params)).map((x) => x.taskId),
      ["boundary"],
    );
    assert.deepEqual(
      (await first.archiveStaleTasks({ ...params, workspaceIdentity: "other" })).map(
        (x) => x.taskId,
      ),
      ["remote"],
    );
  } finally {
    first.close();
    second.close();
    await assertProjectPath(dir);
    await rm(dir, { recursive: true, force: true });
  }
});

test("task adapter grouped reads are pure; Host maintenance commits before desktop notification and mobile recovery reads", async () => {
  const dir = await createProjectTestFixture("archive-adapter");
  const path = join(dir, "tasks.sqlite");
  const repo = new TaskIndexRepo(undefined, undefined, path);
  const agent = { disposeAll() {} } as IZCodeAgentService;
  const syncer = createZCodeTaskIndexSyncer({ agentService: agent, taskIndexRepo: repo });
  const taskService = createZCodeTaskServiceAdapter({
    zcodeAgentService: agent,
    taskIndexRepo: repo,
    taskIndexSyncer: syncer,
  });
  const scope = { workspacePath: "/closed" };
  const notifications: Promise<string[]>[] = [];
  const subscription = taskService.onDynamicWorkspaceEvent(scope)((event) => {
    assert.equal(event.type, "workspace_task_list_changed");
    notifications.push(
      taskService.listArchivedTasks(scope).then((rows) => rows.map((row) => row.taskId)),
    );
  });
  const f = fixture({ taskService });
  try {
    // 纯读与归档通知测试复用已准备库，不能以旧同步迁移旁路初始化。
    await prepareTasksIndexStorage(path, () => {});
    await repo.applyCliFacts({
      lastOutcome: "completed",
      meta: {
        taskId: "old",
        traceId: "fixture",
        ...scope,
        title: "old",
        mode: "build",
        provider: "glm",
        status: "completed",
        createdAt: 1,
        updatedAt: 1,
      },
    });
    const groups = createTaskGroupService({
      database: () => repo.getOrganizationDatabase(),
      resolveTasks: async () => [],
      afterChange: async () => assert.fail("grouped read must not mutate organization"),
    });
    await groups.read();
    assert.deepEqual(
      (await taskService.listTasks(scope)).map((x) => x.taskId),
      ["old"],
    );
    assert.equal(notifications.length, 0);
    await f.maintenance.start();
    assert.deepEqual(await Promise.all(notifications), [["old"]]);
    // replayable 客户端在离线期间没有事件，恢复必须直接从同一持久化归属得到正确结果。
    subscription.dispose();
    assert.deepEqual(await taskService.listTasks(scope), []);
    assert.deepEqual(
      (await taskService.listArchivedTasks(scope)).map((x) => x.taskId),
      ["old"],
    );
  } finally {
    await f.maintenance.disposeAndWait();
    subscription.dispose();
    (taskService as typeof taskService & { disposeAll(): void }).disposeAll();
    repo.close();
    await assertProjectPath(dir);
    await rm(dir, { recursive: true, force: true });
  }
});

test("closed independent task and project scopes are archived from SQLite without recent or open workspace records", async () => {
  const dir = await createProjectTestFixture("archive-indexed-scopes");
  const repo = new TaskIndexRepo(undefined, undefined, join(dir, "tasks.sqlite"));
  const agent = { disposeAll() {} } as IZCodeAgentService;
  const syncer = createZCodeTaskIndexSyncer({ agentService: agent, taskIndexRepo: repo });
  const taskService = createZCodeTaskServiceAdapter({
    zcodeAgentService: agent,
    taskIndexRepo: repo,
    taskIndexSyncer: syncer,
  });
  const first = join(dir, "workspaces", "draft-11111111-1111-4111-8111-111111111111");
  const second = join(dir, "workspaces", "draft-22222222-2222-4222-8222-222222222222");
  const project = join(dir, "project");
  const indexed: string[][] = [];
  const f = fixture({
    taskService,
    listLocalWorkspaceScopes: async () => {
      const scopes = await repo.listLocalWorkspaceScopes();
      indexed.push(scopes.map((scope) => scope.workspacePath));
      return scopes;
    },
  });
  const notified: string[] = [];
  const subscriptions = [first, second, project].map((workspacePath) =>
    taskService.onDynamicWorkspaceEvent({ workspacePath })((event) => {
      if (event.type === "workspace_task_list_changed") notified.push(workspacePath);
    }),
  );
  try {
    await prepareTasksIndexStorage(join(dir, "tasks.sqlite"), () => {});
    await f.settings.update({ recentProjects: [], lastWorkspaceSession: [] });
    const projects = await repo.getProjectRepository();
    const savedProject = projects.saveProject({
      name: "fixture-project",
      roots: [project],
      primaryRoot: project,
    });
    const old = Date.now() - 8 * 86400000;
    for (const [taskId, workspacePath, lastOutcome, workspaceIdentity] of [
      ["old-a", first, "completed"],
      ["old-b", second, "completed"],
      ["project", project, "completed"],
      ["unread", first, "completed"],
      ["error", first, "error"],
      ["pinned", first, "completed"],
      ["remote", first, "completed", "remote-fixture"],
      ["remote-only", join(dir, "remote-only"), "completed", "remote-fixture"],
      ["deleted-only", join(dir, "deleted-only"), "completed"],
      ["archived-only", join(dir, "archived-only"), "completed"],
      ["foreign-host", join(dir, "foreign-host"), "completed"],
    ] as const) {
      await repo.applyCliFacts({
        lastOutcome,
        deleted: taskId === "deleted-only",
        meta: {
          taskId,
          workspacePath,
          workspaceIdentity,
          traceId: "fixture",
          title: taskId,
          mode: "build",
          provider: "glm",
          createdAt: old,
          updatedAt: old,
        },
      });
      if (taskId === "unread" || taskId === "pinned")
        await repo.updateTaskState({
          workspacePath,
          taskId,
          patch: taskId === "unread" ? { unreadAt: old } : { pinned: true },
        });
      if (taskId === "archived-only")
        await repo.updateTaskState({ workspacePath, taskId, patch: { archived: true } });
      if (taskId === "foreign-host")
        (await repo.getOrganizationDatabase())
          .prepare("UPDATE tasks SET host_id=? WHERE workspace_key=? AND task_id=?")
          .run("remote-fixture", workspacePath, taskId);
    }
    projects.moveTask({
      task: { workspacePath: project, taskId: "project" },
      projectId: savedProject.id,
    });
    assert.equal(
      projects.readTree().tasks.find((task) => task.taskId === "project")?.projectId,
      savedProject.id,
    );
    await f.maintenance.start();
    assert.deepEqual(
      (await repo.listTaskMetas({ archived: true })).map((row) => row.taskId).sort(),
      ["archived-only", "old-a", "old-b", "project"],
    );
    assert.deepEqual(indexed, [[first, second, project].sort()]);
    assert.deepEqual(notified.sort(), [first, second, project].sort());
    assert.equal(
      (await repo.getTaskMeta({ workspacePath: first, taskId: "old-a" }))?.updatedAt,
      old,
    );
    assert.deepEqual(
      await repo.listTaskMetas({
        workspacePath: first,
        workspaceIdentity: "remote-fixture",
        archived: true,
      }),
      [],
    );
    // 手机离线期间没有通知；恢复直接读取同一归档集合，不能重新显示已归档任务。
    subscriptions.forEach((subscription) => subscription.dispose());
    assert.deepEqual(
      (await taskService.listTasks({ workspacePath: second })).map((row) => row.taskId),
      [],
    );
    assert.deepEqual(
      (await taskService.listArchivedTasks({ workspacePath: second })).map((row) => row.taskId),
      ["old-b"],
    );
  } finally {
    await f.maintenance.disposeAndWait();
    subscriptions.forEach((subscription) => subscription.dispose());
    (taskService as typeof taskService & { disposeAll(): void }).disposeAll();
    repo.close();
    await assertProjectPath(dir);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a resumed active task keeps its old completed fact but is protected at the SQL commit boundary", async () => {
  const dir = await createProjectTestFixture("archive-active-boundary");
  const database = join(dir, "tasks.sqlite");
  const repo = new TaskIndexRepo(undefined, undefined, database);
  const agent = { disposeAll() {} } as IZCodeAgentService;
  const syncer = createZCodeTaskIndexSyncer({ agentService: agent, taskIndexRepo: repo });
  let active: ReturnType<typeof syncer.activeTaskRefs> = [];
  const taskService = createZCodeTaskServiceAdapter({
    zcodeAgentService: agent,
    taskIndexRepo: repo,
    taskIndexSyncer: { ...syncer, activeTaskRefs: () => active },
  });
  const scope = { workspacePath: dir };
  try {
    await prepareTasksIndexStorage(database, () => {});
    await repo.applyCliFacts({
      lastOutcome: "completed",
      meta: {
        taskId: "resumed",
        traceId: "fixture",
        ...scope,
        title: "resumed",
        provider: "glm",
        mode: "build",
        createdAt: 1,
        updatedAt: 1,
      },
    });
    const pending = taskService.archiveStaleTasks({ ...scope, olderThanDays: 7 });
    active = [{ ...scope, taskId: "resumed" }];
    assert.deepEqual(
      await pending,
      [],
      "an active observation made while Repo awaits preparation must protect the task",
    );
    assert.deepEqual(await repo.listTaskMetas({ ...scope, archived: true }), []);
    active = [{ ...scope, workspaceIdentity: "other-host", taskId: "resumed" }];
    assert.deepEqual(
      (await taskService.archiveStaleTasks({ ...scope, olderThanDays: 7 })).map(
        (row) => row.taskId,
      ),
      ["resumed"],
    );
    assert.equal((await repo.getTaskMeta({ ...scope, taskId: "resumed" }))?.updatedAt, 1);
  } finally {
    (taskService as typeof taskService & { disposeAll(): void }).disposeAll();
    repo.close();
    await assertProjectPath(dir);
    await rm(dir, { recursive: true, force: true });
  }
});

test("indexed scope reads are fenced by settings changes and Host disposal", async () => {
  for (const stop of ["disable", "dispose"] as const) {
    const entered = deferred();
    const release = deferred();
    let readStarted = false;
    const f = fixture({
      listLocalWorkspaceScopes: async () => {
        readStarted = true;
        entered.resolve();
        await release.promise;
        return [{ workspacePath: "/closed-independent" }];
      },
    });
    const startup = f.maintenance.start();
    try {
      await Promise.race([entered.promise, startup]);
      assert.equal(readStarted, true, "the scan must read the indexed workspace source");
      if (stop === "disable") await f.settings.update({ taskAutoArchiveEnabled: false });
      else f.maintenance.dispose();
      release.resolve();
      await startup;
      assert.equal(f.calls.length, 0);
    } finally {
      release.resolve();
      await f.maintenance.disposeAndWait();
    }
  }
});

test("indexed scope failure preserves old known scopes and foreign identities never enter local routing", async () => {
  for (const listLocalWorkspaceScopes of [
    async () => {
      throw new Error("fixture-private-path");
    },
    async () => [
      { workspacePath: "/closed", workspaceIdentity: "other-host" },
      { workspacePath: "/closed" },
      { workspacePath: "/closed" },
    ],
  ]) {
    const f = fixture({ listLocalWorkspaceScopes });
    try {
      await f.maintenance.start();
      assert.deepEqual(
        f.calls.map((scope) => scope.workspacePath),
        ["/closed", "/conversation"],
      );
      assert.ok(f.calls.every((scope) => !scope.workspaceIdentity));
    } finally {
      await f.maintenance.disposeAndWait();
    }
  }
});
