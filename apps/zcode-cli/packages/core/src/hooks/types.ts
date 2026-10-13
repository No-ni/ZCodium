import type {
  ExecutionPort,
  HookEventName,
  HookExecutionDescriptor,
  HookInput,
  HookJSONOutput,
  HookPermissionDecision,
  HookSourceKind,
  HooksRuntimeConfig,
  WorkspaceHookBundleSnapshot,
  Logger,
  PermissionRequestHookDecision,
  SessionEvent,
} from "@zcode/contracts";

import type { WorkspaceHookRuntimeAdmissionPort } from "./workspace-hook-runtime-admission.js";

export interface HookCallbackContext {
  hookIndex: number;
  signal?: AbortSignal;
}

/**
 * 配置 Hook 的执行器可以附带 stderr 等诊断；这些信息只进入生命周期事件，
 * 不参与 Hook 决策，也不会作为 Hook JSON 输出暴露给模型。
 */
export interface HookCallbackDiagnostics {
  errorMessage?: string;
  stderrPreview?: string;
  stdoutPreview?: string;
}

export interface HookCallbackResult {
  kind: "hookCallbackResult";
  diagnostics?: HookCallbackDiagnostics;
  output?: HookJSONOutput;
}

export type HookCallback = (
  input: HookInput,
  context: HookCallbackContext,
) =>
  | HookJSONOutput
  | HookCallbackResult
  | void
  | Promise<HookJSONOutput | HookCallbackResult | void>;

export interface HookRunAdmissionDecision {
  allowed: boolean;
  reasonCode?: string;
  skipLifecycle?: boolean;
}

export interface HookRegistration {
  admission?: (input: HookInput) => HookRunAdmissionDecision;
  async?: boolean;
  callback: HookCallback;
  descriptor?: HookExecutionDescriptor | ((input: HookInput) => HookExecutionDescriptor);
  event: HookEventName;
  matcher?: string;
  source?: string;
  sourceKind?: HookSourceKind;
  timeoutMs?: number;
}

export interface HookRunOptions {
  matchValue?: string;
  matchValues?: readonly string[];
  signal?: AbortSignal;
}

export interface HookRunResult {
  additionalContexts: string[];
  blockRequested?: boolean;
  hookPermissionDecisionReason?: string;
  permissionBehavior?: HookPermissionDecision;
  permissionRequestResult?: PermissionRequestHookDecision;
  preventContinuation?: boolean;
  stopShouldContinue?: boolean;
  stopReason?: string;
  updatedInput?: unknown;
}

export interface HookRunner {
  run(input: HookInput, options?: HookRunOptions): Promise<HookRunResult>;
}

export interface HookRunnerOptions {
  defaultTimeoutMs?: number;
  emitEvent?: (event: SessionEvent) => Promise<void>;
  hooks?: HookRegistration[];
  logger?: Logger;
}

export interface ConfiguredHookRunnerOptions {
  config: HooksRuntimeConfig;
  emitEvent?: (event: SessionEvent) => Promise<void>;
  executionPort: ExecutionPort;
  /**
   * Hook 的兜底执行 cwd，也是 `CLAUDE_PROJECT_DIR`/`ZCODE_PROJECT_DIR` 与
   * `${...PROJECT_DIR}` 展开的基准：它是**模型当前 cwd**（runtime 侧为
   * `runtime.workingDirectory`，Bash `cd` 之后跟着走），hook 脚本因此作用在模型正在编辑的
   * 目录上。工作区级的是 hooks 的**发现与信任**根（`workspaceScopeRootOf(runtime)`）。
   */
  getWorkingDirectory: () => string;
  logger?: Logger;
  workspaceHookAdmission?: WorkspaceHookRuntimeAdmissionPort;
  workspaceHookSnapshot?: WorkspaceHookBundleSnapshot;
}
