import { useRemoteConversationAvailable } from "@/v4/RemoteConversationAvailability.js";
import type { ComposerDraftContent } from "@/v4/composer/useDraftConfigControl.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import {
  subscribeComposerSubmissionSettled,
  trackUnsettledComposerSubmission,
} from "@/v4/composer/composerSubmissionSettlement.js";
import { recordChatError } from "@/lib/diagnostics/chatErrors.js";
import type { ConversationTurnWorkStatus } from "@/v4/conversationTurnWorkSegments.js";
import { ConversationWorkingPlaceholder } from "@/components/ai-elements/chat-loading.js";
import type { LocalTtftContext } from "@zcode/shared";
/* oxlint-disable eslint(max-lines) -- composer 集中收口输入区 wiring（附件/草稿/历史/mention），拆分会打散收口粒度。 */
import { getLocalTtftObserver } from "@/v4/diagnostics/local-ttft/localTtftObserver.js";
/**
 * v4 会话 composer（composer parity）。
 *
 * 壳：ChatPromptEditor（Lexical 编辑器 + 动作菜单 + 拖拽反馈 + sticky 底座视觉），
 * 附件预览网格/大图预览/错误提示区一并提供。
 *
 * 芯：全新 v4 wiring——
 * - 路由/状态一律读 v4 投影 snapshot.inputRouting / control / config / usage；
 * - 发送键状态机对齐旧 UI：canSend（有文本或附件+路由允许）/ pending spinner /
 *   running+空草稿 → Stop（v4 stop 命令）/ 暂停队列（choice）→ 发送后弹清空/保留确认框；
 * - 附件全链路见 useComposerAttachments（发送经 v4 sendText attachments）；
 * - mention（@ 文件/画板、# 会话、$ 技能）与 slash 目录全集在 LexicalChatInput 内接线；
 * - 草稿 per-session 持久化（composerDraftStore）+ prompt history（promptHistoryStorage）；
 * - 工具条（模型/思考深度/模式/context usage）见 V4ComposerToolbar。
 */
import {
  memo,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { cn } from "@/components/lib/utils.js";
import {
  TID_CHAT_ATTACHMENT_BUTTON,
  TID_CHAT_ATTACHMENT_MENU_ITEM,
  TID_V4_COMPOSER,
  TID_V4_COMPOSER_CLEAR_QUEUE_SEND,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_KEEP_QUEUE_SEND,
  TID_V4_COMPOSER_SEND,
  TID_V4_PAUSED_QUEUE_SEND_DIALOG,
  TID_V4_ATTACHMENT,
  TID_V4_ATTACHMENT_UPLOAD_PROGRESS,
  TID_V4_ATTACHMENT_UPLOAD_RETRY,
  TID_V4_STOP,
  testId,
  type ZCodeProvider,
} from "@zcode/shared";
import type {
  AttachmentRef,
  ConversationSnapshot,
  SessionConfigState,
} from "@zcode/shared/zcode-protocol-v4";
import {
  ArrowUpIcon,
  ClipboardPenLineIcon,
  InfoIcon,
  RotateCcwIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { ChatErrorBanner, shouldSuppressChatErrorBanner } from "@/ChatErrorBanner.js";
import {
  Attachment,
  Attachments,
  AttachmentInfo,
  AttachmentPreview,
} from "@/components/ai-elements/attachments.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Spinner } from "@/components/ui/spinner.js";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import {
  ChatMediaAttachmentPreviewDialog,
  type ChatMediaAttachmentPreviewTarget,
} from "@/ChatMediaAttachmentPreviewDialog.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { ChatPromptEditor } from "@/prompt-editor/ChatPromptEditor.js";
import { usePromptEditorDragState } from "@/prompt-editor/usePromptEditorDragState.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { advanceComposerDraftRevision } from "@/v4/composer/composerDraftRevision.js";
import type { AppSlashCommand } from "@/slashCommandHelpers.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import {
  isImageChatComposerAttachment,
  isPdfChatComposerAttachment,
  isMediaChatComposerAttachment,
  isVideoChatComposerAttachment,
  type ChatComposerAttachment,
} from "@/lib/chatAttachments.js";
import { resolveChatPlaceholderKey } from "@/lib/chatPlaceholder.js";
import { resolveChatEnterShortcut, useIsMobileTextInputViewport } from "@/lib/mobileTextInput.js";
import { appendPromptHistoryEntry } from "@/lib/promptHistory.js";
import {
  persistPromptHistoryEntries,
  readPromptHistoryEntries,
} from "@/lib/promptHistoryStorage.js";
import {
  WORKSPACE_FILE_ADD_TO_CHAT_EVENT,
  readWorkspaceFileDragPayload,
  isWorkspaceFileAddToChatEvent,
} from "@/lib/workspaceFileDrag.js";
import { appendWorkspaceFileMentionToComposer } from "@/lib/workspaceFileComposer.js";

import type { ModelSelectionView } from "@zcode/services";
import type { ModelSelectionState } from "@/hooks/useModelSelectionView.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import {
  resolveComposerAutoFocus,
  type ComposerAutoFocusOptions,
} from "@/v4/composer/composerAutoFocus.js";
import { V4_DRAFT_SCOPE_ROOT, type V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import type { ComposerSubmissionDraftTransaction } from "@/v4/composer/useDraftConfigControl.js";
import {
  resolveOppositeFollowupDelivery,
  resolveFollowupModifierTooltip,
  shouldEnableModifiedEnterSubmit,
  shouldReverseFollowupDeliveryForPointer,
} from "@/v4/composer/followupModeSettings.js";
import { isAppleKeyboardPlatform } from "@/lib/keyboardShortcuts.js";
import { usePrimaryFollowupModifier } from "@/v4/composer/usePrimaryFollowupModifier.js";
import { consumeV4ComposerDraftWorkspaceTransferRequest } from "@/v4/composer/composerDraftWorkspaceTransfer.js";
import {
  buildScopeKey as buildComposerAttachmentScopeKey,
  useComposerAttachments,
} from "@/v4/composer/useComposerAttachments.js";
import { isComposerEditScopeId } from "@/composer-edit-mode/contract.js";
import {
  type RegisterConversationDropTarget,
  type ConversationDropTargetController,
} from "@/v4/composer/conversationDropTarget.js";
import { CodeCommentAttachmentChip } from "@/v4/composer/CodeCommentAttachmentChip.js";
import { removeCodeCommentPreview } from "@/v4/composer/codeCommentPreviewSync.js";
import {
  countComposerPromptContexts,
  serializeComposerPromptContexts,
} from "@/v4/composer/composerPromptContexts.js";
import { useCodeCommentContexts } from "@/v4/composer/useCodeCommentContexts.js";
import { useWebElementContexts } from "@/v4/composer/useWebElementContexts.js";
import {
  webElementScreenshotFiles,
  type WebElementContextComposerAttachment,
} from "@/lib/webElementContext.js";
import {
  PluginUiModelContextChip,
  type ContextImageAttachmentsOptions,
  useContextImageAttachments,
  usePluginUiContextImages,
  usePluginUiModelContexts,
} from "@/plugin-ui/index.js";
import { usePptxElementReferences } from "@/v4/composer/usePptxElementReferences.js";
import { PptxElementReferenceChip } from "@/v4/composer/PptxElementReferenceChip.js";
import { useOpenPptxElementReference } from "@/v4/composer/useOpenPptxElementReference.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { useConversationSelectionReferences } from "@/v4/composer/useConversationSelectionReferences.js";
import {
  dispatchConversationSelectionEdit,
  recordSentConversationSelections,
} from "@/lib/conversationSelectionReference.js";
import { deleteConversationAnnotationWithUndo } from "@/selection-comment/index.js";
import { ConversationBackgroundWorkTrigger } from "@/v4/composer/ConversationBackgroundWorkTrigger.js";
import { V4ComposerCuaEntry } from "@/v4/composer/V4ComposerCuaEntry.js";
import {
  V4ComposerModeSwitch,
  V4ComposerModelControls,
  type ModelSelectionSource,
} from "@/v4/composer/V4ComposerToolbar.js";
import { ComposerStatusSlot } from "@/extension-slots/index.js";
import {
  resolveV4ComposerConfigPickerState,
  type V4ComposerConfigPicker,
} from "@/v4/composer/configPickerState.js";
import { WebElementContextAttachmentChip } from "@/v4/composer/WebElementContextAttachmentChip.js";
import { ElementMentionSyncPlugin } from "@/v4/composer/ElementMentionSyncPlugin.js";
import { ConversationSelectionReferenceChip } from "@/v4/composer/ConversationSelectionReferenceChip.js";
import type { AttachmentPutFn } from "@/v4/composer/attachmentUpload.js";

import type { ComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";

import { resolveAttachableShareContext } from "@/lib/conversationShareContext.js";

const MODEL_SELECTION_LOADING_STATE: ModelSelectionState = { status: "loading" };

export interface ConversationComposerSendOptions {
  /** 点击发送时复制的配置；null 表示未完成选择，Host 不得从 Session 补齐。 */
  submission?: ComposerSubmissionConfig | null;
  heldQueueDisposition?: "clearQueueAndSend" | "keepQueueAndSend";
  /** 发送确认框打开时看到的暂停队列 ID；CLI 用它拦截跨端增删竞态。 */
  expectedHeldQueueItemIds?: readonly string[];
  /** 附件命令面：已序列化附件（宿主转 AttachmentRef 后随 v4 sendText/createSession 发送）。 */
  attachments?: AttachmentRef[];
  /** Prompt 文本内携带的上下文附件数量；用于阻止 /goal 等本地命令误消费。 */
  contextAttachmentCount?: number;
  /** renderer-only：ACK accepted 后由 SessionPane 绑定真实 commandId/sessionId。 */
  localTtft?: LocalTtftContext;
  /** 工作树首发观察原创建 owner 的终态；普通命令沿用 registry。 */
  onCommandCreated?: (
    commandId: string,
    observeResolution?: (
      listener: (resolution: "authoritative" | "failed", sessionId?: string) => void,
    ) => () => void,
  ) => void;
  conversationQuotes?: NonNullable<
    import("@zcode/shared/zcode-protocol-v4").UserInputRow["conversationQuotes"]
  >;
  /** 本次 busy input 的一次性投递覆盖，不改 session 偏好。 */
  requestedDelivery?: "startNow" | "queue" | "guide";
  sharedContextRefs?: Array<{ kind: "shared_context_import"; context_id: string }>;
  /** 插件 UI 代发：随 sendText 持久化，用户消息卡片显示"来自插件 X"。 */
  source?: import("@zcode/shared/zcode-protocol-v4").ConversationInputSource;
}

export type ConversationComposerSendResult =
  | "sent"
  | "pending"
  | "blocked"
  | "confirmationRequired";

type ComposerSubmit = (
  heldQueueDisposition?: "clearQueueAndSend" | "keepQueueAndSend",
  expectedHeldQueueItemIds?: readonly string[],
  existingLocalTtft?: LocalTtftContext,
  requestedDelivery?: "startNow" | "queue" | "guide",
) => Promise<void>;
function getComposerAttachmentTypeLabel(filename: string, mimeType: string): string {
  const leaf = filename.split(/[\\/]/u).at(-1) ?? filename;
  const dotIndex = leaf.lastIndexOf(".");
  if (dotIndex > 0 && dotIndex < leaf.length - 1) {
    return leaf.slice(dotIndex + 1).toUpperCase();
  }
  return (mimeType.split("/").at(-1) ?? mimeType).toUpperCase();
}

interface ExternalTextInsertRequest {
  requestId: number;
  text: string;
  mention?: ComposerMentionPrefill;
  mode?: "replace" | "prepend-if-missing";
}

function restorePersistedComposerDraftIntoInput({
  draft,
  inputApi,
  onEditorStateError,
}: {
  draft: Pick<V4ComposerDraft, "editorStateJson" | "mention" | "text">;
  inputApi: Pick<
    LexicalChatInputHandle,
    "getMarkdown" | "setEditorStateJson" | "setMention" | "setText"
  >;
  onEditorStateError?: (error: unknown) => void;
}): string {
  if (draft.editorStateJson) {
    try {
      inputApi.setEditorStateJson(draft.editorStateJson);
      return inputApi.getMarkdown();
    } catch (error) {
      onEditorStateError?.(error);
    }
  }
  if (draft.mention && draft.text.startsWith(draft.mention.markdown)) {
    // Workspace 插件详情会卸载聊天 Composer。结构化 mention 必须从共享草稿事实源恢复，
    // 不能只依赖一次性插入事件，否则重挂载时会退化成 canonical 普通文本。
    inputApi.setMention(draft.mention, draft.text.slice(draft.mention.markdown.length));
    return draft.text;
  }
  inputApi.setText(draft.text);
  return draft.text;
}

function applyExternalTextInsertRequestToComposer({
  appliedRequestId,
  inputApi,
  request,
  requestFocus,
  scheduleDraftPersist,
  updateText,
}: {
  appliedRequestId: number | null;
  inputApi: Pick<
    LexicalChatInputHandle,
    | "getMarkdown"
    | "prependMentionIfMissing"
    | "setMention"
    | "setText"
    | "setTextWithPluginMentions"
  > | null;
  request: ExternalTextInsertRequest | null | undefined;
  requestFocus: () => void;
  scheduleDraftPersist: () => void;
  updateText: (text: string) => void;
}): number | null {
  if (!request || request.requestId === appliedRequestId) {
    return appliedRequestId;
  }
  if (!inputApi) {
    return appliedRequestId;
  }
  if (request.mode === "prepend-if-missing" && request.mention) {
    if (!inputApi.prependMentionIfMissing(request.mention)) {
      return request.requestId;
    }
    // Bug 原因：安装完成后若回放点击时保存的旧 prompt，会覆盖用户安装期间的编辑。
    // 节点级前置保留编辑器当前的 mention 与段落结构，再从编辑器读取 canonical 草稿。
    updateText(inputApi.getMarkdown());
    scheduleDraftPersist();
    requestFocus();
    return request.requestId;
  }
  if (request.mention && request.text.startsWith(request.mention.markdown)) {
    // 根因：商店试用以前只传 canonical 文本，Lexical 无法知道开头链接是结构化 Plugin mention。
    // request 同时携带 display-only 节点数据；发送与草稿事实源仍使用 request.text 原文。
    inputApi.setMention(request.mention, request.text.slice(request.mention.markdown.length));
  } else if (request.text.includes("](plugin://")) {
    // 推荐任务可在正文中组合多个插件；按原位置构造成真实提及节点。
    inputApi.setTextWithPluginMentions(request.text);
  } else {
    inputApi.setText(request.text);
  }
  updateText(request.text);
  scheduleDraftPersist();
  requestFocus();
  return request.requestId;
}

export interface ComposerRestoreRequest {
  requestId: number;
  sessionId: string;
  workspaceKey: string;
  inputKind: "sendText" | "sendGoalCommand";
  text: string;
  attachments: readonly AttachmentRef[];
  config?: Pick<V4ComposerDraft, "mode" | "planEnabled" | "modelSelection">;
}

function arePromptHistoryEntriesEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

interface ConversationComposerProps {
  snapshot: ConversationSnapshot | null;
  /** 草稿 scope（sessionId；draft 态 null → "__draft__" scope）。 */
  sessionId?: string | null;
  /** Skill catalog authority；草稿预热完成后为 prewarmSessionId，不改变 task/draft 身份。 */
  skillCatalogSessionId?: string | null;
  pluginUiSessionId?: string | null;
  /** draft 态无 snapshot，但仍可 createSession 首发。 */
  draftMode?: boolean;
  /** renderer 当前草稿配置意图；只在 draftMode 下覆盖迟到的 prewarm projection。 */
  draftConfig?: Partial<SessionConfigState>;
  /** SessionPane 注入的完整 Draft owner；生产路径不再由编辑器直接覆盖持久记录。 */
  composerDraft: V4ComposerDraft;
  rootDraftScopeKey?: string;
  composerDraftScopeToken: symbol;
  captureComposerSubmissionDraftTransaction: (
    content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">,
  ) => ComposerSubmissionDraftTransaction;
  stageComposerContent: (content: ComposerDraftContent) => void;
  persistComposerContent: (content: ComposerDraftContent) => void;
  captureComposerContentLifecycleCommit: () => (content: ComposerDraftContent) => void;
  updateComposerContent: (
    content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">,
  ) => void;
  replaceComposerDraft: (draft: Omit<V4ComposerDraft, "updatedAt">) => void;
  /** 当前 Composer 是否能构造完整 Submission；空模型或空 Reasoning 时为 false。 */
  submissionReady?: boolean;
  createSubmissionFromComposer?: () => ComposerSubmissionConfig | null;

  /**
   * 空态 contextHeader（m5-composer-parity）：workspace 切换菜单 + Git 分支
   * 切换器，渲染在编辑器上方（旧 ChatViewComposer contextHeaderContent 同位）。
   * 仅草稿态由宿主下发；会话建立后为空。
   */
  contextHeader?: ReactNode;
  /** Host admission 的提醒动作；追加在权限选择之后，不持有信任事实。 */
  leadingActionsNode?: ReactNode;
  /** 居中草稿布局（旧 shouldUseCenteredDraftChatLayout）：收窄 max-w-2xl、去 sticky。 */
  centered?: boolean;
  floating?: boolean;
  workingStatus?: ConversationTurnWorkStatus;
  /**
   * v4 bottom dock 阻塞交互 id。存在时 composer 只隐藏不卸载，保留草稿、附件与编辑器实例。
   */
  blockingRequestId?: string | null;
  disabled?: boolean;
  onRetryInitialization?: () => void;
  onRetryError?: () => void;
  modelSelectionPending?: boolean;
  /**
   * 是否在新建任务 / 切换会话 / 挂载后自动把光标聚焦到输入框（默认开）。
   * 竖切多 pane 时由宿主传入 SessionPane.focused，仅焦点 pane 聚焦、后台 pane 不抢焦点。
   */
  autoFocusEnabled?: boolean;
  /** 当前 composer 是否运行在手机 Web 远控壳中。 */
  isWebRemoteControl?: boolean;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 文件 mention / + 菜单文件列表的搜索根（会话执行 cwd）；缺省 = `workspacePath`。 */
  fileSearchRootPath?: string;
  /**
   * `fileSearchRootPath` 是否已由会话事实解析出来（缺省 true = 改动前行为）：false ⇒ 提及
   * 一律投绝对路径。判据与理由见 `resolvePaneFileSearchRoot` 与 spec 已知边界 14。
   */
  fileReferenceRootResolved?: boolean;
  remoteSessionId?: string;
  /** SessionPane 从目标 Host 原子读取的选择事实；Composer 不自行解析 Host。 */
  modelSelectionView?: ModelSelectionView | null;
  modelSelectionState?: ModelSelectionState;
  /** Model Selection 首次读取失败后的显式重试入口。 */
  modelSelectionReload?: () => void;
  /** 草稿态使用预热 session 作附件 transaction 载体。 */
  attachmentSessionId?: string | null;
  attachmentPut: AttachmentPutFn;
  onRuntimeRestart?: (listener: () => void) => () => void;
  /** 承载 transport 暴露 runtime 存活态时优先用它，替代 onRuntimeRestart。 */
  onRuntimeLifecycle?: (listener: (state: "available" | "unavailable") => void) => () => void;
  provider?: ZCodeProvider;

  onSendText: (
    text: string,
    options?: ConversationComposerSendOptions,
  ) => Promise<ConversationComposerSendResult | void>;
  /** 把当前输入文本上抛给父组件（editUserQuery 用 composer 文本作 newText）。 */
  onTextChange?: (text: string) => void;
  /** queue 撤回 admission 读取的完整 composer 占用态；附件包含上传中状态。 */
  onDraftStateChange?: (state: { hasContent: boolean; busy: boolean }) => void;
  onStop: () => void;
  /** 目录选中模型（providerId/modelId）；thought/revision 由宿主从最新投影补齐。 */
  onSelectModel: (
    provider: string,
    model: string,
    sourceModel: ModelSelectionSource | null,
    reasoningLevel?: string,
  ) => void | Promise<void>;
  /** 选中思考深度；同时带上用户操作时看到的模型，避免异步回流后把 thought 归到另一模型。 */
  onSelectThought: (thought: string, modelContext: { provider: string; model: string }) => void;
  onSwitchMode: (mode: string) => void;
  /** 打开当前 session 的 Status panel，并直达 Running 明细。 */
  onOpenRunningBackgroundWorks?: () => void;
  /**
   * 后台任务入口点击的落点：`"workflow-run"` = 唯一在跑的工作流直达详情页（宿主判定），
   * 缺省 `"panel"` = 展开状态胶囊。入口据此换 tooltip；行为本身在 onOpenRunningBackgroundWorks 里。
   */
  backgroundWorkOpenTarget?: "panel" | "workflow-run";
  runningSubagentCount?: number;
  /** prepare/configOptions 失败时，custom provider 选择走 workspace recovery 链。 */
  onRecoverCustomModelSelection?: (
    value: string,
    sourceModel: ModelSelectionSource | null,
  ) => Promise<void> | void;
  /** context usage 面板的 /compact 入口（宿主走 v4 compact 命令）。 */
  onSendCompressionCommand?: (command: string) => void;
  /** v4 会话级错误（snapshot.control.lastError），展示在输入框上方。 */
  error?: ZCodeUiError | null;
  onDismissError?: () => void;
  /** 无可用模型横幅的恢复动作；由 SessionPane 注入壳层导航，组件不直接操作 tab。 */
  onOpenModelSettings?: () => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  /**
   * 是否监听全局「加入对话」事件（workspace file tree / 画板按钮）。
   * 分屏时仅 primary pane 监听，避免一次点击插入两份。
   */
  listenAddToChatEvents?: boolean;
  /**
   * 外部一次性文本预填请求（Example Prompt 等）。
   * requestId 保证同一文本可连续取回两次时仍能触发回填。
   */
  externalTextInsertRequest?: ExternalTextInsertRequest | null;
  onExternalTextInsertApplied?: (requestId: number) => void;
  /**
   * composer 编辑态（docs/ui/composer-edit-mode.md）：草稿切到 edit scope，原草稿留在原 scope；
   * 退出编辑态只需切回，即可完整恢复原草稿。缺省 = sessionId 对应的普通 scope。
   */
  draftScopeId?: string;
  /** 当前会话 CLI 支持注释评论时，注释列表提供“编辑/添加评论”入口（在正文编号处打开编辑浮层）。 */
  selectionCommentEnabled?: boolean;
  /** 编辑态状态条，渲染在输入框卡片内顶部。 */
  editBar?: ReactNode;
  /** 点击原消息位置的「正在下方编辑」占位时递增：只聚焦输入框，不滚动。 */
  editFocusRequest?: number;
  /** 状态条的「对话 + 文件重置」等编辑态动作递增：按当前内容走同一提交流程。 */
  editSubmitRequest?: number;
  /**
   * 一次提交已被接纳且附件已移交、草稿已结算后回调（scopeId = 提交时的草稿 scope）。
   * composer 编辑态据此退出：必须晚于附件 adopt，否则切回原 scope 会把新附件当未发送清理。
   */
  onSubmissionSettled?: (scopeId: string) => void;
  /** 副屏会话不提供 goal 能力；协议层仍会拒绝直接调用。 */
  suppressGoalCommands?: boolean;
  /** App 层本地斜杠命令（如 `/side`），由 SessionPane 按门禁组装后透传。 */
  appSlashCommands?: readonly AppSlashCommand[];
  /** 把 composer 的 drop 路由暴露给整个对话 pane / 桌面草稿标题栏。 */
  onDropTargetControllerChange?: RegisterConversationDropTarget;
}

function formatAttachmentLineCount(attachment: ChatComposerAttachment, locale: string): string {
  const formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  return formatter.format(typeof attachment.lineCount === "number" ? attachment.lineCount : 0);
}

const WEB_ELEMENT_CONTEXT_IMAGE_OPTIONS: ContextImageAttachmentsOptions<WebElementContextComposerAttachment> =
  { toFiles: webElementScreenshotFiles, removeStrategy: "attached" };

function ConversationComposerImpl({
  snapshot,
  sessionId = null,
  skillCatalogSessionId = sessionId,
  pluginUiSessionId = sessionId,
  draftMode = false,
  draftConfig,
  composerDraft,
  composerDraftScopeToken,
  rootDraftScopeKey,
  captureComposerSubmissionDraftTransaction,
  updateComposerContent,
  replaceComposerDraft,
  submissionReady = true,
  createSubmissionFromComposer,
  contextHeader,
  leadingActionsNode: admissionActionsNode,
  centered = false,
  floating = false,
  workingStatus,
  blockingRequestId = null,
  disabled: disabledProp = false,
  modelSelectionPending = false,
  autoFocusEnabled = true,
  workspacePath,
  workspaceIdentity,
  isWebRemoteControl = false,
  fileSearchRootPath,
  fileReferenceRootResolved = true,
  remoteSessionId,
  modelSelectionView = null,
  modelSelectionState = MODEL_SELECTION_LOADING_STATE,
  modelSelectionReload,
  attachmentSessionId = null,
  attachmentPut,
  onRuntimeRestart,
  onRuntimeLifecycle,
  provider,
  onSendText,
  onTextChange,
  onDraftStateChange,
  onStop,
  onSelectModel,
  onSelectThought,
  onSwitchMode,
  onOpenRunningBackgroundWorks,
  backgroundWorkOpenTarget = "panel",
  runningSubagentCount = 0,
  onRecoverCustomModelSelection,
  onSendCompressionCommand,
  error,
  onDismissError,
  onOpenModelSettings,
  onOpenCodeViewer,
  listenAddToChatEvents = true,
  externalTextInsertRequest = null,
  onExternalTextInsertApplied,
  draftScopeId: draftScopeIdProp,
  selectionCommentEnabled = false,
  editBar,
  editFocusRequest = 0,
  editSubmitRequest = 0,
  onSubmissionSettled,
  suppressGoalCommands = false,
  appSlashCommands,
  onDropTargetControllerChange,
}: ConversationComposerProps) {
  const remoteAvailable = useRemoteConversationAvailable();
  const disabled = disabledProp || !remoteAvailable;
  const initialization = snapshot?.runtimeInitialization;
  const runtimeBlocked = initialization !== undefined && initialization.status !== "ready";
  const { intl, locale } = useZCodeIntl();
  const services = useOptionalServices();
  const isMobileTextInputViewport = useIsMobileTextInputViewport();
  const draftScopeId =
    draftScopeIdProp ??
    sessionId ??
    (rootDraftScopeKey ? `${V4_DRAFT_SCOPE_ROOT}:${rootDraftScopeKey}` : V4_DRAFT_SCOPE_ROOT);
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const configPickerScopeKey = `${workspaceKey}\0${draftScopeId}`;
  const [text, setText] = useState("");
  const reloadText = text.trim() === "/reload";
  const [pendingSubmission, setPendingSubmission] = useState<{ scopeToken: symbol } | null>(null);
  const pending = pendingSubmission?.scopeToken === composerDraftScopeToken;
  const [configPickerState, setConfigPickerState] = useState<{
    scopeKey: string;
    activePicker: V4ComposerConfigPicker | null;
  }>(() => ({ scopeKey: configPickerScopeKey, activePicker: null }));
  // 固定 key 的 SessionPane 会跨 task/draft 复用 composer，旧 picker owner
  // 因此跟着实例进入新 scope。提交新 scope portal 前同步归零，避免菜单闪现一帧；
  // 旧 Radix layer 随后到达的 close 事件由下方 scope guard 丢弃。
  if (configPickerState.scopeKey !== configPickerScopeKey) {
    setConfigPickerState({ scopeKey: configPickerScopeKey, activePicker: null });
  }
  const activeConfigPicker =
    configPickerState.scopeKey === configPickerScopeKey ? configPickerState.activePicker : null;
  const handleConfigPickerOpenChange = useCallback(
    (picker: V4ComposerConfigPicker, open: boolean) => {
      // composer 内容为导航 rail 恢复 pointer-events 后，三个 Radix modal
      // picker 的独立 open 状态会在同一次 pointerdown 中竞争，旧 layer 无法可靠 dismiss。
      // 关闭回调可能晚于兄弟 picker 的打开回调，只允许它清理自己，避免误关接管者。
      setConfigPickerState((current) => {
        if (current.scopeKey !== configPickerScopeKey) {
          return current;
        }
        return {
          scopeKey: current.scopeKey,
          activePicker: resolveV4ComposerConfigPickerState(current.activePicker, picker, open),
        };
      });
    },
    [configPickerScopeKey],
  );
  const [heldQueueConfirmationState, setHeldQueueConfirmation] = useState<{
    scopeToken: symbol;
    queueItemIds: readonly string[];
    localTtft?: LocalTtftContext;
    requestedDelivery?: "startNow" | "queue" | "guide";
  } | null>(null);
  const heldQueueConfirmation =
    heldQueueConfirmationState?.scopeToken === composerDraftScopeToken
      ? heldQueueConfirmationState
      : null;
  const [sendTooltipOpen, setSendTooltipOpen] = useState(false);
  // submit 经 ref 读取最新文本/pending，避免回调随每次输入变更引用。
  const textRef = useRef("");
  const contentRevisionRef = useRef(0);
  const pendingRef = useRef<typeof pendingSubmission>(null);
  const composerDraftScopeTokenRef = useRef(composerDraftScopeToken);
  composerDraftScopeTokenRef.current = composerDraftScopeToken;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  // 指向最新渲染的 submit；延迟操作只在同一提交 owner 中重新读取可发送状态。
  const latestSubmitRef = useRef<ComposerSubmit | null>(null);
  // 这条线断过一次：composer 原本读一个平行的 sharedContextImport prop，而 SessionPane 从没
  // 传过它（全仓 `sharedContextImport=` 零命中），于是首条消息永远不带 sharedContextRefs。
  // 现在从必然拿到的 snapshot 推导，理由与边界见 resolveAttachableShareContext。
  const activeShareContext = resolveAttachableShareContext(snapshot?.sharedContextImport);
  const pendingShareContext = activeShareContext?.status === "pending" ? activeShareContext : null;
  const inputApiRef = useRef<LexicalChatInputHandle | null>(null);
  const composerMountedRef = useRef(true);
  useEffect(() => {
    composerMountedRef.current = true;
    return () => {
      composerMountedRef.current = false;
    };
  }, []);
  const commandResolutionCleanupsRef = useRef(new Set<() => void>());
  useEffect(
    () => () => {
      for (const cleanup of commandResolutionCleanupsRef.current) cleanup();
      commandResolutionCleanupsRef.current.clear();
    },
    [],
  );

  const primaryModifierPressed = usePrimaryFollowupModifier();
  const appleKeyboardPlatform = isAppleKeyboardPlatform();
  const enterSubmits = true;
  const sendShortcut = resolveChatEnterShortcut({ enterSubmits });
  const updateText = useCallback(
    (next: string) => {
      textRef.current = next;
      contentRevisionRef.current += 1;
      advanceComposerDraftRevision(workspacePath, workspaceIdentity);
      setText(next);
      onTextChange?.(next);
    },
    [onTextChange, workspaceIdentity, workspacePath],
  );

  // ── 附件全链路（选择/粘贴/拖拽/画板/预传/门禁）──
  const attachmentsApi = useComposerAttachments({
    submissionOwner: composerDraftScopeToken,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    scopeId: draftScopeId,
    attachmentSessionId,
    attachmentPut,
    onRuntimeRestart,
    onRuntimeLifecycle,
    disabled,
    listenAddToChatEvents: listenAddToChatEvents && !disabled,
  });
  const {
    handleDragOverComposer,
    handleDragLeaveComposer,
    handleDropComposer,
    openAttachmentPicker,
  } = attachmentsApi;
  // 对齐旧版 useChatComposer：窗口级 dragover 会在指针进入 ChatView 前预先点亮
  // 整个聊天区与桌面草稿标题栏；workspace payload 的文案优先于系统附件。
  const { externalFileDragging, workspaceFileDragging } = usePromptEditorDragState({
    enableExternalFileDrop: true,
    enableWorkspaceFileDrop: true,
  });
  const handleConversationDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      handleDragOverComposer(event);
    },
    [handleDragOverComposer],
  );
  const handleConversationDragLeave = useCallback(
    (event: DragEvent<HTMLElement>) => {
      handleDragLeaveComposer(event);
    },
    [handleDragLeaveComposer],
  );
  const handleConversationDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      const workspaceFilePayload = readWorkspaceFileDragPayload(event.dataTransfer);
      if (workspaceFilePayload) {
        // 文件树 payload 与 OS File[] 语义不同：只插入 mention，绝不能进入上传队列。
        event.preventDefault();
        handleDropComposer(event);
        appendWorkspaceFileMentionToComposer({
          inputApiRef,
          currentMarkdown: inputApiRef.current?.getMarkdown() ?? textRef.current,
          payload: workspaceFilePayload,
          workspacePath,
          workspaceIdentity,
          // 本 composer 的解析根：会话已绑定时是会话执行 cwd（`fileSearchRootPath`），
          // 缺席时由 createWorkspaceFileComposerMention 回落 workspacePath。
          fileReferenceRootPath: fileSearchRootPath,
          // 解析根还没被会话事实证明（草稿态预热未就绪 / 首帧身份不匹配）时投绝对路径：
          // 首发会话的执行目录还没铸出来，相对路径会被它按自己的 cwd 解析而找不到文件。
          fileReferenceRootResolved,
          onTextChange: updateText,
        });
        return;
      }
      handleDropComposer(event);
    },
    [
      handleDropComposer,
      fileReferenceRootResolved,
      fileSearchRootPath,
      updateText,
      workspaceIdentity,
      workspacePath,
    ],
  );
  const conversationDragKind = workspaceFileDragging
    ? "workspace"
    : externalFileDragging
      ? "attachment"
      : (attachmentsApi.composerDragKind ??
        (attachmentsApi.isDraggingOverComposer ? "attachment" : null));
  const dropTargetController = useMemo<ConversationDropTargetController>(
    () => ({
      active: conversationDragKind !== null,
      kind: conversationDragKind,
      onDragOver: handleConversationDragOver,
      onDragLeave: handleConversationDragLeave,
      onDrop: handleConversationDrop,
    }),
    [
      conversationDragKind,
      handleConversationDragLeave,
      handleConversationDragOver,
      handleConversationDrop,
    ],
  );
  useLayoutEffect(
    () => onDropTargetControllerChange?.(dropTargetController),
    [dropTargetController, onDropTargetControllerChange],
  );
  const [attachmentPreviewIndex, setAttachmentPreviewIndex] = useState(0);
  const [attachmentPreviewOpen, setAttachmentPreviewOpen] = useState(false);
  const [pdfAttachmentPreview, setPdfAttachmentPreview] =
    useState<ChatMediaAttachmentPreviewTarget | null>(null);
  const [pdfAttachmentPreviewOpen, setPdfAttachmentPreviewOpen] = useState(false);
  const attachmentPreviewTitle = intl.formatMessage({ id: "chat.attachments.preview.open" });
  const videoAttachmentPreviewTitle = intl.formatMessage({
    id: "chat.attachments.preview.openVideo",
  });
  const hasAttachments = attachmentsApi.hasAttachments;
  const {
    contexts: webElementContexts,
    hasContexts: hasWebElementContexts,
    removeContextByUser: removeWebElementContextByUser,
    clearContextsByUser: clearWebElementContextsByUser,
    removeSentContexts: removeSentWebElementContexts,
  } = useWebElementContexts({
    workspacePath,
    workspaceIdentity,
    // queue 撤回等待 ACK 时 composer 处于 disabled；此时也要阻止全局 add-to-chat
    // 写入网页上下文，避免权威删除成功后撞上 ACK 窗口内的新草稿。
    listenAddToChatEvents: listenAddToChatEvents && !disabled,
    scopeId: draftScopeId,
  });
  // 设计模式点选的元素（inline）在正文里是元素 token；普通网页「选择元素」的仍是输入框上方的元素标签
  const [inlineWebElementContexts, pillWebElementContexts] = useMemo(() => {
    const inline: WebElementContextComposerAttachment[] = [];
    const pill: WebElementContextComposerAttachment[] = [];
    for (const context of webElementContexts) (context.inline ? inline : pill).push(context);
    return [inline, pill];
  }, [webElementContexts]);
  const elementMentions = useMemo(
    () =>
      inlineWebElementContexts.map((context) => ({
        id: context.id,
        label: context.accessibleName || context.text || context.tagName.toLowerCase(),
      })),
    [inlineWebElementContexts],
  );
  const elementMentionPlugin = useMemo(
    () => (
      <ElementMentionSyncPlugin
        mentions={elementMentions}
        onRemovedByUser={(ids) => ids.forEach(removeWebElementContextByUser)}
      />
    ),
    [elementMentions, removeWebElementContextByUser],
  );
  // 设计模式元素 token 的截图 → 本 composer 的图片附件（预上传、随消息发出），但不在附件行出缩略图：正文里已经有 token。
  // token 覆盖 / 删除 / 切会话时撤掉（切会话撤旧 scope 的）。普通网页的元素卡片不带截图（11-05 反馈）。
  const webElementScreenshotIds = useContextImageAttachments(
    inlineWebElementContexts,
    attachmentsApi,
    WEB_ELEMENT_CONTEXT_IMAGE_OPTIONS,
  );
  // 上传失败的截图照常显示（!3450 SG-03）：失败会挡住发送，藏起来用户就看不到原因和重试入口
  const isHiddenWebElementScreenshot = useCallback(
    (attachment: { id: string; uploadStatus?: string }) =>
      webElementScreenshotIds.has(attachment.id) && attachment.uploadStatus !== "failed",
    [webElementScreenshotIds],
  );
  // 插件 UI 经 ui/update-model-context 附加的上下文；按 sessionId 接收，随发送清空。
  const {
    contexts: pluginUiContexts,
    hasContexts: hasPluginUiContexts,
    removeContext: removePluginUiContext,
    clearContexts: clearPluginUiContexts,
  } = usePluginUiModelContexts({ sessionId: pluginUiSessionId, workspacePath, workspaceIdentity });
  // 上下文里的 image 块 → 本 composer 的图片附件，随下一回合发送。
  usePluginUiContextImages(pluginUiContexts, attachmentsApi);
  const {
    references: pptxElementReferences,
    hasReferences: hasPptxElementReferences,
    removeReference: removePptxElementReference,
    clearReferences: clearPptxElementReferences,
  } = usePptxElementReferences({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    listenAddToChatEvents: listenAddToChatEvents && !disabled,
    scopeId: draftScopeId,
  });
  const openPptxElementReference = useOpenPptxElementReference({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    onOpenCodeViewer,
  });
  const {
    references: conversationSelectionReferences,
    limitReason: conversationSelectionLimitReason,
    removeReference: removeConversationSelectionReference,
    clearReferences: clearConversationSelectionReferences,
  } = useConversationSelectionReferences({
    // 编辑态的会话引用属于 edit scope，不能与原草稿共用同一份。
    sessionId: draftScopeIdProp ?? sessionId,
    workspaceKey,
    draftScopeKey: rootDraftScopeKey,
    liveSourceRows: draftScopeIdProp ? null : snapshot?.rows,
  });
  const hasConversationSelectionReferences = conversationSelectionReferences.length > 0;

  // ── 草稿 per-session 持久化（切会话/刷新不丢；mention pill 经 editorStateJson 保真）──
  const draftScopeRef = useRef(draftScopeId);
  const editorDraftScopeTokenRef = useRef(composerDraftScopeToken);
  const draftTargetRef = useRef({
    workspacePath,
    workspaceIdentity,
    scopeId: draftScopeId,
    scopeToken: composerDraftScopeToken,
  });
  const ownerDraftRef = useRef({
    draft: composerDraft,
    workspacePath,
    workspaceIdentity,
    scopeId: draftScopeId,
  });
  const draftPersistTimerRef = useRef<number | null>(null);
  const suppressDraftPersistRef = useRef<symbol | null>(null);

  const snapshotDraftOfEditor = useCallback((): { text: string; editorStateJson?: string } => {
    const currentText = textRef.current;
    let editorStateJson: string | undefined;
    try {
      const editorState = inputApiRef.current?.getEditorState();
      editorStateJson = editorState ? JSON.stringify(editorState.toJSON()) : undefined;
    } catch (error) {
      logger.warn(`[v4-composer] 草稿 editorState 序列化失败: ${String(error)}`);
    }
    return currentText.trim()
      ? { text: currentText, ...(editorStateJson ? { editorStateJson } : {}) }
      : { text: "" };
  }, []);

  const persistDraftNow = useCallback(
    (scopeId: string) => {
      if (suppressDraftPersistRef.current === composerDraftScopeTokenRef.current) return;
      const content = snapshotDraftOfEditor();
      if (scopeId === draftScopeRef.current) {
        updateComposerContent(content);
        return;
      }
    },
    [snapshotDraftOfEditor, updateComposerContent],
  );

  const scheduleDraftPersist = useCallback(() => {
    if (typeof window === "undefined") return;
    if (draftPersistTimerRef.current !== null) {
      window.clearTimeout(draftPersistTimerRef.current);
    }
    draftPersistTimerRef.current = window.setTimeout(() => {
      draftPersistTimerRef.current = null;
      persistDraftNow(draftScopeRef.current);
    }, 350);
  }, [persistDraftNow]);

  // ── 自动聚焦（新建任务 / 切会话 / 挂载后把光标交还输入框）──
  // 触发源：startDraft 递增的 draftFocusVersion（覆盖 Cmd/Ctrl+N 与所有「新建任务」入口）、
  // sessionId→draftScopeId 变化（切会话/切草稿）、以及挂载。三者置位聚焦意图；因切到需
  // 连接的会话时 composer 短暂 disabled，聚焦意图暂存，待可编辑时兑现一次。
  const draftFocusVersion = useZCodeSessionStore(
    (state) => state.getWorkspaceState(workspacePath, workspaceIdentity).draftFocusVersion,
  );
  const pendingFocusRef = useRef(false);

  // 修饰键点击先于 form submit；这里只保存这一拍的 delivery 反转意图，submit 消费后清零。
  const reversePointerDeliveryRef = useRef(false);
  const appliedExternalTextInsertRequestRef = useRef<number | null>(null);
  // 决策入参经 ref 读取，避免把 autoFocusEnabled/disabled/viewport 灌进 scope effect 依赖，
  // 触发多余的草稿重恢复（disabled 变化本不应重放草稿）。
  const focusOptsRef = useRef<ComposerAutoFocusOptions>({
    autoFocusEnabled,
    disabled,
    isMobileViewport: false,
  });
  focusOptsRef.current = { autoFocusEnabled, disabled, isMobileViewport: false };
  const flushPendingFocus = useCallback(() => {
    if (!pendingFocusRef.current) return;
    if (resolveComposerAutoFocus(focusOptsRef.current) !== "focus-now") return;
    if (!inputApiRef.current) return;
    pendingFocusRef.current = false;

    // Lexical root 可能晚一帧就绪，聚焦排到下一帧（与草稿回填同款时序）。
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => inputApiRef.current?.focus());
    } else {
      inputApiRef.current.focus();
    }
  }, []);
  const requestComposerFocus = useCallback(() => {
    if (resolveComposerAutoFocus(focusOptsRef.current) === "skip") return;
    pendingFocusRef.current = true;
    flushPendingFocus();
  }, [flushPendingFocus]);

  const handleCodeCommentRemoved = useCallback(
    (comment: Parameters<typeof removeCodeCommentPreview>[0]) => {
      removeCodeCommentPreview(comment, services?.broadcastService);
    },
    [services?.broadcastService],
  );
  const {
    contexts: codeCommentContexts,
    hasContexts: hasCodeCommentContexts,
    removeContext: removeCodeCommentContext,
    clearContexts: clearCodeCommentContexts,
    getContexts: getCodeCommentContexts,
  } = useCodeCommentContexts({
    // queue 撤回等待 ACK 时 composer 处于 disabled；与网页上下文保持同一写入门禁。
    listenAddToChatEvents: listenAddToChatEvents && !disabled,
    onContextRemoved: handleCodeCommentRemoved,
    requestFocus: requestComposerFocus,
    scopeKey: `${workspaceKey}\0${draftScopeId}`,
  });

  // 离开 composer 编辑态的 edit scope 时（取消、切换目标）丢弃其中未提交的附件；
  // 已提交的附件在结算时已 adopt 并移除，这里只剩需要按未发送规则清理的部分。
  const previousDraftScopeIdRef = useRef(draftScopeId);
  useEffect(() => {
    const previousScopeId = previousDraftScopeIdRef.current;
    previousDraftScopeIdRef.current = draftScopeId;
    if (previousScopeId === draftScopeId || !isComposerEditScopeId(previousScopeId)) return;
    attachmentsApi.clearAttachments(
      undefined,
      buildComposerAttachmentScopeKey(workspacePath, workspaceIdentity, previousScopeId),
    );
  }, [attachmentsApi, draftScopeId, workspaceIdentity, workspacePath]);

  const lastEditFocusRequestRef = useRef(editFocusRequest);
  useEffect(() => {
    if (lastEditFocusRequestRef.current === editFocusRequest) return;
    lastEditFocusRequestRef.current = editFocusRequest;
    // 占位点击是用户显式意图：直接聚焦，不受自动聚焦策略限制，也不滚动时间线。
    inputApiRef.current?.focus();
  }, [editFocusRequest]);

  // 最近一次已把草稿载入 Lexical 的 edit scope；只用于编辑态顶部内容的显示时机。
  const [appliedDraftScopeId, setAppliedDraftScopeId] = useState<string | null>(null);
  // 正文更新不能再次回填编辑器；只在现有 scope 换代时读取最新草稿和结算身份。
  const readDraftRestoreInputs = useEffectEvent(() => ({
    composerDraft,
    workspaceKey,
    composerDraftScopeToken,
  }));
  // scope 切换：先落旧 scope 草稿，再恢复新 scope（editorStateJson 优先，退纯文本）。
  useEffect(() => {
    const { composerDraft, workspaceKey, composerDraftScopeToken } = readDraftRestoreInputs();
    const previousTarget = draftTargetRef.current;
    const targetChanged =
      previousTarget.scopeId !== draftScopeId ||
      previousTarget.workspacePath !== workspacePath ||
      previousTarget.workspaceIdentity !== workspaceIdentity;
    let transferredDraft: ReturnType<typeof snapshotDraftOfEditor> | null = null;
    if (targetChanged && suppressDraftPersistRef.current !== composerDraftScopeTokenRef.current) {
      if (draftPersistTimerRef.current !== null) {
        window.clearTimeout(draftPersistTimerRef.current);
        draftPersistTimerRef.current = null;
      }
      const previousDraft = snapshotDraftOfEditor();
      const shouldTransferDraft =
        previousTarget.scopeId === V4_DRAFT_SCOPE_ROOT &&
        draftScopeId === V4_DRAFT_SCOPE_ROOT &&
        consumeV4ComposerDraftWorkspaceTransferRequest({
          sourceWorkspacePath: previousTarget.workspacePath,
          sourceWorkspaceIdentity: previousTarget.workspaceIdentity,
          targetWorkspacePath: workspacePath,
          targetWorkspaceIdentity: workspaceIdentity,
        });
      if (shouldTransferDraft) {
        // 项目解绑只改变草稿的 cwd；输入正文、mention editor state 和组件内附件继续保留。
        replaceComposerDraft({ ...ownerDraftRef.current.draft, ...previousDraft });
        transferredDraft = previousDraft;
      }
    }
    draftScopeRef.current = draftScopeId;
    draftTargetRef.current = {
      workspacePath,
      workspaceIdentity,
      scopeId: draftScopeId,
      scopeToken: composerDraftScopeToken,
    };

    const draft = transferredDraft ?? composerDraft;
    const restoreDraftInto = (api: LexicalChatInputHandle) => {
      // Composer 跨会话复用时，恢复正文也曾推入同一 undo 栈，留下旧会话内容。
      // 在新 scope 回填前断开旧历史；晋升沿用 token，项目解绑沿用正文，都不结束编辑周期。
      if (editorDraftScopeTokenRef.current !== composerDraftScopeToken && !transferredDraft) {
        api.clearHistory();
      }
      editorDraftScopeTokenRef.current = composerDraftScopeToken;
      if (!draft) {
        if (textRef.current) {
          api.clear();
          updateText("");
        }
        return;
      }
      updateText(
        restorePersistedComposerDraftIntoInput({
          draft,
          inputApi: api,
          onEditorStateError: (error) => {
            logger.warn(`[v4-composer] 草稿 editorState 恢复失败，退纯文本: ${String(error)}`);
          },
        }),
      );
    };
    let unsubscribeSettled: (() => void) | undefined;
    const applyDraft = () => {
      const api = inputApiRef.current;
      if (api) restoreDraftInto(api);
      // 与草稿正文同一帧显示编辑态顶部内容（见 editPresentationReady）；输入框未就绪时
      // 没有正文可等，也必须放行，否则编辑态状态条（含「取消」）不会出现。
      if (isComposerEditScopeId(draftScopeId)) {
        flushSync(() => setAppliedDraftScopeId(draftScopeId));
      }
      if (!api) return;
      // Bug 根因（R3A-B-07）：ACK 丢失时传输先 reject，提交正文被恢复回草稿；随即断连让
      // SessionPane 连同本组件卸载，闭包里的结算订阅一起消失。重连重挂后正文从草稿回填，
      // 权威 projection 到达却无人清空，用户再点发送就重复归属。这里在回填后向模块级账本
      // 认领该 scope 尚未结算的提交：结算已到则同步清空，否则等它到达。
      const restoredText = draft?.text ?? "";
      const restoredRevision = contentRevisionRef.current;
      unsubscribeSettled = subscribeComposerSubmissionSettled(
        `${workspaceKey}\0${draftScopeId}`,
        (submission) => {
          // 只清"确实是那次提交、且用户还没在其上继续编辑"的正文；编辑器把回填正文
          // 重新序列化后若与提交原文一致，也视为未编辑。
          if (submission.text !== restoredText) return;
          if (
            contentRevisionRef.current !== restoredRevision &&
            textRef.current !== submission.text
          ) {
            return;
          }
          inputApiRef.current?.clear();
          updateText("");
          updateComposerContent({ text: "" });
        },
      );
      // 草稿恢复后把光标交还输入框（切会话/切草稿/挂载）；连接中会话待可编辑后兑现。
      requestComposerFocus();
    };
    // Lexical root 可能晚一帧就绪；draft 恢复排到下一帧（与旧 initialValue 回填同款时序）。
    if (typeof requestAnimationFrame === "function") {
      const frame = requestAnimationFrame(applyDraft);
      return () => {
        cancelAnimationFrame(frame);
        unsubscribeSettled?.();
      };
    }
    applyDraft();
    return () => unsubscribeSettled?.();
    // 依赖收敛到 scope/workspace：draft 恢复只应发生在 scope 切换或 workspace 切换。
  }, [
    draftScopeId,
    persistDraftNow,
    requestComposerFocus,
    snapshotDraftOfEditor,
    updateText,
    updateComposerContent,
    workspaceIdentity,
    workspacePath,
    replaceComposerDraft,
  ]);

  useEffect(() => {
    ownerDraftRef.current = {
      draft: composerDraft,
      workspacePath,
      workspaceIdentity,
      scopeId: draftScopeId,
    };
  }, [composerDraft, draftScopeId, workspaceIdentity, workspacePath]);

  // 外部预填和 scope 恢复可能在同一轮发生。若预填 effect 先执行，后续恢复会用旧草稿
  // 覆盖用户刚点的 Example Prompt；因此必须在 scope 恢复之后应用并确认单次插入请求。
  useEffect(() => {
    if (!externalTextInsertRequest) return;
    const applyRequest = () => {
      const nextAppliedRequestId = applyExternalTextInsertRequestToComposer({
        appliedRequestId: appliedExternalTextInsertRequestRef.current,
        inputApi: inputApiRef.current,
        request: externalTextInsertRequest,
        requestFocus: requestComposerFocus,
        scheduleDraftPersist,
        updateText,
      });
      const applied = nextAppliedRequestId === externalTextInsertRequest.requestId;
      appliedExternalTextInsertRequestRef.current = nextAppliedRequestId;
      if (applied) {
        onExternalTextInsertApplied?.(externalTextInsertRequest.requestId);
      }
      return applied;
    };
    if (applyRequest()) return;
    if (typeof requestAnimationFrame !== "function") return;
    const frame = requestAnimationFrame(applyRequest);
    return () => cancelAnimationFrame(frame);
  }, [
    externalTextInsertRequest,
    onExternalTextInsertApplied,
    requestComposerFocus,
    scheduleDraftPersist,
    updateText,
  ]);

  // 新建任务（含已在草稿态重复 Cmd/Ctrl+N，scope 未变）：startDraft 递增 nonce 即重新聚焦。
  const lastFocusVersionRef = useRef(draftFocusVersion);
  useEffect(() => {
    if (lastFocusVersionRef.current === draftFocusVersion) return;
    lastFocusVersionRef.current = draftFocusVersion;
    requestComposerFocus();
  }, [draftFocusVersion, requestComposerFocus]);

  // 切到需连接的会话时 disabled=true，聚焦意图 defer；连接完成 disabled→false 时兑现一次。
  useEffect(() => {
    flushPendingFocus();
  }, [disabled, flushPendingFocus]);

  // 刷新/关窗前落盘当前草稿。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const flush = () => persistDraftNow(draftScopeRef.current);
    window.addEventListener("pagehide", flush);
    window.addEventListener("blur", flush);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("blur", flush);
      if (draftPersistTimerRef.current !== null) {
        window.clearTimeout(draftPersistTimerRef.current);
        draftPersistTimerRef.current = null;
      }
    };
  }, [persistDraftNow]);

  // ── prompt history（per-workspace localStorage，↑/↓ 导航由 PromptHistoryPlugin 消费）──
  const [promptHistory, setPromptHistory] = useState<readonly string[]>(() =>
    readPromptHistoryEntries(workspacePath),
  );
  useEffect(() => {
    setPromptHistory(readPromptHistoryEntries(workspacePath));
  }, [workspacePath]);

  const mode = snapshot?.inputRouting.mode ?? "startNow";
  const modifiedEnterSubmits = shouldEnableModifiedEnterSubmit({
    inputRoutingMode: mode,
    isMobileTextInputViewport,
    isWebRemoteControl,
  });
  const canStop = Boolean(snapshot?.control.canStop);
  const modifiedEnterReversesDelivery = modifiedEnterSubmits && canStop;
  const hasText = text.trim().length > 0;
  const hasDraftToSubmit =
    hasText ||
    hasAttachments ||
    hasCodeCommentContexts ||
    hasWebElementContexts ||
    hasPptxElementReferences ||
    hasConversationSelectionReferences ||
    hasPluginUiContexts ||
    Boolean(pendingShareContext);
  const hasComposerDraftContent =
    text.length > 0 ||
    hasAttachments ||
    hasCodeCommentContexts ||
    hasWebElementContexts ||
    hasPptxElementReferences ||
    hasConversationSelectionReferences ||
    hasPluginUiContexts ||
    Boolean(pendingShareContext);
  useEffect(() => {
    onDraftStateChange?.({ hasContent: hasComposerDraftContent, busy: pending });
  }, [hasComposerDraftContent, onDraftStateChange, pending]);
  // choice 保留正常发送按钮；提交后由 SessionPane 按 slash 语义决定是否弹确认框。
  // V4 重构时把 guide 当成“不可提交”状态，导致按钮和 Enter 同时失效；
  // guide 是 CLI 已授权的 busy 输入路由，是否最终 steer 或回退 queue 由命令层裁决。
  const routingAllowsSend = draftMode || (snapshot !== null && mode !== "reject");
  const attachmentsReady = !attachmentsApi.hasUnreadyAttachments;
  const recoveryCommand = appSlashCommands?.find(
    (command) => command.recovery && command.value === "reload",
  );
  // 面板选择是 AppSlashCommand 操作，草稿不是参数；只有文本提交才要求独立命令。
  const recoveryAvailable = Boolean(recoveryCommand) && remoteAvailable;
  const recoveryAllowed =
    recoveryAvailable &&
    !hasAttachments &&
    !hasCodeCommentContexts &&
    !hasWebElementContexts &&
    !hasPptxElementReferences &&
    !hasConversationSelectionReferences &&
    !hasPluginUiContexts &&
    !pendingShareContext;
  const connectionPendingRef = useRef(false);
  const [connectionPending, setConnectionPending] = useState(false);
  const handleConnectionPendingChange = useCallback((pending: boolean) => {
    connectionPendingRef.current = pending;
    setConnectionPending(pending);
  }, []);
  const canReload = recoveryAllowed && reloadText && remoteAvailable;
  const canSend =
    !connectionPending &&
    !disabled &&
    !pending &&
    hasDraftToSubmit &&
    (canReload || (routingAllowsSend && attachmentsReady && submissionReady && !runtimeBlocked));
  // 旧 UI 状态机：streaming + 空草稿 → Stop；有草稿 → 发送键（入队）。
  const showStopControl = canStop && !hasDraftToSubmit;

  useEffect(() => {
    if (!canSend) setSendTooltipOpen(false);
  }, [canSend]);

  const submit: ComposerSubmit = useCallback(
    async (
      heldQueueDisposition?: "clearQueueAndSend" | "keepQueueAndSend",
      expectedHeldQueueItemIds?: readonly string[],
      existingLocalTtft?: LocalTtftContext,
      requestedDelivery?: "startNow" | "queue" | "guide",
    ) => {
      if (connectionPendingRef.current) return;
      // 导航边界迟到的确认按钮仍可能保留旧闭包；读取 live editor ref 前先校验原 owner。
      if (composerDraftScopeTokenRef.current !== composerDraftScopeToken) return;
      const trimmed = textRef.current.trim();
      const submittedQueueItemIds =
        snapshotRef.current?.queue.items.map((item) => item.queueItemId) ?? [];
      const hasPendingAttachments = attachmentsApi.attachments.length > 0;
      const currentCodeCommentContexts = getCodeCommentContexts();
      const hasPendingCodeCommentContexts = currentCodeCommentContexts.length > 0;
      const currentWebElementContexts = webElementContexts;
      const hasPendingWebElementContexts = currentWebElementContexts.length > 0;
      const currentPluginUiContexts = pluginUiContexts;
      const hasPendingPluginUiContexts = currentPluginUiContexts.length > 0;
      const currentPptxElementReferences = pptxElementReferences;
      const hasPendingPptxElementReferences = currentPptxElementReferences.length > 0;
      const currentConversationSelections = conversationSelectionReferences;
      const hasPendingConversationSelections = currentConversationSelections.length > 0;
      const submittedShareContext = pendingShareContext;
      // 草稿首发 accepted 后同一 composer 会原地从 __draft__ promotion 到
      // session scope；若成功清理时再读可变 ref，会误清新 scope，并把首条输入残留在
      // __draft__，下次新建任务又恢复。发送开始时冻结真正提交的 scope。
      const submittedScopeId = draftScopeId;
      const submittedDraft = snapshotDraftOfEditor();
      let cleanupRevision = contentRevisionRef.current;
      const submission = createSubmissionFromComposer?.() ?? null;
      const submittedAttachmentIds = attachmentsApi.attachments.map((item) => item.id);
      const submittedAttachmentScopeKey = attachmentsApi.scopeKey;
      if (
        (!trimmed &&
          !hasPendingAttachments &&
          !hasPendingCodeCommentContexts &&
          !hasPendingWebElementContexts &&
          !hasPendingPptxElementReferences &&
          !hasPendingConversationSelections &&
          !hasPendingPluginUiContexts &&
          !submittedShareContext) ||
        pendingRef.current?.scopeToken === composerDraftScopeToken ||
        !submissionReady ||
        (createSubmissionFromComposer !== undefined && submission === null) ||
        attachmentsApi.hasUnreadyAttachments
      ) {
        return;
      }

      // 同一 Composer 会跨会话复用。只借用既有 Draft incarnation 识别本次提交，
      // A 的迟到回执/finally 不能接管 B；Root promotion 则沿用同一 token 正常结算。
      const submissionOwner = { scopeToken: composerDraftScopeToken };
      const draftTransaction = captureComposerSubmissionDraftTransaction(submittedDraft);
      const isCurrentSubmissionScope = () =>
        composerDraftScopeTokenRef.current === submissionOwner.scopeToken;
      pendingRef.current = submissionOwner;
      setPendingSubmission(submissionOwner);
      // 本地耗时诊断复用队列确认前的观测，不创建或发送遥测事件。
      const localTtft =
        existingLocalTtft ??
        (!workspaceIdentity?.trim()
          ? getLocalTtftObserver()?.start(
              workspacePath,
              snapshotRef.current?.inputRouting.mode !== "startNow" && snapshotRef.current !== null,
              trimmed.startsWith("/"),
            )
          : undefined);
      if (existingLocalTtft) getLocalTtftObserver()?.confirmation(existingLocalTtft, false);
      let promptHistoryBeforeSend: readonly string[] | null = null;
      let promptHistoryAfterAppend: readonly string[] | null = null;
      let promptHistoryWasPersisted = false;
      let draftSubmissionClaimed = false;
      let submittedCommandId: string | null = null;
      let settledSessionId: string | undefined;
      let editorClearedOptimistically = false;
      const claimSubmittedDraft = () => {
        if (draftPersistTimerRef.current !== null) {
          window.clearTimeout(draftPersistTimerRef.current);
          draftPersistTimerRef.current = null;
        }
        // 首发 promotion 会在 onSendText 返回前切换 scope 或重建 Composer。
        // 若仍允许旧 scope effect 落盘，新 Composer 会把已经发送的正文当草稿恢复。
        // 提交前先占用并隐藏该草稿；失败路径再恢复，避免用等待时间掩盖竞态。
        draftSubmissionClaimed = draftTransaction.claim();
        if (draftSubmissionClaimed && isCurrentSubmissionScope()) {
          suppressDraftPersistRef.current = submissionOwner.scopeToken;
        }
      };
      const restoreSubmittedDraft = (awaitsAuthority = false) => {
        // 原 scope 已经离开时仍需恢复它的持久草稿；旧 updateComposerContent 闭包会因
        // incarnation 已失效而拒写，不能把 UI early-return 当成原提交的结算。
        const restored = draftTransaction.restore();
        if (restored.applied && submittedCommandId && awaitsAuthority)
          trackUnsettledComposerSubmission(`${workspaceKey}\0${submittedScopeId}`, {
            commandId: submittedCommandId,
            text: submittedDraft.text,
          });
        const canRestoreEditor =
          restored.current &&
          restored.applied &&
          isCurrentSubmissionScope() &&
          contentRevisionRef.current === cleanupRevision;
        if (suppressDraftPersistRef.current === submissionOwner.scopeToken) {
          suppressDraftPersistRef.current = null;
        }
        draftSubmissionClaimed = false;
        if (editorClearedOptimistically && canRestoreEditor) {
          if (submittedDraft.editorStateJson) {
            inputApiRef.current?.setEditorStateJson(submittedDraft.editorStateJson);
          } else {
            inputApiRef.current?.setText(submittedDraft.text);
          }
          updateText(submittedDraft.text);
          editorClearedOptimistically = false;
        }
        return canRestoreEditor;
      };
      let settlementFlight: Promise<void> | undefined;
      let submissionAccepted = false;
      let contentFinalized = false;
      const updateHandoff = (phase: "pending" | "failed") => {
        if (!submittedAttachmentIds.length) return;
        const targetSessionId =
          settledSessionId ??
          (submittedCommandId
            ? pendingCommandRegistry.findCommand(submittedCommandId)?.sessionId
            : undefined);
        attachmentsApi.setSubmissionHandoff(
          submittedAttachmentScopeKey,
          {
            owner: submissionOwner.scopeToken,
            phase,
            retry: settleSubmittedContent,
            ...(targetSessionId && !draftScopeIdProp
              ? {
                  displayScopeKey: buildComposerAttachmentScopeKey(
                    workspacePath,
                    workspaceIdentity,
                    targetSessionId,
                  ),
                }
              : {}),
          },
          submissionOwner.scopeToken,
        );
      };
      const settleSubmittedContent = (): Promise<void> => {
        // ACK与权威投影共用这一flight，success必须等待首个附件交接。
        if (settlementFlight) return settlementFlight;
        submissionAccepted = true;
        updateHandoff("pending");
        settlementFlight = (async () => {
          if (!contentFinalized) {
            contentFinalized = true;
            const finalized = draftTransaction.finalize();
            if (suppressDraftPersistRef.current === submissionOwner.scopeToken)
              suppressDraftPersistRef.current = null;
            draftSubmissionClaimed = false;
            if (
              finalized?.current &&
              finalized.applied &&
              isCurrentSubmissionScope() &&
              contentRevisionRef.current === cleanupRevision
            ) {
              inputApiRef.current?.clear();
              updateText("");
            }
          }
          // 按提交时附件scope结算，切换编辑态后不能清掉下一条消息的新附件。
          await attachmentsApi.adoptSentAttachments(
            submittedAttachmentIds,
            submittedAttachmentScopeKey,
          );
          attachmentsApi.clearAttachments(submittedAttachmentIds, submittedAttachmentScopeKey);
          currentCodeCommentContexts.forEach(removeCodeCommentContext);
          removeSentWebElementContexts(currentWebElementContexts.map((context) => context.id));
          currentPluginUiContexts.forEach((context) => removePluginUiContext(context.id));
          currentPptxElementReferences.forEach((reference) =>
            removePptxElementReference(reference.id),
          );
          if (sessionId && !draftScopeIdProp)
            recordSentConversationSelections(
              sessionId,
              workspaceKey,
              currentConversationSelections,
            );
          currentConversationSelections.forEach((reference) =>
            removeConversationSelectionReference(reference.id),
          );
          onSubmissionSettled?.(submittedScopeId);
          attachmentsApi.setSubmissionHandoff(
            submittedAttachmentScopeKey,
            undefined,
            submissionOwner.scopeToken,
          );
        })().catch((error) => {
          settlementFlight = undefined;
          updateHandoff("failed");
          throw error;
        });
        return settlementFlight;
      };
      const subscribeToCommandResolution: NonNullable<
        ConversationComposerSendOptions["onCommandCreated"]
      > = (commandId, observeResolution) => {
        let active = true;
        let unsubscribe: (() => void) | undefined;
        submittedCommandId = commandId;
        updateHandoff("pending");
        const cleanup = () => {
          if (!active) return;
          active = false;
          unsubscribe?.();
          commandResolutionCleanupsRef.current.delete(cleanup);
        };
        // 句柄先登记；订阅若同步给出已有结论，返回后再解除真实subscription。
        // 已预留的交接仍由原附件 store 持有，卸载不能丢失未决命令的结论订阅。
        if (!submittedAttachmentIds.length && !observeResolution)
          commandResolutionCleanupsRef.current.add(cleanup);
        const listener = (
          resolution: import("@/v4/pendingCommandRegistry.js").PendingCommandResolution,
          targetSessionId?: string,
        ) => {
          if (!active) return;
          settledSessionId = targetSessionId;
          cleanup();
          if (
            resolution !== "accepted" &&
            resolution !== "duplicate" &&
            resolution !== "authoritative"
          ) {
            attachmentsApi.setSubmissionHandoff(
              submittedAttachmentScopeKey,
              undefined,
              submissionOwner.scopeToken,
            );
            void attachmentsApi.releaseSentAttachmentReservations(
              submittedAttachmentIds,
              submittedAttachmentScopeKey,
            );
            restoreSubmittedDraft();
            draftTransaction.release();
            return;
          }
          void settleSubmittedContent().catch(() => {
            logger.warn("[v4-composer] 已接纳输入的附件交接失败");
          });
        };
        unsubscribe = observeResolution
          ? observeResolution(listener)
          : pendingCommandRegistry.subscribeResolution(commandId, listener);
        if (!active) unsubscribe();
      };
      const rollbackPromptHistory = () => {
        if (!promptHistoryWasPersisted || !promptHistoryBeforeSend || !promptHistoryAfterAppend) {
          return;
        }
        const currentPromptHistory = readPromptHistoryEntries(workspacePath);
        if (arePromptHistoryEntriesEqual(currentPromptHistory, promptHistoryAfterAppend)) {
          persistPromptHistoryEntries(workspacePath, promptHistoryBeforeSend);
          if (isCurrentSubmissionScope()) setPromptHistory(promptHistoryBeforeSend);
          return;
        }
        if (isCurrentSubmissionScope()) setPromptHistory(currentPromptHistory);
      };
      try {
        // 二次门禁：只消费预传完成的 ref，不在点击发送时回落上传。
        const readyAttachmentRefs = await attachmentsApi.prepareForSend();
        if (readyAttachmentRefs === null) {
          if (localTtft) getLocalTtftObserver()?.exclude(localTtft, "rejected");

          return;
        }
        // 外部上下文不走协议附件；按 selection -> code comment -> web -> PPTX 的固定尾块顺序
        // 序列化，历史 user row 才能按相反顺序无损解析并隐藏内部 prompt block。
        //
        // 分享 handover 不在这里序列化：share URL 块纯粹是 renderer 自产自销（CLI/shared
        // 里没有任何东西解析它），唯一作用是驱动一个已被产品裁掉的 chip，代价却是把一个
        // share URL 塞进发给模型的正文。模型侧内容由隐藏的 shared_context 消息经
        // inputIntent.sharedContextRefs 注入，与正文无关。
        const promptText = serializeComposerPromptContexts(trimmed, {
          codeComments: currentCodeCommentContexts,
          conversationSelections: currentConversationSelections,
          webElements: currentWebElementContexts,
          pptxElements: currentPptxElementReferences,
          pluginUiContexts: currentPluginUiContexts,
        });
        const contextAttachmentCount =
          countComposerPromptContexts({
            codeComments: currentCodeCommentContexts,
            conversationSelections: currentConversationSelections,
            webElements: currentWebElementContexts,
            pptxElements: currentPptxElementReferences,
            pluginUiContexts: currentPluginUiContexts,
          }) + (submittedShareContext ? 1 : 0);
        if (trimmed) {
          promptHistoryBeforeSend = readPromptHistoryEntries(workspacePath);
          promptHistoryAfterAppend = appendPromptHistoryEntry(promptHistoryBeforeSend, trimmed);
          if (!arePromptHistoryEntriesEqual(promptHistoryBeforeSend, promptHistoryAfterAppend)) {
            // 预热首发 accepted 后，SessionPane 会立即 promote 到新 session，
            // draft composer 可能在 await 恢复前卸载；不能把写盘藏在 React state updater 里。
            // 这里继续沿用旧 UI 的 localStorage history，不接 input_history 数据库：
            // 发起真实发送前先同步写盘，若发送失败再恢复到发送前快照。
            persistPromptHistoryEntries(workspacePath, promptHistoryAfterAppend);
            promptHistoryWasPersisted = true;
            setPromptHistory(promptHistoryAfterAppend);
          }
        }
        await attachmentsApi.reserveSentAttachments(
          submittedAttachmentIds,
          submittedAttachmentScopeKey,
        );
        claimSubmittedDraft();
        if (
          requestedDelivery === "startNow" &&
          draftSubmissionClaimed &&
          isCurrentSubmissionScope() &&
          contentRevisionRef.current === cleanupRevision
        ) {
          // 原子抢占需要等旧 turn 退出并提交新 TurnStarted ACK；
          // 若编辑器也等整条链路才清空，用户会误以为快捷键未生效。
          // 先清空可见正文；命令拒绝时用冻结 editor state 原样恢复。
          inputApiRef.current?.clear();
          updateText("");
          cleanupRevision = contentRevisionRef.current;
          editorClearedOptimistically = true;
        }
        const sendResult = await onSendText(promptText, {
          submission,
          localTtft,
          ...(currentConversationSelections.length
            ? {
                conversationQuotes: currentConversationSelections.map(
                  ({ text, path, senderName, senderId, messageId, sentAt, comment, agent }) => ({
                    text,
                    path,
                    senderName,
                    senderId,
                    messageId,
                    sentAt,
                    comment,
                    agent,
                  }),
                ),
              }
            : {}),
          onCommandCreated: subscribeToCommandResolution,
          ...(requestedDelivery ? { requestedDelivery } : {}),
          ...(heldQueueDisposition ? { heldQueueDisposition } : {}),
          ...(expectedHeldQueueItemIds ? { expectedHeldQueueItemIds } : {}),
          ...(readyAttachmentRefs.length > 0 ? { attachments: readyAttachmentRefs } : {}),
          ...(contextAttachmentCount > 0 ? { contextAttachmentCount } : {}),
          ...(submittedShareContext
            ? {
                sharedContextRefs: [
                  {
                    kind: "shared_context_import" as const,
                    context_id: submittedShareContext.contextId,
                  },
                ],
              }
            : {}),
        });
        // 创建只开始编排；首条输入仍等原创建 owner 的真实终态。
        if (sendResult === "pending") return;
        if (sendResult === "blocked") {
          attachmentsApi.setSubmissionHandoff(
            submittedAttachmentScopeKey,
            undefined,
            submissionOwner.scopeToken,
          );
          await attachmentsApi.releaseSentAttachmentReservations(
            submittedAttachmentIds,
            submittedAttachmentScopeKey,
          );
          if (localTtft) getLocalTtftObserver()?.exclude(localTtft, "rejected");
          // 产品 guard 是一次正常拒绝，不应借异常路径表达；回滚发送前暂记的 history，
          // 同时不 clear editor/draft/附件，让用户切换模式后可以直接重试。
          rollbackPromptHistory();
          restoreSubmittedDraft();

          return;
        }
        if (sendResult === "confirmationRequired") {
          attachmentsApi.setSubmissionHandoff(
            submittedAttachmentScopeKey,
            undefined,
            submissionOwner.scopeToken,
          );
          await attachmentsApi.releaseSentAttachmentReservations(
            submittedAttachmentIds,
            submittedAttachmentScopeKey,
          );
          if (localTtft) getLocalTtftObserver()?.confirmation(localTtft, true);
          rollbackPromptHistory();
          const canReopenConfirmation = restoreSubmittedDraft();
          if (!canReopenConfirmation) return;
          const latestQueueItemIds =
            snapshotRef.current?.queue.items.map((item) => item.queueItemId) ?? [];
          // 首次提交冻结当前队列；跨端 stale 后用最新投影替换，要求用户重新确认。
          setHeldQueueConfirmation({
            scopeToken: submissionOwner.scopeToken,
            localTtft,
            ...(requestedDelivery ? { requestedDelivery } : {}),
            queueItemIds:
              latestQueueItemIds.length > 0 ? latestQueueItemIds : submittedQueueItemIds,
          });

          return;
        }
        if (isCurrentSubmissionScope()) setHeldQueueConfirmation(null);
        await settleSubmittedContent();
      } catch {
        // 已经接纳的命令不得因本地结算失败恢复为可重复发送正文。
        if (submissionAccepted) {
          logger.warn("[v4-composer] 已接纳输入的本地结算未完成");
          return;
        }
        if (!submittedCommandId)
          await attachmentsApi.releaseSentAttachmentReservations(
            submittedAttachmentIds,
            submittedAttachmentScopeKey,
          );
        rollbackPromptHistory();
        restoreSubmittedDraft(true);
        if (localTtft) getLocalTtftObserver()?.exclude(localTtft, "failed");
        // 发送失败草稿保留在输入框（不清空），仅记录原因。
        logger.warn("[v4-composer] 发送失败，保留所属草稿");
        // ACK 侧失败已由 SessionPane 落定；能走到这里的是 composer 自身链路异常。
      } finally {
        // 未知传输结果继续等权威结论；正文恢复账本负责卸载重挂后的接管。
        if (!submittedCommandId) draftTransaction.release();
        if (pendingRef.current === submissionOwner) {
          pendingRef.current = null;
          setPendingSubmission((current) => (current === submissionOwner ? null : current));
        }
      }
    },
    [
      attachmentsApi,
      conversationSelectionReferences,
      draftScopeIdProp,
      createSubmissionFromComposer,
      composerDraftScopeToken,
      captureComposerSubmissionDraftTransaction,
      submissionReady,
      getCodeCommentContexts,
      onSendText,
      pendingShareContext,
      removeCodeCommentContext,
      removeConversationSelectionReference,
      removePptxElementReference,
      removeSentWebElementContexts,
      removePluginUiContext,
      pluginUiContexts,
      sessionId,
      snapshotDraftOfEditor,
      updateText,
      webElementContexts,
      pptxElementReferences,
      workspaceIdentity,
      workspaceKey,
      workspacePath,
      onSubmissionSettled,
      draftScopeId,
    ],
  );
  latestSubmitRef.current = submit;

  const lastEditSubmitRequestRef = useRef(editSubmitRequest);
  useEffect(() => {
    if (lastEditSubmitRequestRef.current === editSubmitRequest) return;
    lastEditSubmitRequestRef.current = editSubmitRequest;
    // 与发送按钮共用提交事务：草稿冻结、附件门禁、失败恢复与成功结算保持一致。
    void submit();
  }, [editSubmitRequest, submit]);

  // Lexical onChange（首字符也稳定回传，见 LexicalChatInput.TextContentPlugin）。
  const handleEditorChange = useCallback(
    (value: string) => {
      updateText(value);
      // 正文先进入与 mode/model 相同的内存 Draft；防抖只负责补充最新 Lexical JSON。
      updateComposerContent({ text: value });
      scheduleDraftPersist();
    },
    [scheduleDraftPersist, updateComposerContent, updateText],
  );

  // 编辑器提交（Enter / 发送键 form submit 同路径）。返回 false：编辑器不自行 reset，
  // 由 submit 成功后经 inputApiRef.clear() 清空——失败时草稿留在输入框。
  const handleEditorSubmit = useCallback(
    (value: string) => {
      textRef.current = value;
      const reverseDelivery = reversePointerDeliveryRef.current;
      reversePointerDeliveryRef.current = false;
      const followupMode = snapshotRef.current?.config.followupMode;
      void submit(
        undefined,
        undefined,
        undefined,
        reverseDelivery && followupMode ? resolveOppositeFollowupDelivery(followupMode) : undefined,
      );
      return false;
    },
    [submit],
  );

  const handleModifiedEditorSubmit = useCallback(
    (value: string) => {
      const followupMode = snapshotRef.current?.config.followupMode;
      textRef.current = value;
      // inputRouting 在 turn 启动初期可能仍为 startNow，不能用它
      // 推断空闲。组合键始终表达单次反向 delivery；空闲时 CLI 自然 startNow。
      void submit(
        undefined,
        undefined,
        undefined,
        followupMode ? resolveOppositeFollowupDelivery(followupMode) : undefined,
      );
      return false;
    },
    [submit],
  );

  const handleClearQueueSend = useCallback(() => {
    if (!heldQueueConfirmation) return;
    void submit(
      "clearQueueAndSend",
      heldQueueConfirmation.queueItemIds,
      heldQueueConfirmation.localTtft,
      heldQueueConfirmation.requestedDelivery,
    );
  }, [heldQueueConfirmation, submit]);

  const handleKeepQueueSend = useCallback(() => {
    if (!heldQueueConfirmation) return;
    void submit(
      "keepQueueAndSend",
      heldQueueConfirmation.queueItemIds,
      heldQueueConfirmation.localTtft,
      heldQueueConfirmation.requestedDelivery,
    );
  }, [heldQueueConfirmation, submit]);

  const handleStopClick = useCallback(() => {
    onStop();
  }, [onStop]);

  // 发送键是 type="submit"，与 Enter 共用 handleEditorSubmit；DOM 事件顺序保证 click 早于
  // submit，故这里只置标记，由 submit() 读取并复位。
  const handleSendButtonClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      reversePointerDeliveryRef.current = shouldReverseFollowupDeliveryForPointer({
        enabled: modifiedEnterReversesDelivery,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        isApplePlatform: appleKeyboardPlatform,
      });
    },
    [appleKeyboardPlatform, modifiedEnterReversesDelivery],
  );

  // ── 「加入对话」全局事件（workspace file tree 右键/按钮）→ mention 插入 ──
  useEffect(() => {
    if (!listenAddToChatEvents || typeof window === "undefined") {
      return;
    }
    const handleWorkspaceFileAddToChat = (event: Event) => {
      if (!isWorkspaceFileAddToChatEvent(event)) {
        return;
      }
      event.preventDefault();
      appendWorkspaceFileMentionToComposer({
        inputApiRef,
        currentMarkdown: inputApiRef.current?.getMarkdown() ?? textRef.current,
        payload: event.detail,
        workspacePath,
        workspaceIdentity,
        // 同 handleConversationDrop：解析根用本 composer 的会话执行 cwd（缺席回落 workspacePath）。
        fileReferenceRootPath: fileSearchRootPath,
        fileReferenceRootResolved,
        onTextChange: updateText,
      });
    };
    window.addEventListener(WORKSPACE_FILE_ADD_TO_CHAT_EVENT, handleWorkspaceFileAddToChat);
    return () => {
      window.removeEventListener(WORKSPACE_FILE_ADD_TO_CHAT_EVENT, handleWorkspaceFileAddToChat);
    };
  }, [
    fileReferenceRootResolved,
    fileSearchRootPath,
    listenAddToChatEvents,
    updateText,
    workspaceIdentity,
    workspacePath,
  ]);

  // 动态 placeholder（旧 chatViewPlaceholder 语义）：无历史 → newTask；
  // 有历史空闲 → followUpAsk；有历史处理中 → followUpQueue。
  const placeholder = intl.formatMessage({
    id: resolveChatPlaceholderKey({
      hasHistoryMessages: (snapshot?.rows.totalCount ?? 0) > 0,
      isTaskProcessing: canStop,
      compactNewTask: false,
    }),
  });
  const sendTooltipTitle = intl.formatMessage({
    id: mode === "enqueue" ? "chat.queue.enqueue" : "chat.send",
  });
  const modifierTooltip = resolveFollowupModifierTooltip({
    enabled: modifiedEnterReversesDelivery,
    canSend,
    modifierPressed: primaryModifierPressed,
    followupMode: snapshot?.config.followupMode,
    isApplePlatform: appleKeyboardPlatform,
  });
  const resolvedSendTooltipTitle = modifierTooltip
    ? intl.formatMessage({ id: modifierTooltip.titleId })
    : sendTooltipTitle;
  const resolvedSendTooltipShortcut = modifierTooltip?.shortcut ?? sendShortcut;
  const stopTooltipTitle = intl.formatMessage({ id: "chat.stop" });
  const visibleError = error && !shouldSuppressChatErrorBanner(error) ? error : null;
  useEffect(() => {
    if (visibleError)
      recordChatError({ error: visibleError, displayMessage: visibleError.message });
  }, [visibleError]);

  const attachmentAction = useMemo(
    () => ({
      label: intl.formatMessage({ id: "chat.composer.attachment" }),
      menuItemTestId: TID_CHAT_ATTACHMENT_MENU_ITEM,
      onSelect: () => openAttachmentPicker(),
      testId: TID_CHAT_ATTACHMENT_BUTTON,
    }),
    [intl, openAttachmentPicker],
  );

  // ── 附件预览网格 ──
  const composerAttachments = attachmentsApi.attachments;
  const orderedComposerAttachments = useMemo(() => {
    // 媒体组（图片/视频）优先、文件在后；组内保持添加顺序。
    const media: (typeof composerAttachments)[number][] = [];
    const files: (typeof composerAttachments)[number][] = [];
    for (const attachment of composerAttachments) {
      (isMediaChatComposerAttachment(attachment) ? media : files).push(attachment);
    }
    return [...media, ...files];
  }, [composerAttachments]);
  const composerMediaPreviewItems = useMemo(
    () =>
      composerAttachments.flatMap((attachment) =>
        attachment.objectUrl && isMediaChatComposerAttachment(attachment)
          ? [
              {
                alt: attachment.filename,
                filename: attachment.filename,
                mediaType: attachment.mimeType,
                src: attachment.objectUrl,
              },
            ]
          : [],
      ),
    [composerAttachments],
  );
  // 隐藏的元素截图不进 DOM 附件行；在输入框根节点上留「文件名:上传状态」，E2E 据此判断截图是否就绪
  const hiddenElementScreenshotsMarker = useMemo(
    () =>
      composerAttachments
        .filter((item) => isHiddenWebElementScreenshot(item))
        .map((item) => `${item.filename}:${item.uploadStatus ?? "ready"}`)
        .join(" "),
    [composerAttachments, isHiddenWebElementScreenshot],
  );
  const attachmentsTopContentNode = useMemo(() => {
    // 元素 token 的截图是隐藏附件：只剩它们时整行不渲染，否则卡片的 gap 会在截图晚到时把输入框撑高一截
    const hasVisibleComposerAttachments = composerAttachments.some(
      (item) => !isHiddenWebElementScreenshot(item),
    );
    if (
      !hasVisibleComposerAttachments &&
      codeCommentContexts.length === 0 &&
      pillWebElementContexts.length === 0 &&
      pptxElementReferences.length === 0 &&
      conversationSelectionReferences.length === 0 &&
      pluginUiContexts.length === 0
    ) {
      return null;
    }
    return (
      <div className="flex max-w-full flex-col items-start gap-2">
        {hasVisibleComposerAttachments ? (
          <Attachments
            variant="inline"
            className="flex max-w-full flex-wrap gap-2"
            data-composer-file-attachments-row="true"
          >
            {orderedComposerAttachments.map((attachment) => {
              const isClipboardTextAttachment = attachment.sourceKind === "clipboard-text";
              const isMediaAttachment = isMediaChatComposerAttachment(attachment);
              const isVideoAttachment = isVideoChatComposerAttachment(attachment);
              const isPdfAttachment = isPdfChatComposerAttachment(attachment);
              const mediaType = attachment.objectUrl
                ? attachment.mimeType
                : attachment.mimeType.startsWith("image/")
                  ? "application/octet-stream"
                  : attachment.mimeType;
              const canPreviewImageAttachment =
                Boolean(attachment.objectUrl) && isImageChatComposerAttachment(attachment);
              const canPreviewVideoAttachment = Boolean(attachment.objectUrl) && isVideoAttachment;
              const canPreviewPdfAttachment = Boolean(attachment.objectUrl) && isPdfAttachment;
              const fileDisplayDescriptor = resolveFileDisplayDescriptor(
                attachment.localPath ?? attachment.filename,
              );
              const uploadStatusLabel =
                attachment.uploadStatus === "uploading"
                  ? intl.formatMessage(
                      { id: "chat.attachments.upload.uploading" },
                      { progress: String(attachment.uploadProgress) },
                    )
                  : attachment.uploadStatus === "failed"
                    ? intl.formatMessage(
                        { id: "chat.attachments.upload.failed" },
                        { message: attachment.uploadError ?? "unknown" },
                      )
                    : intl.formatMessage({
                        id: `chat.attachments.upload.${attachment.uploadStatus}`,
                      });
              const showUploadStatus =
                !attachment.localZeroCopy &&
                (attachment.uploadStatus !== "ready" || attachment.showComplete);
              return (
                <Attachment
                  key={attachment.id}
                  variant={isMediaAttachment ? "grid" : "inline"}
                  data-composer-attachment-kind={
                    isVideoAttachment
                      ? "video"
                      : isMediaAttachment
                        ? "image"
                        : isPdfAttachment
                          ? "pdf"
                          : "file"
                  }
                  data-testid={testId(TID_V4_ATTACHMENT, attachment.id)}
                  data-upload-status={attachment.uploadStatus}
                  className={cn(
                    isMediaAttachment
                      ? "relative size-12 overflow-hidden rounded-lg bg-surface after:pointer-events-none after:absolute after:inset-0 after:rounded-lg after:border after:border-border after:content-['']"
                      : "h-12 w-fit max-w-full min-w-0 gap-2 rounded-lg border border-border bg-surface p-1.5 pr-6 [--attachment-bg:var(--color-surface)] hover:bg-surface-hover",
                    isHiddenWebElementScreenshot(attachment) && "hidden",
                  )}
                  data={{
                    id: attachment.id,
                    type: "file",
                    filename: attachment.filename,
                    ...(isClipboardTextAttachment
                      ? {
                          description: intl.formatMessage(
                            { id: "chat.attachments.clipboardText.description" },
                            { lineCount: formatAttachmentLineCount(attachment, locale) },
                          ),
                          displayName: intl.formatMessage({ id: "chat.attachments.clipboardText" }),
                          sourceKind: "clipboard-text" as const,
                        }
                      : {}),
                    mediaType,
                    url: attachment.objectUrl ?? "",
                  }}
                  onRemove={() => attachmentsApi.removeAttachment(attachment.id)}
                  // 附件支持非图片格式，PDF 走独立 PdfViewer，
                  // 其他文件展示类型图标和文件名，避免 doc 等普通文件被当成图片渲染失败。
                  // 图片与视频统一按添加顺序进入发送前 gallery，
                  // 保证同一组媒体可以连续导航。
                  onOpen={
                    canPreviewImageAttachment || canPreviewVideoAttachment
                      ? () => {
                          const previewIndex = composerMediaPreviewItems.findIndex(
                            (item) => item.src === attachment.objectUrl,
                          );
                          if (previewIndex < 0) return;
                          setAttachmentPreviewIndex(previewIndex);
                          setAttachmentPreviewOpen(true);
                        }
                      : canPreviewPdfAttachment
                        ? () => {
                            setPdfAttachmentPreview({
                              filename: attachment.filename,
                              mediaType: "application/pdf",
                              url: attachment.objectUrl,
                            });
                            setPdfAttachmentPreviewOpen(true);
                          }
                        : undefined
                  }
                  openLabel={
                    canPreviewVideoAttachment
                      ? videoAttachmentPreviewTitle
                      : canPreviewImageAttachment
                        ? attachmentPreviewTitle
                        : canPreviewPdfAttachment
                          ? intl.formatMessage({ id: "chat.attachments.preview.openPdf" })
                          : undefined
                  }
                >
                  <div
                    className={cn(
                      "relative shrink-0",
                      isMediaAttachment ? "size-full" : "size-9 rounded-md bg-background",
                    )}
                  >
                    <AttachmentPreview
                      className={cn(
                        isMediaAttachment ? "size-full rounded-none" : "size-9 rounded-md",
                      )}
                      fallbackIcon={
                        isClipboardTextAttachment ? (
                          <ClipboardPenLineIcon className="size-3.5 text-muted-foreground" />
                        ) : (
                          <FileDisplayIcon
                            src={fileDisplayDescriptor.fileIconSrc}
                            size={16}
                            className="size-4 shrink-0"
                          />
                        )
                      }
                    />
                    {showUploadStatus && isMediaAttachment ? (
                      <span
                        data-testid={testId(TID_V4_ATTACHMENT_UPLOAD_PROGRESS, attachment.id)}
                        role={attachment.uploadStatus === "failed" ? "alert" : "status"}
                        aria-label={uploadStatusLabel}
                        className="absolute inset-0 grid place-items-center rounded-lg bg-background/85 text-[7px] font-semibold text-foreground"
                      >
                        <svg
                          aria-hidden="true"
                          className="absolute inset-0 size-full -rotate-90 text-brand"
                          viewBox="0 0 24 24"
                        >
                          <circle
                            className="stroke-border"
                            cx="12"
                            cy="12"
                            fill="none"
                            pathLength="100"
                            r="9"
                            strokeWidth="2"
                          />
                          <circle
                            className={
                              attachment.uploadStatus === "failed"
                                ? "stroke-destructive"
                                : "stroke-current"
                            }
                            cx="12"
                            cy="12"
                            fill="none"
                            pathLength="100"
                            r="9"
                            strokeDasharray={`${attachment.uploadProgress} 100`}
                            strokeLinecap="round"
                            strokeWidth="2"
                          />
                        </svg>
                        <span className="relative">
                          {attachment.uploadStatus === "failed"
                            ? "!"
                            : `${attachment.uploadProgress}%`}
                        </span>
                      </span>
                    ) : null}
                  </div>
                  {!isMediaAttachment ? (
                    isClipboardTextAttachment ? (
                      <AttachmentInfo className="max-w-48 text-ui-base text-foreground" />
                    ) : (
                      <div className="min-w-0 max-w-40 flex-1">
                        <span
                          className="block truncate text-ui-base font-medium text-foreground"
                          title={attachment.filename}
                        >
                          {attachment.filename}
                        </span>
                        <span className="block truncate text-ui-sm font-normal text-foreground-subtle">
                          {getComposerAttachmentTypeLabel(attachment.filename, attachment.mimeType)}
                        </span>
                      </div>
                    )
                  ) : null}
                  {showUploadStatus && !isMediaAttachment ? (
                    <span
                      data-testid={testId(TID_V4_ATTACHMENT_UPLOAD_PROGRESS, attachment.id)}
                      role={attachment.uploadStatus === "failed" ? "alert" : "status"}
                      title={uploadStatusLabel}
                      className={cn(
                        "max-w-28 truncate text-ui-sm font-normal text-foreground-subtle",
                        attachment.uploadStatus === "failed" && "text-destructive",
                      )}
                    >
                      {attachment.uploadStatus === "uploading"
                        ? `${attachment.uploadProgress}%`
                        : uploadStatusLabel}
                    </span>
                  ) : null}
                  {attachment.uploadStatus === "failed" ? (
                    <button
                      type="button"
                      data-testid={testId(TID_V4_ATTACHMENT_UPLOAD_RETRY, attachment.id)}
                      aria-label={intl.formatMessage({ id: "chat.attachments.upload.retry" })}
                      title={uploadStatusLabel}
                      className="grid size-5 shrink-0 place-items-center rounded-md text-destructive hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        attachmentsApi.retryAttachment(attachment.id);
                      }}
                    >
                      <RotateCcwIcon className="size-3" />
                    </button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    data-composer-attachment-remove={attachment.id}
                    aria-label={intl.formatMessage({ id: "chat.attachments.remove" })}
                    className="absolute right-0.5 top-0.5 z-20 size-3.5 rounded-full bg-primary p-0 text-primary-foreground opacity-0 transition-opacity hover:bg-primary/80 hover:text-primary-foreground group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      attachmentsApi.removeAttachment(attachment.id);
                    }}
                  >
                    <XIcon className="size-2.5" />
                  </Button>
                </Attachment>
              );
            })}
          </Attachments>
        ) : null}
        {codeCommentContexts.length > 0 ||
        pillWebElementContexts.length > 0 ||
        pptxElementReferences.length > 0 ||
        conversationSelectionReferences.length > 0 ||
        pluginUiContexts.length > 0 ? (
          <div
            className="flex max-w-full flex-wrap items-center gap-2"
            data-composer-context-attachments-row="true"
          >
            <CodeCommentAttachmentChip
              comments={codeCommentContexts}
              onRemove={removeCodeCommentContext}
              onRemoveAll={clearCodeCommentContexts}
            />
            <WebElementContextAttachmentChip
              contexts={pillWebElementContexts}
              onRemove={removeWebElementContextByUser}
              onRemoveAll={clearWebElementContextsByUser}
            />
            <PluginUiModelContextChip
              contexts={pluginUiContexts}
              onRemove={removePluginUiContext}
              onRemoveAll={clearPluginUiContexts}
            />
            <PptxElementReferenceChip
              references={pptxElementReferences}
              onOpen={onOpenCodeViewer ? openPptxElementReference : undefined}
              onRemove={removePptxElementReference}
              onRemoveAll={clearPptxElementReferences}
            />
            <ConversationSelectionReferenceChip
              references={conversationSelectionReferences}
              // 正文编号对应主 composer scope；编辑态（edit scope）的列表不编号，避免与正文错位。
              numbered={!draftScopeIdProp}
              onRemove={(id) => {
                deleteConversationAnnotationWithUndo({
                  sessionId: draftScopeIdProp ?? sessionId,
                  workspaceKey,
                  draftScopeKey: rootDraftScopeKey,
                  id,
                  formatMessage: (messageId) => intl.formatMessage({ id: messageId }),
                });
                // 存储里已删除；这里只同步清掉 hook 内的超限提示。
                removeConversationSelectionReference(id);
              }}
              onEdit={
                // 编号对应主时间线正文；编辑态（edit scope）的引用不在主时间线上画标记。
                selectionCommentEnabled && sessionId && !draftScopeIdProp
                  ? (id, fallback) =>
                      dispatchConversationSelectionEdit({ sessionId, workspaceKey, id, fallback })
                  : undefined
              }
              onRemoveAll={clearConversationSelectionReferences}
            />
          </div>
        ) : null}
      </div>
    );
  }, [
    attachmentPreviewTitle,
    videoAttachmentPreviewTitle,
    attachmentsApi,
    clearCodeCommentContexts,
    clearConversationSelectionReferences,
    clearWebElementContextsByUser,
    clearPluginUiContexts,
    clearPptxElementReferences,
    codeCommentContexts,
    composerAttachments,
    composerMediaPreviewItems,
    orderedComposerAttachments,
    isHiddenWebElementScreenshot,
    intl,
    locale,
    removeCodeCommentContext,
    removeConversationSelectionReference,
    removeWebElementContextByUser,
    removePluginUiContext,
    removePptxElementReference,
    conversationSelectionReferences,
    pillWebElementContexts,
    pluginUiContexts,
    pptxElementReferences,
    onOpenCodeViewer,
    openPptxElementReference,
    draftScopeIdProp,
    rootDraftScopeKey,
    selectionCommentEnabled,
    sessionId,
    workspaceKey,
  ]);
  // Bug 根因：草稿正文晚一帧（rAF）才载入 Lexical，状态条与附件行却随 scope 切换立即渲染；
  // 多行编辑时队列面板会先因状态条上移、下一帧再因正文上移（两次跳位，B09g 逐帧采样复现）。
  // 进入 edit scope 时等正文载入后再显示顶部内容，使高度变化只发生一次。
  const editPresentationReady =
    !isComposerEditScopeId(draftScopeId) || appliedDraftScopeId === draftScopeId;
  const topContentNode = !editPresentationReady ? null : editBar && attachmentsTopContentNode ? (
    <div className="flex w-full max-w-full flex-col gap-2">
      {editBar}
      {attachmentsTopContentNode}
    </div>
  ) : (
    (editBar ?? attachmentsTopContentNode)
  );

  // 发送/停止控制簇（对齐旧 ChatViewComposer.submitControlNode 结构：
  // 左侧 model/thought/usage 簇 + 右侧 stop 或 send）。
  // useMemo：composer 随流式 snapshot 高频重渲染，控制簇只在语义依赖变化时重建，
  // 避免每个 token 批次都重建 Tooltip/Select 子树。
  const composerUsage = snapshot?.usage ?? null;
  const composerPhase = snapshot?.control.phase ?? null;
  const handleSelectModel = useCallback(
    (nextProvider: string, nextModel: string, sourceModel: ModelSelectionSource | null) =>
      onSelectModel(nextProvider, nextModel, sourceModel),
    [onSelectModel],
  );
  const submitControlNode = useMemo(
    () => (
      <div className="flex min-w-0 items-center gap-1">
        {!remoteAvailable ? (
          <span
            data-testid="remote-send-unavailable"
            className="max-w-40 text-right text-ui-sm text-foreground-subtle"
          >
            {intl.formatMessage({ id: "remote.conversation.sendUnavailable" })}
          </span>
        ) : null}
        {remoteAvailable ? (
          <span className="flex min-w-0 shrink items-center gap-1 overflow-hidden empty:hidden">
            {/* 扩展插槽 composer.status：紧挨用量圆环左边（docs/plugins/extension-host.md §6）。
                作用域用有效会话：草稿取预热会话，与插件 UI 同一来源。 */}
            <ComposerStatusSlot
              workspacePath={workspacePath}
              workspaceIdentity={workspaceIdentity}
              sessionId={pluginUiSessionId ?? null}
            />
            <V4ComposerModelControls
              workspacePath={workspacePath}
              workspaceIdentity={workspaceIdentity}
              modelSelectionView={modelSelectionView}
              modelSelectionState={modelSelectionState}
              modelSelectionReload={modelSelectionReload}
              sessionId={sessionId ?? null}
              phase={composerPhase}
              provider={provider}
              isMobileViewport={isMobileTextInputViewport}
              draftMode={draftMode}
              draftConfig={draftConfig}
              usage={composerUsage}
              disabled={disabled || runtimeBlocked}
              modelSelectionPending={modelSelectionPending}
              onConnectionPendingChange={handleConnectionPendingChange}
              activeConfigPicker={activeConfigPicker}
              onConfigPickerOpenChange={handleConfigPickerOpenChange}
              onSelectModel={handleSelectModel}
              onSelectThought={onSelectThought}
              onSwitchMode={onSwitchMode}
              onRecoverCustomModelSelection={onRecoverCustomModelSelection}
              onSendCompressionCommand={onSendCompressionCommand}
            />
          </span>
        ) : null}

        {showStopControl ? (
          <ControlHintTooltip title={stopTooltipTitle} shortcut="Esc">
            <Button
              type="button"
              variant="secondary"
              size="icon-md"
              onClick={handleStopClick}
              data-testid={TID_V4_STOP}
              aria-label={stopTooltipTitle}
            >
              <SquareIcon className="size-4 fill-current" />
              <span className="sr-only">{stopTooltipTitle}</span>
            </Button>
          </ControlHintTooltip>
        ) : (
          <ControlHintTooltip
            title={resolvedSendTooltipTitle}
            shortcut={resolvedSendTooltipShortcut}
            open={Boolean(modifierTooltip) || sendTooltipOpen}
            onOpenChange={setSendTooltipOpen}
          >
            <Button
              type="submit"
              size="icon-md"
              disabled={!canSend}
              onClick={handleSendButtonClick}
              data-testid={TID_V4_COMPOSER_SEND}
              aria-label={resolvedSendTooltipTitle}
              className="cursor-pointer gap-1 rounded-lg bg-brand text-ui-base text-foreground-inverse hover:bg-brand/80"
            >
              {pending ? <Spinner className="size-4" /> : <ArrowUpIcon className="size-4" />}
              <span className="sr-only">{resolvedSendTooltipTitle}</span>
            </Button>
          </ControlHintTooltip>
        )}
      </div>
    ),
    [
      canSend,
      activeConfigPicker,
      composerPhase,
      composerUsage,
      disabled,
      runtimeBlocked,
      remoteAvailable,
      isMobileTextInputViewport,
      intl,
      modelSelectionPending,
      handleConnectionPendingChange,
      draftConfig,
      draftMode,
      handleStopClick,
      handleSendButtonClick,
      handleConfigPickerOpenChange,
      handleSelectModel,
      modelSelectionReload,
      modelSelectionState,
      modelSelectionView,
      onSelectThought,
      onRecoverCustomModelSelection,
      onSendCompressionCommand,
      onSwitchMode,
      pending,
      provider,
      modifierTooltip,
      resolvedSendTooltipShortcut,
      resolvedSendTooltipTitle,
      sendTooltipOpen,
      sessionId,
      pluginUiSessionId,
      showStopControl,
      stopTooltipTitle,
      workspaceIdentity,
      workspacePath,
    ],
  );

  // 左下：模式选择 + CUA 入口 + 当前 session 后台任务入口。followupMode 由 app 设置页同步到 CLI，
  // 不在 composer 暴露局部开关；后台入口只消费同一 snapshot，不维护第二份任务状态。
  // memo 捕获整个 snapshot 会让共享词法环境中的稳定发送回调也持有旧历史；只捕获展示字段。
  const workspaceHookAdmission = snapshot?.workspaceHookAdmission;
  const workspaceMcpAdmission = snapshot?.workspaceMcpAdmission;
  const backgroundWorks = snapshot?.backgroundWorks;
  const leadingActionsNode = useMemo(
    () => (
      <>
        <V4ComposerModeSwitch
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          provider={provider}
          draftConfig={draftConfig}
          disabled={disabled}
          activeConfigPicker={activeConfigPicker}
          onConfigPickerOpenChange={handleConfigPickerOpenChange}
          onSwitchMode={onSwitchMode}
        />
        {admissionActionsNode}
        {/* 附件画廊重构曾整段覆盖 leadingActions，误删 CUA 常驻入口。
            入口自身继续负责平台、远程与设置可见性，不在 composer 重复判定。 */}
        <V4ComposerCuaEntry
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={remoteSessionId}
          currentSessionBusy={canStop}
        />
        <ConversationBackgroundWorkTrigger
          backgroundWorks={backgroundWorks ?? []}
          runningSubagentCount={runningSubagentCount}
          onOpen={onOpenRunningBackgroundWorks}
          openTarget={backgroundWorkOpenTarget}
        />
      </>
    ),
    [
      admissionActionsNode,
      activeConfigPicker,
      canStop,
      disabled,
      draftConfig,
      handleConfigPickerOpenChange,
      backgroundWorkOpenTarget,
      onOpenRunningBackgroundWorks,
      onSwitchMode,
      provider,
      remoteSessionId,
      runningSubagentCount,
      backgroundWorks,
      workspaceIdentity,
      workspacePath,
    ],
  );
  const isBlockedByInteraction = blockingRequestId !== null;

  // v4 pendingInteractions 是 bottom dock 阻塞态；composer 必须保留挂载，
  // 只在视觉和可访问树中隐藏，避免权限/问答卡片出现时丢失草稿和编辑器内部状态。
  return (
    // 外层 bottom dock 负责 sticky 与横向主列宽度；composer 自身组织错误提示与输入壳。
    // centered（居中草稿布局，m5）：收窄 max-w-2xl（旧
    // getChatViewComposerWidthClassName 的 draft 档），由宿主的居中容器摆位。
    // 有 contextHeader（草稿态）时，内层输入 surface 套旧 ChatViewComposer 同款卡：
    // rounded-2xl bg-surface shadow-xl/5；会话态回落不透明页面底色。
    // 错误横幅虽然排在 contextHeader 前面，但不能与输入区共用同一个圆角 surface，
    // 视觉上会被误认为输入卡标题栏；将 surface 边界收窄到工作区头和编辑器后，桌面与手机
    // Web 仍共享同一 DOM 顺序，同时恢复错误提示与输入卡之间的独立层级。
    <div
      data-testid={TID_V4_COMPOSER}
      data-input-routing={mode}
      aria-hidden={isBlockedByInteraction ? true : undefined}
      style={isBlockedByInteraction ? { display: "none" } : undefined}
      className={cn(
        "chat-composer-region z-20 w-full shrink-0 @container/composer",
        centered && "max-w-2xl",
      )}
    >
      {/* 旧 ChatViewComposer 同款隐藏 file input（web/无 native picker 平台回退）。 */}
      <input
        ref={attachmentsApi.attachmentInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={attachmentsApi.handleAttachmentInputChange}
      />
      {visibleError ? (
        // 仅展示附件错误会漏掉会话级 lastError，任务失败后也应在输入框上方显示原因。
        // 这里复用旧 ChatErrorBanner 壳，只接收 SessionPane 已归一化后的当前错误。
        // 错误横幅独立于输入 surface，并先于桌面和手机共用的 contextHeader。
        <div className="mb-6 w-full shrink-0">
          <ChatErrorBanner
            error={visibleError}
            onDismiss={onDismissError}
            onOpenModelSettings={onOpenModelSettings}
          />
        </div>
      ) : null}
      <div
        data-composer-element-screenshots={hiddenElementScreenshotsMarker || undefined}
        className={cn(
          "chat-composer-input-surface w-full",
          contextHeader && "rounded-2xl bg-surface shadow-xl/5",
        )}
      >
        {contextHeader ? (
          // 旧 ChatViewComposer contextHeaderContent 同款包装（workspace 菜单 + Git 分支）。
          <div className="p-1.5 flex min-w-0 flex-wrap items-center gap-0">{contextHeader}</div>
        ) : null}
        {conversationSelectionLimitReason ? (
          <div
            role="alert"
            className="mb-2 w-full rounded-lg border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 px-3 py-2 text-ui-base text-foreground"
          >
            {intl.formatMessage({
              id: `chat.selections.limit.${conversationSelectionLimitReason}`,
            })}
          </div>
        ) : null}
        <ChatPromptEditor
          layout={floating ? "inline" : "stacked"}
          extraPlugins={elementMentionPlugin}
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          fileSearchRootPath={fileSearchRootPath}
          fileReferenceRootResolved={fileReferenceRootResolved}
          taskId={sessionId}
          skillCatalogSessionId={skillCatalogSessionId}
          placeholder={placeholder}
          placeholderContent={
            floating && canStop ? (
              <ConversationWorkingPlaceholder status={workingStatus} fallback={placeholder} />
            ) : undefined
          }
          disabled={disabled || mode === "reject"}
          submitting={pending}
          submitDisabled={
            pending ||
            connectionPending ||
            (!canReload &&
              (runtimeBlocked || !routingAllowsSend || !attachmentsReady || !submissionReady))
          }
          allowSubmitWhenEmpty={
            // 发送按钮已把代码评论视为可发送上下文，但这里曾漏掉同一状态，
            // 导致空文本仅附代码评论时 Enter 被编辑器判为空，必须改点发送按钮。
            hasCodeCommentContexts ||
            hasAttachments ||
            hasWebElementContexts ||
            hasPptxElementReferences ||
            hasConversationSelectionReferences ||
            hasPluginUiContexts
          }
          enterSubmits={enterSubmits}
          onModifiedSubmit={modifiedEnterSubmits ? handleModifiedEditorSubmit : undefined}
          submitLabel={sendTooltipTitle}
          showSlashButton
          // @ 是 Plugin / 文件 / 对话 / 画板主入口；# 会话与 $ / ¥ / ￥ Skills
          // 仍由 MentionPlugin 保留兼容触发，但不在 + 菜单重复展示。
          showMentionButton
          topContent={topContentNode}
          attachmentAction={attachmentAction}
          inputTestId={TID_V4_COMPOSER_INPUT}
          inputApiRef={inputApiRef}
          promptHistory={promptHistory}
          // 命令目录必须完整来自 CLI workspace slash catalog；UI 只在
          // secondary pane 按产品能力隐藏 goal，不再追加任何内建命令或别名。
          excludedSlashCommandNames={suppressGoalCommands ? ["goal"] : undefined}
          appSlashCommands={appSlashCommands}
          enableMentionPanel
          leadingActions={leadingActionsNode}
          submitControl={submitControlNode}
          className="p-0"
          onChange={handleEditorChange}
          onSubmit={handleEditorSubmit}
          onWhiteboardMentionSelected={attachmentsApi.handleWhiteboardMentionSelected}
          onPaste={attachmentsApi.handlePaste}
        />
        {attachmentsApi.submissionHandoff ? (
          <div
            role="status"
            data-testid="composer-attachment-handoff"
            className="flex flex-wrap items-center gap-2 p-3 text-ui-base text-warning"
          >
            <span>
              {intl.formatMessage({
                id:
                  attachmentsApi.submissionHandoff.phase === "failed"
                    ? "chat.attachments.handoffFailed"
                    : "chat.attachments.handoffPending",
              })}
            </span>
            <Button
              size="sm"
              variant="ghost"
              data-testid="composer-attachment-handoff-retry"
              disabled={attachmentsApi.submissionHandoff.phase !== "failed"}
              onClick={() => void attachmentsApi.submissionHandoff?.retry().catch(() => {})}
            >
              {intl.formatMessage({ id: "chat.attachments.retryHandoff" })}
            </Button>
          </div>
        ) : null}
        {attachmentsApi.attachmentError ? (
          <p className="flex items-start gap-2 p-3 text-ui-base text-warning">
            <InfoIcon className="mt-0.5 size-4 shrink-0" />
            <span>{attachmentsApi.attachmentError}</span>
          </p>
        ) : null}
      </div>
      <ImagePreviewDialog
        initialIndex={attachmentPreviewIndex}
        items={composerMediaPreviewItems}
        onOpenChange={setAttachmentPreviewOpen}
        open={attachmentPreviewOpen}
      />
      <ChatMediaAttachmentPreviewDialog
        attachment={pdfAttachmentPreview}
        open={pdfAttachmentPreviewOpen}
        onOpenChange={(open) => {
          setPdfAttachmentPreviewOpen(open);
          if (!open) setPdfAttachmentPreview(null);
        }}
      />
      <Dialog
        open={heldQueueConfirmation !== null}
        onOpenChange={(open) => {
          if (
            !open &&
            composerDraftScopeTokenRef.current === composerDraftScopeToken &&
            pendingRef.current?.scopeToken !== composerDraftScopeToken
          ) {
            if (heldQueueConfirmation?.localTtft)
              getLocalTtftObserver()?.exclude(heldQueueConfirmation.localTtft, "cancelled");
            setHeldQueueConfirmation((current) =>
              current?.scopeToken === composerDraftScopeToken ? null : current,
            );
          }
        }}
      >
        <DialogContent
          data-testid={TID_V4_PAUSED_QUEUE_SEND_DIALOG}
          showCloseButton={false}
          className="max-w-xl gap-6 p-6 sm:p-8"
        >
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              disabled={pending}
              aria-label={intl.formatMessage({ id: "common.close" })}
              className="absolute top-4 right-4"
            >
              <XIcon className="size-5" />
            </Button>
          </DialogClose>
          <DialogHeader className="gap-3 pr-8">
            <DialogTitle className="text-xl font-semibold sm:text-2xl">
              {intl.formatMessage({ id: "chat.queue.sendConfirm.title" })}
            </DialogTitle>
            <DialogDescription className="text-ui-base sm:text-ui-lg">
              {intl.formatMessage(
                { id: "chat.queue.sendConfirm.description" },
                { count: String(heldQueueConfirmation?.queueItemIds.length ?? 0) },
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-3 sm:gap-3">
            <Button
              type="button"
              variant="destructive"
              size="lg"
              data-testid={TID_V4_COMPOSER_CLEAR_QUEUE_SEND}
              disabled={pending}
              className="min-w-32 rounded-full"
              onClick={handleClearQueueSend}
            >
              {intl.formatMessage({ id: "chat.queue.sendConfirm.clear" })}
            </Button>
            <Button
              type="button"
              size="lg"
              data-testid={TID_V4_COMPOSER_KEEP_QUEUE_SEND}
              disabled={pending}
              className="min-w-32 rounded-full"
              onClick={handleKeepQueueSend}
            >
              {pending ? <Spinner className="size-4" /> : null}
              {intl.formatMessage({ id: "chat.queue.sendConfirm.keep" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export const ConversationComposer = memo(ConversationComposerImpl);
