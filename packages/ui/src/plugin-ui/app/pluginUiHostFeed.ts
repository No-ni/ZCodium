import type { CallToolResult } from "@modelcontextprotocol/client";
import type { PluginUiHostBridge } from "./pluginUiHostBridge.js";
import type {
  PluginUiHostControllerDeps,
  PluginUiToolFeed,
} from "./pluginUiHostControllerContract.js";
export function buildPluginUiBaseScope(deps: PluginUiHostControllerDeps) {
  return {
    workspacePath: deps.scope.workspacePath,
    ...(deps.scope.workspaceIdentity ? { workspaceIdentity: deps.scope.workspaceIdentity } : {}),
    sessionId: deps.scope.sessionId,
    pluginId: deps.presentation.pluginId,
    serverName: deps.presentation.serverName,
  };
}
export const sendFeed = (active: PluginUiHostBridge, feed: PluginUiToolFeed) => {
  if (feed.toolInput) void active.sendToolInput(feed.toolInput).catch(() => undefined);
  if (feed.toolCancelled) {
    void active.sendToolCancelled({}).catch(() => undefined);
  } else if (feed.toolResult) {
    void active.sendToolResult(feed.toolResult as CallToolResult).catch(() => undefined);
  }
};
