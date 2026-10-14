import type { IServiceAccessor } from "@zcode/services";
import { describe, expect, it, vi } from "vitest";
import { resolveTaskExecutionWorkspacePath } from "@/lib/taskExecutionWorkspacePath.js";

const WORKSPACE_PATH = "/Users/me/.zcodium/workspace/default";
const TASK_ID = "sess_a1b2c3d4-0000-4000-8000-000000000000";
const TASK_PATH = `${WORKSPACE_PATH}/2026-10-11/a1b2c3d4`;
type PathServices = Pick<IServiceAccessor, "zcodeAgentService" | "zcodeSessionService">;

function createService(
  sessions: Array<{ sessionId: string; executionWorkspacePath?: string }>,
  readSession = vi.fn().mockRejectedValue(new Error("session not found")),
) {
  return {
    zcodeSessionService: { listSessions: vi.fn().mockResolvedValue(sessions) },
    zcodeAgentService: { readSession },
  } as unknown as PathServices;
}

describe("resolveTaskExecutionWorkspacePath", () => {
  it("reads the exact task including archived sessions and returns its execution path", async () => {
    const service = createService([{ sessionId: TASK_ID, executionWorkspacePath: TASK_PATH }]);

    await expect(
      resolveTaskExecutionWorkspacePath(service, {
        workspacePath: WORKSPACE_PATH,
        workspaceIdentity: "remote-workspace-1",
        remoteSessionId: "remote-session-1",
        sessionId: TASK_ID,
      }),
    ).resolves.toBe(TASK_PATH);
    expect(service.zcodeSessionService.listSessions).toHaveBeenCalledWith({
      workspacePath: WORKSPACE_PATH,
      workspaceIdentity: "remote-workspace-1",
      remoteSessionId: "remote-session-1",
      sessionIds: [TASK_ID],
      includeArchived: true,
    });
  });

  it("falls back to the workspace path only when the matching record has no execution path", async () => {
    const service = createService([{ sessionId: TASK_ID }]);

    await expect(
      resolveTaskExecutionWorkspacePath(service, {
        workspacePath: WORKSPACE_PATH,
        sessionId: TASK_ID,
      }),
    ).resolves.toBe(WORKSPACE_PATH);
  });

  it("uses a lease-matched path supplied by the active header without querying", async () => {
    const service = createService([]);

    await expect(
      resolveTaskExecutionWorkspacePath(service, {
        workspacePath: WORKSPACE_PATH,
        sessionId: TASK_ID,
        knownExecutionWorkspacePath: TASK_PATH,
      }),
    ).resolves.toBe(TASK_PATH);
    expect(service.zcodeSessionService.listSessions).not.toHaveBeenCalled();
  });

  it("queries the selected task when the header cwd is unresolved on first frame or task switch", async () => {
    const taskB = "sess_ffffffff-0000-4000-8000-000000000000";
    const taskBPath = `${WORKSPACE_PATH}/2026-10-10/ffffffff`;
    const service = createService([
      { sessionId: TASK_ID, executionWorkspacePath: TASK_PATH },
      { sessionId: taskB, executionWorkspacePath: taskBPath },
    ]);

    await expect(
      resolveTaskExecutionWorkspacePath(service, {
        workspacePath: WORKSPACE_PATH,
        sessionId: TASK_ID,
        knownExecutionWorkspacePath: null,
      }),
    ).resolves.toBe(TASK_PATH);
    await expect(
      resolveTaskExecutionWorkspacePath(service, {
        workspacePath: WORKSPACE_PATH,
        sessionId: taskB,
        knownExecutionWorkspacePath: null,
      }),
    ).resolves.toBe(taskBPath);
    expect(service.zcodeSessionService.listSessions).toHaveBeenNthCalledWith(2, {
      workspacePath: WORKSPACE_PATH,
      sessionIds: [taskB],
      includeArchived: true,
    });
  });

  it("does not borrow a path when the exact session is missing", async () => {
    const otherTaskId = "sess_other-0000-4000-8000-000000000000";
    const service = createService(
      [{ sessionId: otherTaskId, executionWorkspacePath: TASK_PATH }],
      vi.fn().mockResolvedValue({
        session: { sessionId: otherTaskId, executionWorkspacePath: TASK_PATH },
      }),
    );

    await expect(
      resolveTaskExecutionWorkspacePath(service, {
        workspacePath: WORKSPACE_PATH,
        sessionId: TASK_ID,
      }),
    ).resolves.toBeNull();
  });

  it("reads a deferred draft only from an existing runtime after list misses it", async () => {
    const readSession = vi.fn().mockResolvedValue({
      session: { sessionId: TASK_ID, executionWorkspacePath: TASK_PATH },
    });
    const service = createService([], readSession);

    await expect(
      resolveTaskExecutionWorkspacePath(service, {
        workspacePath: WORKSPACE_PATH,
        workspaceIdentity: "local-conversation",
        sessionId: TASK_ID,
      }),
    ).resolves.toBe(TASK_PATH);
    expect(readSession).toHaveBeenCalledWith({
      workspacePath: WORKSPACE_PATH,
      workspaceIdentity: "local-conversation",
      sessionId: TASK_ID,
      messageLimit: 1,
      runtimePolicy: "existing-only",
    });
  });

  it("falls back to the identity root only after existing-only read confirms the task", async () => {
    const readSession = vi.fn().mockResolvedValue({ session: { sessionId: TASK_ID } });
    const service = createService([], readSession);

    await expect(
      resolveTaskExecutionWorkspacePath(service, {
        workspacePath: WORKSPACE_PATH,
        sessionId: TASK_ID,
      }),
    ).resolves.toBe(WORKSPACE_PATH);
  });

  it("propagates lookup failures instead of falling back to the workspace path", async () => {
    const listSessions = vi.fn().mockRejectedValue(new Error("session query failed"));
    const service = {
      zcodeSessionService: { listSessions },
      zcodeAgentService: { readSession: vi.fn() },
    } as unknown as PathServices;

    await expect(
      resolveTaskExecutionWorkspacePath(service, {
        workspacePath: WORKSPACE_PATH,
        sessionId: TASK_ID,
      }),
    ).rejects.toThrow("session query failed");
  });

  it("does not fall back when existing-only read fails for a session missing from list", async () => {
    const readSession = vi.fn().mockRejectedValue(new Error("session runtime unavailable"));
    const service = createService([], readSession);

    await expect(
      resolveTaskExecutionWorkspacePath(service, {
        workspacePath: WORKSPACE_PATH,
        sessionId: TASK_ID,
      }),
    ).rejects.toThrow("session runtime unavailable");
    expect(readSession).toHaveBeenCalledWith({
      workspacePath: WORKSPACE_PATH,
      sessionId: TASK_ID,
      messageLimit: 1,
      runtimePolicy: "existing-only",
    });
  });
});
