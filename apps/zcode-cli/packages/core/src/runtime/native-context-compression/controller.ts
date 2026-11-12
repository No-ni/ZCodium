import {
  nativeContextConfigurationSchema,
  createRecommendedNativeContextConfiguration,
} from "@zcode/shared/native-context-compression";
import type { NativeContextConfiguration } from "@zcode/shared/native-context-compression";
import type { AgentRuntimeInternal } from "../internal.js";
import { createRuntimeCommandId } from "../command-queue.js";
import { createRuntimeModel } from "../methods/runtime-model.js";
import { NativeContextRuntimeError } from "./contract.js";
import type {
  NativeContextPolicyInput,
  NativeContextMaintenanceInput,
  NativeContextOutcome,
} from "./contract.js";
import {
  ensureNativeState,
  nativeOwner,
  nativeStatus,
  writeNativeState,
  kernelOf,
  publishNativeStatus,
} from "./state.js";
import { nativeHash } from "./identity.js";
import { nativeOperation, finishNativeOperation } from "./records.js";
import { syncNativeSources } from "./sources.js";
import { nativeCountTokens } from "./measurements.js";
import { runNativeMaintenance } from "./maintenance.js";
import { validateNativeModelThresholds } from "./budgets.js";
import { freezeNativeMaintenanceGoal } from "./goal-accounting.js";

export async function getNativeContextCompression(this: AgentRuntimeInternal) {
  const owner = nativeOwner(this);
  if (
    this.sessionPersisted &&
    this.sessionStore?.getNativeContextState &&
    this.sessionStore.commitNativeContext
  )
    await ensureNativeState(owner);
  return nativeStatus(owner);
}
export async function configureNativeContextCompression(
  this: AgentRuntimeInternal,
  configuration: NativeContextConfiguration,
) {
  const validated = nativeContextConfigurationSchema.parse(configuration);
  const owner = nativeOwner(this);
  if (!this.sessionPersisted) {
    this.config.nativeContextCompression = structuredClone(validated);
    return nativeStatus(owner);
  }
  await ensureNativeState(owner);
  if (
    JSON.stringify(owner.state!.policy.parameters) === JSON.stringify(validated.parameters) &&
    owner.state!.policy.mode === validated.mode
  )
    return nativeStatus(owner);
  return await setNativeContextPolicy.call(this, {
    configuration: validated,
    expectedPolicyVersion: owner.state!.policy.policyVersion,
  });
}
export async function setNativeContextPolicy(
  this: AgentRuntimeInternal,
  input: NativeContextPolicyInput & { commandId?: string },
) {
  const configuration = nativeContextConfigurationSchema.parse(input.configuration);
  if (this.sessionModelSelection)
    validateNativeModelThresholds(
      configuration.parameters,
      createRuntimeModel(this, { selection: this.sessionModelSelection }),
    );
  const owner = nativeOwner(this);
  if (!this.sessionPersisted) {
    if (input.expectedPolicyVersion !== 0)
      throw new NativeContextRuntimeError("conflict", "policy-version");
    this.config.nativeContextCompression = structuredClone(configuration);
    return nativeStatus(owner);
  }
  await ensureNativeState(owner);
  const commandKey = input.commandId ? nativeHash(input.commandId) : undefined;
  const configurationHash = nativeHash(JSON.stringify(configuration));
  const receipt = commandKey ? kernelOf(owner.state!).policyCommands?.[commandKey] : undefined;
  if (receipt) {
    if (
      receipt.configurationHash !== configurationHash ||
      receipt.expectedVersion !== input.expectedPolicyVersion
    )
      throw new NativeContextRuntimeError("conflict", "command-reuse");
    return nativeStatus(owner);
  }
  await writeNativeState(owner, (candidate) => {
    if (candidate.policy.policyVersion !== input.expectedPolicyVersion)
      throw new NativeContextRuntimeError("conflict", "policy-version");
    candidate.policy = {
      ...structuredClone(configuration),
      policyVersion: candidate.policy.policyVersion + 1,
    };
    if (commandKey) {
      const kernel = kernelOf(candidate);
      kernel.policyCommands ??= {};
      kernel.policyCommands[commandKey] = {
        expectedVersion: input.expectedPolicyVersion,
        configurationHash,
        policyVersion: candidate.policy.policyVersion,
      };
    }
  });
  owner.cancellation?.abort(new Error("native-context-policy-changed"));
  this.config.nativeContextCompression = structuredClone(configuration);
  return nativeStatus(owner);
}
/** 返回持久准备与入队 receipt；终态通过同一状态/记录事件发布。 */
export async function compressNativeContext(
  this: AgentRuntimeInternal,
  input: NativeContextMaintenanceInput,
): Promise<NativeContextOutcome> {
  const owner = nativeOwner(this);
  owner.commandResults ??= new Map();
  const previous = owner.commandResults.get(input.commandId);
  if (previous) return await previous;
  const admission = admitNativeMaintenance(this, input);
  owner.commandResults.set(input.commandId, admission);
  try {
    return await admission;
  } catch (error) {
    owner.commandResults.delete(input.commandId);
    throw error;
  }
}
async function admitNativeMaintenance(
  runtime: AgentRuntimeInternal,
  input: NativeContextMaintenanceInput,
): Promise<NativeContextOutcome> {
  const owner = nativeOwner(runtime);
  if (input.abortSignal.aborted) throw input.abortSignal.reason;
  createRuntimeModel(runtime, { selection: input.model });
  if (!runtime.sessionPersisted)
    await runtime.ensureSessionPersistedForExternalActivity("", {
      traceContext: input.traceContext,
    });
  await ensureNativeState(owner);
  const operation = nativeOperation(owner.state!, {
    kind: "summary",
    trigger: "manual",
    commandId: input.commandId,
    model: input.model,
  });
  const prior = await runtime.sessionStore!.getNativeContextOperation!(
    runtime.sessionId,
    operation.operationId,
  );
  if (prior) return { status: nativeStatus(owner), operation: prior };
  await freezeNativeMaintenanceGoal(runtime);
  if (owner.phase === "compressing")
    throw new NativeContextRuntimeError("busy", "maintenance-pending");
  operation.status = "preparing";
  owner.phase = "compressing";
  try {
    await writeNativeState(owner, () => undefined, { operations: [operation] });
  } catch (error) {
    owner.phase = "idle";
    throw error;
  }
  const finishRejected = async (_error: unknown) => {
    const obsolete = operation.generation !== runtime.branchGeneration;
    if (!obsolete)
      await writeNativeState(owner, () => undefined, {
        operations: [
          finishNativeOperation(
            operation,
            input.abortSignal.aborted ? "cancelled" : "error",
            input.abortSignal.aborted ? "cancelled" : "model-error",
          ),
        ],
      });
    owner.phase = "idle";
    await publishNativeStatus(owner);
  };
  runtime.enqueueRuntimeCommand({
    id: createRuntimeCommandId(),
    createdAt: runtime.now(),
    mode: "native-context-maintenance",
    priority: "later",
    branchGeneration: runtime.branchGeneration,
    traceContext: input.traceContext,
    abortSignal: input.abortSignal,
    run: async (signal) => {
      const entries = runtime.messageHistory.borrowReadOnlyRuntimeEntries();
      await writeNativeState(owner, (candidate) =>
        syncNativeSources(candidate, entries, nativeCountTokens),
      );
      const model = createRuntimeModel(runtime, { selection: input.model });
      owner.inputBudget = validateNativeModelThresholds(owner.state!.policy.parameters, model);
      return await runNativeMaintenance(
        runtime,
        {
          entries,
          model,
          tools: runtime.getTools(model),
          signal,
          traceContext: input.traceContext,
        },
        "manual",
        operation,
      );
    },
    resolve: () => undefined,
    reject: (error) => {
      void finishRejected(error).catch(() => {
        owner.phase = "idle";
      });
    },
  });
  return { status: nativeStatus(owner), operation };
}
export function nativeImagePolicy(runtime: AgentRuntimeInternal) {
  return (
    nativeOwner(runtime).state?.policy.parameters.images ??
    runtime.config.nativeContextCompression?.parameters.images ??
    createRecommendedNativeContextConfiguration().parameters.images
  );
}
