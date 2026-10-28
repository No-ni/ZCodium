import { zcodeWorkspaceUpdateInteractionPreferencesParamsSchema } from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * 应用 workspace 交互偏好。CLI 进程按 workspace 隔离，因此 registry 是该 workspace
 * 内主任务、后台任务与子 Agent 共用的权威 gate。
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
