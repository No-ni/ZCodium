import { useTuiRuntimeBindings } from "./app-runtime-bindings.js";
import { useTuiProjectionState } from "./app-projection-state.js";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppView } from "./app-view.js";
import { syncTextareaValue, type PromptInputEditor } from "./app-input-pane.js";
import { useLocalQuit } from "./app-quit.js";
import { selectionCopyStatus, type SelectionCopyResult } from "./app-copy.js";
import { useClipboardImagePaste } from "./app-clipboard-image.js";
import { useFileMentionController } from "./app-file-mentions.js";
import { useTuiKeyboardControls } from "./app-keyboard.js";
import { useTuiModeSwitcher } from "./app-mode.js";

import { useSubmitValue } from "./app-submit-controller.js";
import { filterSlashCommands, reconcileSlashSelection } from "./app-input.js";
import { useEffortCommandController } from "./app-effort-command.js";
import { useInputHistory } from "./app-input-history.js";
import { useModeCommandController } from "./app-mode-command.js";
import { useModelCommandController } from "./app-model-command.js";
import { useSidebarController } from "./app-sidebar-layout.js";

import { useComposerSubmittedText } from "./app-submit-resolver.js";
import type { DraftAttachment } from "./app-model.js";
import { useTuiThemeSync } from "./app-theme-sync.js";

import { useTuiWorkflowRuns } from "./app-workflow-controller.js";

import { useSubagents } from "./app-subagents.js";
import type { TuiOptions } from "./types.js";

type TuiAppProps = {
  copySelection: () => Promise<SelectionCopyResult>;
  hasCopyableSelection: () => boolean;
  options: TuiOptions;
  onExit: (code: number) => void;
};

export function TuiApp({
  copySelection,
  hasCopyableSelection,
  onExit,
  options,
}: TuiAppProps): React.ReactElement {
  useTuiThemeSync(options);
  const projection = useTuiProjectionState(options);
  const {
    initialResult,
    copy,
    messages,
    setMessages,
    draft,
    setDraftState,
    setDraftAttachmentsState,
    busy,
    setBusy,
    mode,
    setMode,
    model,
    thoughtLevel,
    locale,
    lastEvent,
    lastError,
    setLastError,
    modelSetupRequired,
    status,
    setStatus,
    statusDetails,
    setStatusDetails,
    traceId,
    activeTurnId,
    contextUsage,
    cacheStats,
    usage,
    todos,
    networkRequests,
    modifiedFiles,
    liveModelText,
    setLiveModelText,
    queuedInputs,
    setQueuedInputs,
    selection,
    setSelection,
    slashSelection,
    setSlashSelection,
    inputCursorToEndVersion,
    setInputCursorToEndVersion,
  } = projection;
  // dwf 运行态镜像：共享 reducer 逐事件维护 + 冷启动一次性补种，无第二时钟。
  const workflowRuns = useTuiWorkflowRuns({ copy: copy.tui, options, setMessages });
  const sidebar = useSidebarController();
  const subagents = useSubagents(options);

  const abortControllerRef = useRef<AbortController | undefined>(undefined);
  const draftRef = useRef("");
  const draftAttachmentsRef = useRef<DraftAttachment[]>([]);
  const inputEditorRef = useRef<PromptInputEditor | null>(null);
  const inputHistoryIndexRef = useRef(0);
  const inputHistoryDraftAttachmentsRef = useRef<DraftAttachment[] | undefined>(undefined);
  const inputHistoryDraftRef = useRef<string | undefined>(undefined);
  const nextAttachmentIdRef = useRef(1);
  const assistantMessageIdsByToolCallIdRef = useRef(new Map<string, string>());
  const modifiedFileToolCallIdsRef = useRef(new Set<string>());
  const toolNamesByIdRef = useRef(new Map<string, string>());

  const localQuit = useLocalQuit({
    locale,
    commands: options.slashCommands,
    getDraft: () => inputEditorRef.current?.plainText ?? draftRef.current,
    hasAttachments: () => draftAttachmentsRef.current.length > 0,
    turnRef: abortControllerRef,
    onExit,
    setStatus,
  });
  // 合并后的后台审批仍复用本地退出 owner，避免挂载入口引用缺失或另建审批队列。
  const { approvalQueue, setApprovalQueue, isExitRequested, slashCommands, requestPermission } =
    localQuit;
  const [effortOptions, setEffortOptions] = useState<NonNullable<TuiOptions["effortOptions"]>>(
    () => initialResult?.effortOptions ?? options.effortOptions ?? [],
  );
  const filteredSlashCommands = useMemo(
    () => filterSlashCommands(draft, slashCommands),
    [draft, slashCommands],
  );
  const effortCommand = useEffortCommandController(draft, effortOptions);
  const modelCommand = useModelCommandController(draft, options);
  const modeCommand = useModeCommandController(draft);

  const setDraftAttachments = useCallback((action: React.SetStateAction<DraftAttachment[]>) => {
    const nextAttachments =
      typeof action === "function" ? action(draftAttachmentsRef.current) : action;
    draftAttachmentsRef.current = nextAttachments;
    setDraftAttachmentsState(nextAttachments);
  }, []);

  const setDraftValue = useCallback(
    (value: string) => {
      if (isExitRequested()) return;
      draftRef.current = value;
      // 原生 buffer 清空必须先于下一批按键；等待 layout effect 会把 /quit 拼回旧 prompt。
      if (value.length === 0 && inputEditorRef.current)
        syncTextareaValue(inputEditorRef.current, value);
      setDraftState(value);
      setDraftAttachments((current) =>
        current.filter((attachment) => value.includes(attachment.placeholder)),
      );
      inputHistoryIndexRef.current = 0;
      inputHistoryDraftAttachmentsRef.current = undefined;
      inputHistoryDraftRef.current = undefined;
      const nextModelSelection = modelCommand.reconcileDraft(value);
      const nextEffortSelection = nextModelSelection
        ? undefined
        : effortCommand.reconcileDraft(value);
      const nextModeSelection =
        nextModelSelection || nextEffortSelection ? undefined : modeCommand.reconcileDraft(value);
      if (nextModelSelection) {
        effortCommand.setSelection(undefined);
        modeCommand.setSelection(undefined);
      } else if (nextEffortSelection) {
        modelCommand.setSelection(undefined);
        modeCommand.setSelection(undefined);
      } else if (nextModeSelection) {
        effortCommand.setSelection(undefined);
        modelCommand.setSelection(undefined);
      }
      setSlashSelection(
        nextModelSelection || nextEffortSelection || nextModeSelection
          ? undefined
          : reconcileSlashSelection(value, slashCommands),
      );
    },
    [effortCommand, isExitRequested, modeCommand, modelCommand, setDraftAttachments, slashCommands],
  );

  const { applyResult, applySessionEvent } = useTuiRuntimeBindings(projection, options, {
    modifiedFileToolCallIds: modifiedFileToolCallIdsRef.current,
    assistantMessageIdsByToolCallId: assistantMessageIdsByToolCallIdRef.current,
    toolNamesById: toolNamesByIdRef.current,
    setEffortOptions,
    setModelOptions: modelCommand.setModelOptions,
    observeSessionEvent: subagents.onEvent,
    setWorkflowMirror: workflowRuns.setMirror,
  });

  const registerPermissionRequester = options.registerPermissionRequester;
  // 挂载期间审批入口一直有效：主会话回合之外的询问（后台会话、通知驱动的回合）也进同一队列。
  useEffect(
    () => registerPermissionRequester?.(requestPermission),
    [registerPermissionRequester, requestPermission],
  );

  const resolveSubmittedText = useComposerSubmittedText({
    modelCommand,
    effortCommand,
    modeCommand,
    filteredSlashCommands,
    slashSelection,
  });

  const submitValue = useSubmitValue({
    activeTurnId,
    applyResult,
    applySessionEvent,
    busy,
    draftAttachmentsRef,
    emptyPromptStatus: copy.tui.input.typePrompt,
    messageInsertIndex: messages.length,
    options,
    resolveSubmittedText,
    resolveSubmittedModel: (value) => modelCommand.selectedOption(value)?.ref,
    setBusy,
    setDraftAttachments,
    setDraftValue,
    setLastError,
    setLiveModelText,
    setMessages,
    setQueuedInputs,
    setSelection,
    setSlashSelection,
    setStatus,
    setStatusDetails,
    turnRef: abortControllerRef,
    ...localQuit,
    getDraftValue: () => inputEditorRef.current?.plainText ?? draftRef.current,
  });

  const pasteClipboardImage = useClipboardImagePaste({
    abortControllerRef,
    busy,
    getDraftValue: () => draftRef.current,
    inputEditorRef,
    nextAttachmentIdRef,
    options,
    setDraftAttachments,
    setDraftValue,
    setStatus,
    setStatusDetails,
  });

  const { recallNextInput, recallPreviousInput } = useInputHistory({
    copy: copy.tui,
    draftAttachmentsRef,
    draftRef,
    inputHistoryDraftAttachmentsRef,
    inputHistoryDraftRef,
    inputHistoryIndexRef,
    nextAttachmentIdRef,
    options,
    setDraftAttachments,
    setDraftState,
    setDraftValue,
    setInputCursorToEndVersion,
    setSlashSelection,
    setStatus,
    setStatusDetails,
  });

  const fileMentions = useFileMentionController({
    busy,
    draft,
    editorRef: inputEditorRef,
    listWorkspacePathSuggestions: options.listWorkspacePathSuggestions,
    nextAttachmentIdRef,
    setDraftAttachments,
    setDraftValue,
    setSlashSelection,
    setStatus,
  });

  const copyCurrentSelection = useCallback((): boolean => {
    if (!hasCopyableSelection()) return false;
    void copySelection().then((result) => {
      const copyStatus = selectionCopyStatus(result, copy.tui.copy);
      if (copyStatus.status) setStatus(copyStatus.status);
      if (copyStatus.details) setStatusDetails(copyStatus.details);
    });
    return true;
  }, [copy, copySelection, hasCopyableSelection]);
  const switchMode = useTuiModeSwitcher({
    mode,
    setMode,
    setModeHandler: options.setMode,
    setStatus,
  });

  useTuiKeyboardControls({
    readOnlyView: subagents.selected ? { back: subagents.back } : undefined,
    abortControllerRef,
    ...localQuit,
    localQuit,
    busy,
    copyCurrentSelection,
    effortSelection: effortCommand.selection,
    filteredEffortOptions: effortCommand.filteredOptions,
    filteredSlashCommands,
    filteredModeOptions: modeCommand.filteredOptions,
    filteredModelOptions: modelCommand.filteredOptions,
    handleFileMentionKey: fileMentions.handleKey,
    onExit: localQuit.requestExit,
    pasteClipboardImage,
    recallNextInput,
    recallPreviousInput,
    draftValue: draft,
    inputHistoryActive: inputHistoryDraftRef.current !== undefined,
    messages,
    modelSelection: modelCommand.selection,
    modeSelection: modeCommand.selection,
    selection,
    setApprovalQueue,
    setDraftAttachments,
    setDraftValue,
    setEffortSelection: effortCommand.setSelection,
    setModelSelection: modelCommand.setSelection,
    setModeSelection: modeCommand.setSelection,
    setSelection,
    setSlashSelection,
    setStatus,
    slashSelection,
    submitValue,
    switchMode,
    workflowExpansion: workflowRuns.expansion,
    toggleSidebar: sidebar.toggleSidebar,
    toggleSidebarSection: sidebar.toggleSidebarSection,
  });

  return React.createElement(AppView, {
    subagents,
    toggleSidebar: sidebar.toggleSidebar,
    activeTurnId,
    approvalQueue,
    busy,
    cacheStats,
    contextUsage,
    copy: copy.tui,
    copyCurrentSelection,
    draft,
    editorRef: inputEditorRef,
    inputCursorToEndVersion,
    lastError,
    lastEvent,
    modelSetupRequired,
    liveModelText,
    mode,
    model,
    messages,
    modifiedFiles,
    networkRequests,
    options,
    queuedInputs,
    selection,
    fileMention: fileMentions.state,
    setDraftValue,
    sidebarLayout: sidebar.layout,
    sidebarSections: sidebar.sections,
    effortOptions: effortCommand.filteredOptions,
    effortSelection: effortCommand.selection,
    modelOptions: modelCommand.filteredOptions,
    modelSelection: modelCommand.selection,
    modeOptions: modeCommand.filteredOptions,
    modeSelection: modeCommand.selection,
    slashCommands: filteredSlashCommands,
    slashSelection,
    status,
    statusDetails,
    submitValue,
    thoughtLevel,
    todos,
    toggleSidebarSection: sidebar.toggleSidebarSection,
    traceId,
    terminalWidth: sidebar.terminalWidth,
    usage,
    workflowCardsByToolCallId: workflowRuns.cardsByToolCallId,
    expandedWorkflowRunIds: workflowRuns.expandedRunIds,
  });
}
