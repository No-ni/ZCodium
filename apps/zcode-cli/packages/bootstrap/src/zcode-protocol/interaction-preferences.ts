import { zcodeWorkspaceUpdateInteractionPreferencesParamsSchema } from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * 应用 Host 全局交互偏好。共享 CLI 内各工作区收到相同设置，registry 是进程内
 * 主任务、后台任务与子 Agent 共用的权威 gate；Host 按物理连接串行同步。
 */
export async function updateInteractionPreferences(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceUpdateInteractionPreferencesParamsSchema, rawParams);
  const enabled = params.preferences.askUserQuestionAutoResolutionEnabled;
  context.appRuntimePreferences.askUserQuestionAutoResolutionEnabled = enabled;
  const toolSearchMode = params.preferences.toolSearchMode;
  context.appRuntimePreferences.toolSearchMode = toolSearchMode;
  // 复用已持久化偏好的唯一注入命令；按 workspace key 隔离，不另建发现/权限状态。
  for (const record of context.sessions.values()) {
    if (record.workspace.workspaceKey !== params.workspace.workspaceKey) continue;
    record.app.runtime.updateConfig({ toolSearch: { mode: toolSearchMode } });
  }
  const snoozedInteractionCount =
    await context.v4Interactions.setAskUserQuestionAutoResolutionEnabled(enabled);

  return {
    workspace: params.workspace,
    askUserQuestionAutoResolutionEnabled: enabled,
    toolSearchMode,
    snoozedInteractionCount,
  };
}
