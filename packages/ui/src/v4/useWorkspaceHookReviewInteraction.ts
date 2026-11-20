import { useEffect } from "react";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { useWorkspaceHookReviewStore } from "@/store/workspaceHookReviewStore.js";
import type { useV4Conversation } from "./V4ConversationContext.js";
type Ports = {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  onCommandSettled?: (commandId: string) => void;
  sendCommand: ReturnType<typeof useV4Conversation>["sendCommand"];
  currentSnapshot: ConversationSnapshot | null;
};
// 仅连接现有 Hooks review store；通用交互窗不接管其状态或渲染。
export function useWorkspaceHookReviewInteraction({
  sessionId,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  onCommandSettled,
  sendCommand,
  currentSnapshot,
}: Ports) {
  const connectWorkspaceHookCommands = useWorkspaceHookReviewStore((state) => state.connect);
  const disconnectWorkspaceHookCommands = useWorkspaceHookReviewStore((state) => state.disconnect);
  const upsertWorkspaceHookReview = useWorkspaceHookReviewStore((state) => state.upsert);
  const clearWorkspaceHookReview = useWorkspaceHookReviewStore((state) => state.clear);
  const workspaceHookReview = currentSnapshot?.pendingInteractions.find(
    (interaction) => interaction.payload.kind === "workspaceHookReview",
  );
  useEffect(() => {
    connectWorkspaceHookCommands(sessionId, {
      sessionId,
      workspacePath,
      workspaceIdentity,
      remoteSessionId,
      sendCommand,
      onCommandSettled,
    });
    return () => disconnectWorkspaceHookCommands(sessionId, sendCommand);
  }, [
    connectWorkspaceHookCommands,
    disconnectWorkspaceHookCommands,
    onCommandSettled,
    sendCommand,
    sessionId,
    workspaceIdentity,
    remoteSessionId,
    workspacePath,
  ]);
  useEffect(() => {
    if (!workspaceHookReview || workspaceHookReview.payload.kind !== "workspaceHookReview") {
      clearWorkspaceHookReview(sessionId);
      return;
    }
    upsertWorkspaceHookReview(sessionId, {
      request: workspaceHookReview.payload,
      workspacePath,
      sendCommand,
      onCommandSettled,
    });
    // 软门禁：不再强制跳转 Settings/Hooks。
    // 用户通过 WorkspaceHookPendingIndicator 的 [去审核] 按钮主动打开 Hooks 设置。
  }, [
    clearWorkspaceHookReview,
    onCommandSettled,
    sendCommand,
    sessionId,
    upsertWorkspaceHookReview,
    workspaceHookReview,
    workspacePath,
  ]);
}
