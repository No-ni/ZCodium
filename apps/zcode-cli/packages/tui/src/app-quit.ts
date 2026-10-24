import type { KeyEvent } from "@mbears/opentui-core";
import React from "react";
import { createTuiPermissionRequester } from "./app-permission.js";
import type { ApprovalPrompt, SlashCommand } from "./app-model.js";
import { isTuiQuitInput, printableKey, tuiSlashCommands } from "./app-input.js";

const PENDING_QUIT_MAX_LENGTH = 16;

// 只拥有瞬时审批 UI 与本地退出终态；accepted queue 继续归 runtime，不在退出时清除。
export function useLocalQuit(input: {
  locale: string;
  commands: readonly SlashCommand[] | undefined;
  getDraft(): string;
  hasAttachments(): boolean;
  turnRef: React.MutableRefObject<AbortController | undefined>;
  onExit(code: number): void;
  setStatus(status: string): void;
}) {
  const [approvalQueue, setApprovalQueueState] = React.useState<ApprovalPrompt[]>([]);
  const approvalQueueRef = React.useRef<ApprovalPrompt[]>([]);
  const exitRequestedRef = React.useRef(false);
  const setApprovalQueue = React.useCallback((action: React.SetStateAction<ApprovalPrompt[]>) => {
    // 同批键盘事件先于 React render：ref 是唯一局部 owner，state 只作投影。
    const next = typeof action === "function" ? action(approvalQueueRef.current) : action;
    if (exitRequestedRef.current) {
      for (const approval of next) approval.reject(new Error("TUI is closing"));
      return;
    }
    approvalQueueRef.current = next;
    setApprovalQueueState(next);
  }, []);
  const getCurrentApproval = React.useCallback(() => approvalQueueRef.current[0], []);
  const isExitRequested = React.useCallback(() => exitRequestedRef.current, []);
  const requestExit = React.useCallback(() => {
    if (exitRequestedRef.current) return;
    exitRequestedRef.current = true;
    // 先设终态再取消，避免 abort/reject 的同步回调复活草稿或重复退出。
    input.turnRef.current?.abort();
    for (const approval of approvalQueueRef.current) approval.reject(new Error("TUI is closing"));
    approvalQueueRef.current = [];
    setApprovalQueueState([]);
    input.onExit(0);
  }, [input]);
  const tryQuit = (value = input.getDraft(), origin: "composer" | "approval" = "composer") => {
    if (!isTuiQuitInput(value, origin === "composer" && input.hasAttachments())) return false;
    requestExit();
    return true;
  };
  const quitSummary = localQuitSummary(input.locale);
  const slashCommands = React.useMemo(
    () => tuiSlashCommands(input.commands, quitSummary),
    [input.commands, quitSummary],
  );
  const requestPermission = React.useMemo(
    () => createTuiPermissionRequester({ setApprovalQueue, setStatus: input.setStatus }),
    [setApprovalQueue, input.setStatus],
  );
  return {
    requestPermission,
    approvalQueue,
    setApprovalQueue,
    getCurrentApproval,
    isExitRequested,
    requestExit,
    tryQuit,
    quitSummary,
    slashCommands,
  };
}

export function handleLocalQuitKey(input: {
  key: KeyEvent;
  readOnly: boolean;
  isExitRequested(): boolean;
  getCurrentApproval(): ApprovalPrompt | undefined;
  buffer: { current: string | undefined };
  tryQuit(value?: string, origin?: "composer" | "approval"): boolean;
  hint: string;
  setStatus(value: string): void;
}): boolean {
  if (input.isExitRequested()) return true;
  if (input.readOnly) return false;
  const { key } = input;
  const plainEnter =
    (key.name === "return" || key.name === "linefeed") &&
    !key.shift &&
    !key.option &&
    !key.ctrl &&
    !key.meta;
  const approval = input.getCurrentApproval();
  if (!approval) {
    input.buffer.current = undefined;
    return plainEnter && input.tryQuit();
  }
  // Other 是真实文本输入，不能把 /tmp/path 等答案截成退出手势。
  if (approval.questionState?.editingOther) {
    input.buffer.current = undefined;
    return plainEnter && input.tryQuit(approval.questionState.otherBuffer, "approval");
  }
  return handlePendingQuitKey({ ...input, submit: (value) => input.tryQuit(value, "approval") });
}

// 审批占用键盘时的独立手势，不改 composer、附件或审批决定。
export function handlePendingQuitKey(input: {
  key: KeyEvent;
  buffer: { current: string | undefined };
  hint: string;
  setStatus(value: string): void;
  submit(value: string): void;
}): boolean {
  const { key, buffer } = input;
  if (key.ctrl || key.meta || key.option) {
    buffer.current = undefined;
    return false;
  }
  const char = printableKey(key);
  if (buffer.current === undefined) {
    if (char !== "/") return false;
    buffer.current = "/";
  } else if (key.name === "escape") {
    buffer.current = undefined;
    input.setStatus(input.hint);
    return true;
  } else if ((key.name === "return" || key.name === "linefeed") && !key.shift) {
    const value = buffer.current;
    buffer.current = undefined;
    if (isTuiQuitInput(value)) input.submit(value);
    else input.setStatus(`${input.hint}: /quit`);
    return true;
  } else if (key.name === "backspace") {
    buffer.current = buffer.current.slice(0, -1) || undefined;
  } else if (char !== undefined && buffer.current.length < PENDING_QUIT_MAX_LENGTH) {
    buffer.current += char;
  }
  input.setStatus(`${input.hint}: ${buffer.current ?? ""} · Enter / Esc`);
  return true;
}

export function localQuitSummary(locale: string): string {
  return locale === "zh-CN" ? "退出终端界面" : "Exit the TUI";
}
