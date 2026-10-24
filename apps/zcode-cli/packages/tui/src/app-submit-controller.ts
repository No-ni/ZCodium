import React from "react";
import { isTuiQuitInput } from "./app-input.js";
import type { ModelSelection } from "@zcode/shared";
import type { SessionEvent, TurnId } from "@zcode/contracts";
import { submitDuringActiveTurn, submitIdleTurn } from "./app-submit.js";
import type {
  DraftAttachment,
  Message,
  QueuedInput,
  SelectionState,
  SubmitValueOptions,
  SlashSelectionState,
} from "./app-model.js";
import type { TuiOptions, TuiRequestPermission, TuiSubmitPromptResult } from "./types.js";

export function useSubmitValue(input: {
  activeTurnId?: TurnId;
  applyResult: (result: TuiSubmitPromptResult, preserveTurnState?: boolean) => void;
  applySessionEvent: (event: SessionEvent) => void;
  busy: boolean;
  draftAttachmentsRef: React.MutableRefObject<DraftAttachment[]>;
  emptyPromptStatus: string;
  messageInsertIndex: number;
  options: TuiOptions;
  requestPermission: TuiRequestPermission;
  resolveSubmittedText: (submittedValue: string) => string;
  resolveSubmittedModel?: (submittedValue: string) => ModelSelection | undefined;
  setBusy: (value: boolean) => void;
  setDraftAttachments: React.Dispatch<React.SetStateAction<DraftAttachment[]>>;
  setDraftValue: (value: string) => void;
  setLastError: (message: string | undefined) => void;
  setLiveModelText: (value: string) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setQueuedInputs: React.Dispatch<React.SetStateAction<QueuedInput[]>>;
  setSelection: React.Dispatch<React.SetStateAction<SelectionState | undefined>>;
  setSlashSelection: React.Dispatch<React.SetStateAction<SlashSelectionState | undefined>>;
  setStatus: (status: string) => void;
  setStatusDetails: React.Dispatch<React.SetStateAction<string[]>>;
  getDraftValue(): string;
  isExitRequested(): boolean;
  requestExit(): void;
  quitSummary: string;
  turnRef: React.MutableRefObject<AbortController | undefined>;
}): (submittedValue: string, options?: SubmitValueOptions) => Promise<void> {
  const submissionRevisionRef = React.useRef(0);
  return React.useCallback(
    async (submittedValue: string, options: SubmitValueOptions = {}) => {
      if (input.isExitRequested()) return;
      const revision = ++submissionRevisionRef.current;
      const hasAttachments = input.draftAttachmentsRef.current.length > 0;
      const multiline = /[\r\n]/.test(submittedValue);
      // 原文必须先识别，不能进入模型、历史或 accepted queue；多行/附件不受旧补全折叠影响。
      if (isTuiQuitInput(submittedValue, hasAttachments)) {
        input.requestExit();
        return;
      }
      const resolvedText = input.resolveSubmittedText(submittedValue).trim();
      const text =
        resolvedText.toLowerCase() === "/quit" && (hasAttachments || multiline)
          ? submittedValue
          : resolvedText;
      if (!multiline && isTuiQuitInput(text, hasAttachments)) {
        input.requestExit();
        return;
      }
      const modelSelection = input.resolveSubmittedModel?.(submittedValue);
      if (text.toLowerCase() === "/help quit" && !hasAttachments && !multiline) {
        input.setDraftValue("");
        input.setStatus(`/quit — ${input.quitSummary}`);
        return;
      }
      const applyResult: typeof input.applyResult = (result, preserveTurnState) => {
        if (input.isExitRequested()) return;
        input.applyResult(
          text.toLowerCase() === "/help" && !hasAttachments
            ? { ...result, response: `${result.response}\n/quit — ${input.quitSummary}` }
            : result,
          preserveTurnState,
        );
      };
      const setDraftValue = (value: string) => {
        // rejected sendInput 的迟到回写只能恢复自己的空草稿，不能覆盖后续编辑或退出。
        if (input.isExitRequested() || revision !== submissionRevisionRef.current) return;
        if (value && input.getDraftValue()) return;
        input.setDraftValue(value);
      };
      if (!text) {
        input.setStatus(input.emptyPromptStatus);
        return;
      }

      if (input.busy) {
        await submitDuringActiveTurn({
          activeTurnId: input.activeTurnId,
          applyResult,
          applySessionEvent: input.applySessionEvent,
          draftAttachments: input.draftAttachmentsRef.current,
          messageInsertIndex: input.messageInsertIndex,
          options: input.options,
          requestPermission: input.requestPermission,
          setDraftValue,
          setLastError: input.setLastError,
          setMessages: input.setMessages,
          setQueuedInputs: input.setQueuedInputs,
          setStatus: input.setStatus,
          signal: input.turnRef.current?.signal,
          text,
          modelSelection,
        });
        return;
      }

      await submitIdleTurn({
        applyResult,
        applySessionEvent: input.applySessionEvent,
        draftAttachments: input.draftAttachmentsRef.current,
        options: input.options,
        requestPermission: input.requestPermission,
        setBusy: input.setBusy,
        setDraftAttachments: input.setDraftAttachments,
        setDraftValue,
        setLastError: input.setLastError,
        setLiveModelText: input.setLiveModelText,
        setMessages: input.setMessages,
        setSelection: input.setSelection,
        setSlashSelection: input.setSlashSelection,
        setStatus: input.setStatus,
        setStatusDetails: input.setStatusDetails,
        submitOptions: options,
        text,
        modelSelection,
        turnRef: input.turnRef,
      });
    },
    [input],
  );
}
