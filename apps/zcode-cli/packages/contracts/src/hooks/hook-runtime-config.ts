import { z } from "zod";
import type { ToolCallId } from "../interfaces/shared.js";
import { HookOnError, HookEventName, HookOutcome, HookOnErrorSchema } from "./hook-events.js";
import type { HookConfigSource, HookExecutionDescriptor } from "./hook-events.js";

export interface HookPluginContext {
  dataPath: string;
  id: string;
  name: string;
  rootPath: string;
  /** Actual hooks.json/manifest source. Other plugin consumers may omit it. */
  sourcePath?: string;
}

export interface HookCommandConfig {
  async?: boolean;
  command: string;
  enabled?: boolean;
  onError?: HookOnError;
  plugin?: HookPluginContext;
  shell?: true | string;
  /** Runtime-only provenance; the public config schema deliberately strips this field. */
  source?: HookConfigSource;
  statusMessage?: string;
  timeout?: number;
  timeoutMs?: number;
  type: "command";
}

export interface HookProcessConfig {
  args?: string[];
  command: string;
  enabled?: boolean;
  onError?: HookOnError;
  plugin?: HookPluginContext;
  /** Runtime-only provenance; the public config schema deliberately strips this field. */
  source?: HookConfigSource;
  statusMessage?: string;
  timeoutMs?: number;
  type: "process";
}

export type HookConfig = HookCommandConfig | HookProcessConfig;

export interface HookMatcherConfig {
  hooks: HookConfig[];
  matcher?: string;
}

export interface HooksRuntimeConfig {
  enabled: boolean;
  events: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  maxOutputBytes: number;
  timeoutMs: number;
}

export interface HooksRuntimeConfigPatch {
  enabled?: boolean;
  events?: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  maxOutputBytes?: number;
  timeoutMs?: number;
}

export interface HookRunLifecyclePayload {
  agentName?: string;
  /** New events always carry this; optional keeps old persisted events replayable. */
  descriptor?: HookExecutionDescriptor;
  /** Sanitized human-readable reason when the Hook itself blocked execution. */
  blockReason?: string;
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
  hookEventName: HookEventName;
  hookIndex: number;
  hookCount?: number;
  hookInvocationId?: string;
  hookRunId: string;
  hookSource?: string;
  matcher?: string;
  outcome?: HookOutcome;
  outputBytes?: number;
  requestId?: string;
  startedAt?: number;
  stderrPreview?: string;
  stdoutPreview?: string;
  toolCallId?: ToolCallId | string;
  toolName?: string;
  truncated?: boolean;
}

export const HookProcessConfigSchema = z.object({
  type: z.literal("process"),
  command: z.string().min(1),
  enabled: z.boolean().optional(),
  args: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  statusMessage: z.string().optional(),
  onError: HookOnErrorSchema.optional(),
});

export const HookCommandConfigSchema = z.object({
  type: z.literal("command"),
  command: z.string().min(1),
  enabled: z.boolean().optional(),
  async: z.boolean().optional(),
  shell: z.union([z.literal(true), z.string().min(1)]).optional(),
  timeout: z.number().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  statusMessage: z.string().optional(),
  onError: HookOnErrorSchema.optional(),
});

export const HookConfigSchema = z.discriminatedUnion("type", [
  HookProcessConfigSchema,
  HookCommandConfigSchema,
]);

export const HookMatcherConfigSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(HookConfigSchema).min(1),
});

export const HooksRuntimeConfigPatchSchema = z.object({
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxOutputBytes: z.number().int().positive().optional(),
  events: z
    .object({
      SessionStart: z.array(HookMatcherConfigSchema).optional(),
      UserPromptSubmit: z.array(HookMatcherConfigSchema).optional(),
      PreToolUse: z.array(HookMatcherConfigSchema).optional(),
      PermissionRequest: z.array(HookMatcherConfigSchema).optional(),
      PostToolUse: z.array(HookMatcherConfigSchema).optional(),
      PostToolUseFailure: z.array(HookMatcherConfigSchema).optional(),
      Stop: z.array(HookMatcherConfigSchema).optional(),
    })
    .strict()
    .optional(),
});

export const DefaultHooksRuntimeConfig: HooksRuntimeConfig = {
  enabled: false,
  events: {},
  maxOutputBytes: 32768,
  timeoutMs: 60000,
};
