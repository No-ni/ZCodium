import { z } from "zod";

export const HookEventName = {
  SessionStart: "SessionStart",
  UserPromptSubmit: "UserPromptSubmit",
  PreToolUse: "PreToolUse",
  PermissionRequest: "PermissionRequest",
  PostToolUse: "PostToolUse",
  PostToolUseFailure: "PostToolUseFailure",
  Stop: "Stop",
} as const;

export type HookEventName = (typeof HookEventName)[keyof typeof HookEventName];

export const HookOutcome = {
  Success: "success",
  Blocked: "blocked",
  Failed: "failed",
  Cancelled: "cancelled",
  TimedOut: "timed_out",
} as const;

export type HookOutcome = (typeof HookOutcome)[keyof typeof HookOutcome];

/**
 * hook 自身出错（非 0 且非 2 退出、超时、输出 JSON 不合 schema）时怎么办。缺省 `allow`：
 * 放行，与引入本字段之前相同。`deny`：只对 PreToolUse 生效，这次出错等同于 hook 以退出码 2
 * 拦截了工具调用。用户中断、未受信任而未运行的工作区 hook、async hook 不受它影响。
 */
export const HookOnError = {
  Allow: "allow",
  Deny: "deny",
} as const;

export type HookOnError = (typeof HookOnError)[keyof typeof HookOnError];

export const HookOnErrorSchema = z.enum([HookOnError.Allow, HookOnError.Deny]);

export const HookSourceKind = {
  User: "user",
  Plugin: "plugin",
  Project: "project",
  Internal: "internal",
} as const;

export type HookSourceKind = (typeof HookSourceKind)[keyof typeof HookSourceKind];

/** Runtime-only provenance attached after user/plugin config validation. */
export interface HookConfigSource {
  kind: "user" | "project" | "internal";
  path?: string;
}

/** Client-safe metadata. Unredacted commands and execution IO must never be added here. */
export interface HookExecutionDescriptor {
  clientVisible: boolean;
  sourceKind: HookSourceKind;
  sourcePath?: string;
  pluginId?: string;
  pluginName?: string;
  statusMessage?: string;
  executionType: "process" | "command";
  executionMode: "foreground" | "background";
  commandDisplay: string;
  timeoutMs: number;
}

export const HookPermissionDecision = {
  Allow: "allow",
  Ask: "ask",
  Deny: "deny",
} as const;

export type HookPermissionDecision =
  (typeof HookPermissionDecision)[keyof typeof HookPermissionDecision];
