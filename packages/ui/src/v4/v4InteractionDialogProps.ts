import { type ZCodeProvider } from "@zcode/shared";
import type { ComposerScope } from "@/v4/composer/composerDraftStore.js";
import { type ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";

export interface V4InteractionDialogsProps {
  sessionId: string;
  workspacePath: string;
  /**
   * 权限弹窗里工具入参相对路径的解析/展示根 = 会话执行 cwd（模型写路径时的 cwd）。
   * 缺席时回落 `workspacePath`（改动前行为）。见
   * docs/specs/conversation-session-workspace.md 已知边界 12。
   */
  fileReferenceRootPath?: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  isWebRemoteControl?: boolean;
  provider?: ZCodeProvider;
  snapshot: ConversationSnapshot | null;
  onCommandSettled?: (commandId: string) => void;
  resolveRecentScope: (sessionId: string) => Promise<ComposerScope>;
  onPlanInteractionAccepted?: (interactionId: string) => void;
}
