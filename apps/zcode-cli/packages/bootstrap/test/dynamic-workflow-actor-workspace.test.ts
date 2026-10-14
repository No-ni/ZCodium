import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryJournalStore } from "@zcode/dynamic-workflow";
import { CoreErrorType } from "@zcode/contracts";
import { createDynamicWorkflowRunService } from "../src/app/dynamic-workflow-run-service.js";
import { prepareConversationSubagentSession } from "../src/app/conversation-session-workspace.js";

test(
  "workflow actor rehydration prepares its persisted cwd and rejects linked ancestors before runtime creation",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcodium-actor-restore-"));
    const runCwd = join(root, "2026-10-14", "a1b2c3d4");
    const actorCwd = join(root, "2026-10-13", "e1f2a3b4", "nested");
    await mkdir(runCwd, { recursive: true });
    const journal = new InMemoryJournalStore();
    let captured:
      | Parameters<Parameters<typeof createDynamicWorkflowRunService>[0]["createActorRuntime"]>[0]
      | undefined;
    let resumeCalled = false;
    let restored = false;
    let hasRow = true;
    const calls: boolean[] = [];
    const service = createDynamicWorkflowRunService({
      journal,
      parentSessionId: "parent",
      workspaceDirectory: root,
      fileSystemPort: {} as never,
      executionPort: {} as never,
      prepareActorSession: async (sessionId, workingDirectory, resumeFromStore) => {
        calls.push(resumeFromStore);
        await prepareConversationSubagentSession({
          sessionId,
          workingDirectory,
          resumeFromStore,
          conversationRoot: root,
          workspacePath: root,
          store: { getSession: async () => (hasRow ? { directory: root, path: actorCwd } : null) },
        });
      },
      createActorRuntime: (input) => {
        captured = input;
        if (!restored) throw new Error("fixture fresh boundary");
        return {
          getSessionModelSelection: () => ({ providerId: "fixture", modelId: "model" }),
          resumeFromStore: async () => {
            resumeCalled = true;
            if (!hasRow) throw { type: CoreErrorType.SessionNotFound };
            assert.equal((await stat(actorCwd)).isDirectory(), true);
            throw new Error("fixture restored boundary");
          },
          ensureSessionPersistedForExternalActivity: async () => {
            assert.equal((await stat(runCwd)).isDirectory(), true);
            throw new Error("fixture fresh fallback boundary");
          },
        } as never;
      },
    });
    try {
      const { runId } = await service.submit({
        scriptText: 'const worker = agent("worker"); return await worker.ask("fixture");',
        cwd: runCwd,
        parentSessionId: "parent",
        trace: {} as never,
      });
      await service.waitForTask(runId);
      assert.ok(captured);
      const actor = captured.actor;
      journal.putActor({
        ...(journal.getActor(runId, actor.siteId, actor.ordinal) ?? {
          runId,
          siteId: actor.siteId,
          ordinal: actor.ordinal,
        }),
        sessionId: captured.sessionId,
      });
      restored = true;
      const resume = async () => {
        journal.updateRunStatus(runId, "stopped", { stopReason: "user" });
        for (const node of journal.listNodes(runId))
          journal.putNode({ ...node, status: "running", error: undefined });
        assert.equal((await service.resume(runId)).ok, true);
        await service.waitForTask(runId);
      };
      await resume();
      assert.equal(resumeCalled, true);
      assert.equal((await stat(actorCwd)).isDirectory(), true);
      await rm(join(root, "2026-10-13"), { recursive: true });
      const outside = join(root, "outside");
      await mkdir(outside);
      await symlink(outside, join(root, "2026-10-13"));
      captured = undefined;
      resumeCalled = false;
      await resume();
      assert.equal(captured, undefined);
      assert.equal(resumeCalled, false);
      // 缺行恢复仍可进入原有 fresh fallback，但必须重新准备 run 的 cwd。
      hasRow = false;
      calls.length = 0;
      await resume();
      assert.deepEqual(calls, [true, false]);
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "fresh workflow actor receives the frozen run cwd on submit and another session's resume",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcodium-actor-cwd-"));
    const cwd = join(root, "first-session", "nested");
    await mkdir(cwd, { recursive: true });
    const journal = new InMemoryJournalStore();
    const captured: string[] = [];
    const makeService = (parentSessionId: string) =>
      createDynamicWorkflowRunService({
        journal,
        parentSessionId,
        workspaceDirectory: root,
        fileSystemPort: {} as never,
        executionPort: {} as never,
        createActorRuntime: (input) => {
          captured.push(input.cwd);
          // 到达真实 sandbox→driver→factory 边界即停止，不调用外部模型。
          throw new Error("fixture actor boundary reached");
        },
      });
    const first = makeService("first-session");
    const second = makeService("second-session");
    try {
      const { runId } = await first.submit({
        scriptText: 'const worker = agent("worker"); return await worker.ask("fixture");',
        cwd,
        parentSessionId: "first-session",
        trace: {} as never,
      });
      await first.waitForTask(runId);
      assert.deepEqual(captured, [cwd]);
      // 模拟终止后的冷续跑；新 app 的目录不同，run 的目录仍由 journal 所有。
      journal.updateRunStatus(runId, "stopped", { stopReason: "user" });
      for (const node of journal.listNodes(runId)) {
        journal.putNode({ ...node, status: "running", error: undefined });
      }
      const resumed = await second.resume(runId);
      assert.equal(resumed.ok, true);
      await second.waitForTask(runId);
      assert.deepEqual(captured, [cwd, cwd]);
    } finally {
      await first.close();
      await second.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
