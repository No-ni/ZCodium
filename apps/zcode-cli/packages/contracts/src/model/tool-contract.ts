import type { JsonSchema, ModelToolSideEffectScope } from "../protocol-values/contract.js";
import type {
  ProviderNativeToolSpec,
  ToolExecutionMode,
  ToolPermissionSpec,
  ToolResultBudget,
} from "../tools/contract.js";

export interface ModelToolExecutionContext {
  toolCallId: string;
  abortSignal?: AbortSignal;
  traceId?: string;
  metadata?: Record<string, unknown>;
}

export interface ModelToolContract {
  deferLoading?: boolean;
  name: string;
  description?: string;
  capability?: string;
  executionMode?: ToolExecutionMode;
  providerNative?: ProviderNativeToolSpec;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  /** 见 ToolContractDeclaration.strict：严格模式的资格声明，adapter 按 provider/model 落地。 */
  strict?: boolean;
  readOnly?: boolean;
  destructive?: boolean;
  concurrentSafe?: boolean;
  requiresUserInteraction?: boolean;
  maxOutputBytes?: number;
  timeoutMs?: number;
  needsApproval?: boolean;
  sideEffectScope?: ModelToolSideEffectScope;
  permission?: ToolPermissionSpec;
  resultBudget?: ToolResultBudget;
  execute?: (input: unknown, context: ModelToolExecutionContext) => Promise<unknown> | unknown;
}
