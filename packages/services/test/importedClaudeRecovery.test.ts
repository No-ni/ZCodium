import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
  zcodeSessionStateSnapshotSchema,
  type ZCodeSessionStateSnapshot,
} from "@zcode/shared";
import { getLegacyTaskSessionSnapshotPath, setDataBaseDir } from "../src/paths.js";
import { parseLegacyTaskSessionFile } from "../src/session/legacyTaskSessionFile.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { createZCodeTaskServiceAdapter } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";
import { prepareTasksIndexStorage } from "../src/session/tasksDatabase/startup.js";
import {
  assertProjectPath,
  createProjectTestFixture,
} from "../../../scripts/ci/project-test-sandbox.mjs";

for (const clientMode of ["desktop-continuous", "web-remote-replayable"] as const) {
  test(`previously imported Claude history becomes a real session for ${clientMode}`, async () => {
    const dir = await createProjectTestFixture("import-recovery");
    setDataBaseDir(dir);
    const meta = {
      taskId: "claude-import-example",
      traceId: "import-trace-example",
      workspacePath: "/example/workspace",
      workspaceIdentity: "example-remote-workspace",
      title: "Imported example",
      mode: "build" as const,
      provider: "glm" as const,
      migrationSource: "claudeCode" as const,
      createdAt: 1,
      updatedAt: 2,
    };
    const legacy = parseLegacyTaskSessionFile({
      meta,
      messages: [
        { id: "old-user", role: "user", content: "Example question", timestamp: 1 },
        { id: "old-assistant", role: "assistant", content: "Example answer", timestamp: 2 },
      ],
      toolCalls: [],
    });
    const path = getLegacyTaskSessionSnapshotPath(
      meta.workspacePath,
      meta.taskId,
      meta.workspaceIdentity,
    );
    const content = JSON.stringify(legacy);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    const databasePath = join(dir, "tasks.sqlite");
    // 回归夹具遗漏异步准备导致导入断言尚未执行就失败；沿用 Host 的唯一迁移 owner。
    await prepareTasksIndexStorage(databasePath, () => {});
    const taskIndexRepo = new TaskIndexRepo(databasePath);
    await taskIndexRepo.syncTaskMeta({ meta });
    type Options = Parameters<typeof createZCodeTaskServiceAdapter>[0];
    type CreateInput = Parameters<Options["zcodeAgentService"]["createSession"]>[0];
    const created: CreateInput[] = [];
    let session: ZCodeSessionStateSnapshot | undefined;
    const disposable = () => ({ dispose() {} });
    const service = createZCodeTaskServiceAdapter({
      taskIndexRepo,
      zcodeAgentService: {
        async resumeSession() {
          if (!session) throw new Error(`Session not found: ${meta.taskId}`);
          return session;
        },
        async createSession(input: CreateInput) {
          created.push(input);
          session = zcodeSessionStateSnapshotSchema.parse({
            protocol: { name: ZCODE_PROTOCOL_NAME, version: ZCODE_PROTOCOL_VERSION },
            session: {
              sessionId: input.sessionId,
              workspace: {
                workspacePath: meta.workspacePath,
                workspaceIdentity: meta.workspaceIdentity,
                workspaceKey: meta.workspaceIdentity,
              },
              sessionKind: "interactive",
              title: input.importedHistory?.title,
              mode: "build",
              status: "idle",
              createdAt: 1,
              updatedAt: 2,
            },
            settings: {
              model: { available: [] },
              thoughtLevel: { enabled: false, available: [] },
              mode: { current: "build" },
            },
            projection: {
              sessionId: input.sessionId,
              status: "idle",
              mode: "build",
              turnCount: 0,
              totalTokenCount: 0,
              contextUsed: 0,
              contextWindow: 200000,
              pendingPermissions: [],
              activeToolCalls: [],
              backgroundJobs: [],
            },
            runtime: { eventSeq: 0, stateRevision: 0, pendingRequestIds: [] },
            messages: [],
          });
          return session;
        },
        disposeAll() {},
      } as unknown as Options["zcodeAgentService"],
      taskIndexSyncer: {
        onSessionTerminalEvent: disposable,
        onSessionReadyEvent: disposable,
        disposeAll() {},
      } as unknown as Options["taskIndexSyncer"],
    });
    try {
      const snapshot = await service.getTaskSnapshot({ ...meta, clientMode });
      assert.equal(snapshot?.meta.taskId, meta.taskId);
      assert.equal(snapshot?.meta.migrationSource, "claudeCode");
      assert.equal(created.length, 1);
      assert.equal(created[0]?.workspaceIdentity, meta.workspaceIdentity);
      assert.equal(created[0]?.sessionId, meta.taskId);
      assert.equal(created[0]?.persistence, "immediate");
      assert.deepEqual(created[0]?.importedHistory, {
        source: "claudeCode",
        title: meta.title,
        createdAt: 1,
        updatedAt: 2,
        messages: legacy.messages.map(({ role, content, timestamp }) => ({
          role,
          content,
          timestamp,
        })),
      });
      assert.equal(await readFile(path, "utf8"), content);
    } finally {
      // disposeAll 是 adapter 的本地生命周期扩展，不属于对外 RPC 服务契约。
      (service as typeof service & { disposeAll(): void }).disposeAll();
      taskIndexRepo.close();
      setDataBaseDir(null);
      await rm(await assertProjectPath(dir), { recursive: true, force: true });
    }
  });
}

test("remote resume keeps remoteSessionId through missing and empty-session Claude repairs", async () => {
  const dir = await createProjectTestFixture("import-remote-recovery");
  setDataBaseDir(dir);
  const remoteSessionId = "remote-import-recovery";
  const meta = {
    taskId: "claude-import-remote-example",
    traceId: "import-trace-remote-example",
    workspacePath: "/example/remote-workspace",
    workspaceIdentity: "example-remote-workspace",
    title: "Imported remote example",
    mode: "build" as const,
    provider: "glm" as const,
    migrationSource: "claudeCode" as const,
    createdAt: 1,
    updatedAt: 2,
  };
  const legacy = parseLegacyTaskSessionFile({
    meta,
    messages: [
      { id: "remote-old-user", role: "user", content: "Remote question", timestamp: 1 },
      { id: "remote-old-assistant", role: "assistant", content: "Remote answer", timestamp: 2 },
    ],
    toolCalls: [],
  });
  const path = getLegacyTaskSessionSnapshotPath(
    meta.workspacePath,
    meta.taskId,
    meta.workspaceIdentity,
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(legacy));
  const databasePath = join(dir, "tasks.sqlite");
  // 远端恢复使用同一启动契约，不能让测试通过恢复旧同步 DDL 绕过迁移账本。
  await prepareTasksIndexStorage(databasePath, () => {});
  const taskIndexRepo = new TaskIndexRepo(databasePath);
  await taskIndexRepo.syncTaskMeta({ meta });
  type Options = Parameters<typeof createZCodeTaskServiceAdapter>[0];
  type CreateInput = Parameters<Options["zcodeAgentService"]["createSession"]>[0];
  const created: CreateInput[] = [];
  let session: ZCodeSessionStateSnapshot | undefined;
  let missingSession = true;
  const disposable = () => ({ dispose() {} });
  const service = createZCodeTaskServiceAdapter({
    taskIndexRepo,
    zcodeAgentService: {
      async resumeSession(input: Parameters<Options["zcodeAgentService"]["resumeSession"]>[0]) {
        assert.equal(input.remoteSessionId, remoteSessionId);
        if (missingSession || !session) throw new Error(`Session not found: ${meta.taskId}`);
        return session;
      },
      async createSession(input: CreateInput) {
        created.push(input);
        session = zcodeSessionStateSnapshotSchema.parse({
          protocol: { name: ZCODE_PROTOCOL_NAME, version: ZCODE_PROTOCOL_VERSION },
          session: {
            sessionId: input.sessionId,
            workspace: {
              workspacePath: meta.workspacePath,
              workspaceIdentity: meta.workspaceIdentity,
              workspaceKey: meta.workspaceIdentity,
            },
            sessionKind: "interactive",
            title: meta.title,
            mode: "build",
            status: "idle",
            createdAt: 1,
            updatedAt: 2,
          },
          settings: {
            model: { available: [] },
            thoughtLevel: { enabled: false, available: [] },
            mode: { current: "build" },
          },
          projection: {
            sessionId: input.sessionId,
            status: "idle",
            mode: "build",
            turnCount: 0,
            totalTokenCount: 0,
            contextUsed: 0,
            contextWindow: 200000,
            pendingPermissions: [],
            activeToolCalls: [],
            backgroundJobs: [],
          },
          runtime: { eventSeq: 0, stateRevision: 0, pendingRequestIds: [] },
          messages: [],
        });
        return session;
      },
      disposeAll() {},
    } as unknown as Options["zcodeAgentService"],
    taskIndexSyncer: {
      ensureSessionSubscription() {},
      getWorkspaceEmitter() {
        return { fire() {} };
      },
      onSessionTerminalEvent: disposable,
      onSessionReadyEvent: disposable,
      disposeAll() {},
    } as unknown as Options["taskIndexSyncer"],
  });
  try {
    // 首次覆盖 session missing 回退，第二次覆盖恢复成功但快照为空时的回填。
    await service.resumeTask({ ...meta, remoteSessionId });
    missingSession = false;
    await service.resumeTask({ ...meta, remoteSessionId });
    assert.equal(created.length, 2);
    assert.deepEqual(
      created.map((input) => input.remoteSessionId),
      [remoteSessionId, remoteSessionId],
    );
  } finally {
    (service as typeof service & { disposeAll(): void }).disposeAll();
    taskIndexRepo.close();
    setDataBaseDir(null);
    await rm(await assertProjectPath(dir), { recursive: true, force: true });
  }
});
