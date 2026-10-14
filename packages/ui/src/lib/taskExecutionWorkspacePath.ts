import type { IServiceAccessor, ZCodeSessionWorkspaceTarget } from "@zcode/services";
import { resolveEffectiveWorkspacePath } from "@/v4/sessionWorkspacePath.js";

type TaskExecutionWorkspacePathServices = Pick<
  IServiceAccessor,
  "zcodeAgentService" | "zcodeSessionService"
>;

export async function resolveTaskExecutionWorkspacePath(
  service: TaskExecutionWorkspacePathServices,
  target: ZCodeSessionWorkspaceTarget & {
    sessionId: string;
    knownExecutionWorkspacePath?: string | null;
  },
): Promise<string | null> {
  const knownPath = target.knownExecutionWorkspacePath?.trim();
  if (knownPath) {
    return knownPath;
  }

  const sessions = await service.zcodeSessionService.listSessions({
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
    ...(target.remoteSessionId ? { remoteSessionId: target.remoteSessionId } : {}),
    sessionIds: [target.sessionId],
    includeArchived: true,
  });
  const session = sessions.find((item) => item.sessionId === target.sessionId);
  if (session) {
    return resolveEffectiveWorkspacePath(
      session.executionWorkspacePath ?? null,
      target.workspacePath,
    );
  }

  const snapshot = await service.zcodeAgentService.readSession({
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
    ...(target.remoteSessionId ? { remoteSessionId: target.remoteSessionId } : {}),
    sessionId: target.sessionId,
    messageLimit: 1,
    runtimePolicy: "existing-only",
  });
  if (snapshot.session.sessionId !== target.sessionId) {
    return null;
  }
  return resolveEffectiveWorkspacePath(
    snapshot.session.executionWorkspacePath ?? null,
    target.workspacePath,
  );
}
