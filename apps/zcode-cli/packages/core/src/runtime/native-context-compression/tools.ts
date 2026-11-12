import {
  nativeContextCompressToolSchema,
  nativeContextCompressToolJsonSchema,
  nativeContextSearchToolSchema,
  nativeContextSearchToolJsonSchema,
  nativeContextReadToolSchema,
  nativeContextReadToolJsonSchema,
  nativeContextReadImageToolSchema,
  nativeContextReadImageToolJsonSchema,
} from "@zcode/shared/native-context-compression";
import type { JsonSchema, ModelMessageContent, ModelMessageContentBlock } from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../../tool/types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { NativeContextRuntimeError } from "./contract.js";
import {
  nativeReadOwner,
  nativeSourceForRef,
  ownedNativeImage,
  readNativeContextSource,
} from "./read.js";
import { nativeStatus, writeNativeState } from "./state.js";
import {
  resolveBuiltInToolAllowlist,
  resolveRuntimeDisallowedTools,
} from "../helpers/tool-allowlist.js";
import { validateNativeSummaryCandidate } from "./candidates.js";
import { nativeInputBudget } from "./safe-point.js";
import { nativeOperation, finishNativeOperation, nativeRecordSources } from "./records.js";
import { nativeCountTokens } from "./measurements.js";
import { searchNativeContext } from "./search.js";
import { bindNativeProjectionOperation } from "./projection-operations.js";

function nativeTool(
  name: string,
  description: string,
  schema: JsonSchema,
  runtimeSchema: unknown,
  handler: ToolHandler,
  formatModelContent?: (output: unknown) => ModelMessageContent,
): ToolEntry {
  return {
    capability: description,
    metadata: {
      name,
      description,
      readOnly: name !== "context_compress",
      destructive: false,
      concurrentSafe: name !== "context_compress",
      allowedInPlanMode: true,
      alwaysLoad: true,
      timeoutMs: 30_000,
      maxOutputBytes: 100_000,
      sideEffectScope: "none",
      riskLevel: "low",
      needsApproval: false,
    },
    handler,
    formatModelContent,
    inputSchema: schema,
    outputSchema: { type: "object" },
    runtimeInputSchema: runtimeSchema,
    permission: {
      permission: "read",
      reason: "Read or maintain this session's recoverable context",
      riskLevel: "low",
      sideEffectScope: "none",
      needsApproval: false,
      patternSources: [],
      alwaysAllowPatternSources: [],
      denyPriority: "beforeAsk",
    },
    timeout: { defaultMs: 30_000, maxMs: 30_000, allowCallOverride: false },
    cancellation: {
      supported: true,
      cleanup: "required",
      userVisibleMessage: "Context operation cancelled",
    },
    resultBudget: {
      maxInlineBytes: 100_000,
      maxModelBytes: 100_000,
      strategy: "truncate",
      preview: { direction: "head" },
    },
    trace: {
      required: true,
      propagateToAdapters: true,
      recordInput: "summary",
      recordOutput: "summary",
    },
  };
}
export function registerNativeContextTools(runtime: AgentRuntimeInternal): void {
  if (!runtime.sessionStore?.commitNativeContext) return;
  const allowed = resolveBuiltInToolAllowlist(runtime.config);
  const disallowed = resolveRuntimeDisallowedTools(runtime.config);
  const register = (entry: ToolEntry) => {
    // 原生工具复用既有注册准入，不能读取不存在的配置字段或绕过 child/turn 工具边界。
    if (
      disallowed?.includes(entry.metadata.name) ||
      (allowed && !allowed.includes(entry.metadata.name))
    )
      return;
    runtime.registry.register(entry);
  };
  register(
    nativeTool(
      "context_read",
      "Read a bounded page of the original text behind a current context ref. Use nextOffset to continue; this is read-only.",
      nativeContextReadToolJsonSchema as JsonSchema,
      nativeContextReadToolSchema,
      async (input) => {
        const request = nativeContextReadToolSchema.parse(input);
        const owner = await nativeReadOwner(runtime);
        const limit =
          request.limitTokens ?? owner.state!.policy.parameters.tools.reference.inlineReadTokens;
        return await readNativeContextSource.call(runtime, {
          ...request,
          limitTokens: Math.min(25_000, Math.max(1, limit)),
          expectedRevision: owner.state!.revision,
        });
      },
    ),
  );
  register(
    nativeTool(
      "context_search",
      "Search recoverable original context and summaries in this session. Returns refs and bounded previews; read complete originals with context_read.",
      nativeContextSearchToolJsonSchema as JsonSchema,
      nativeContextSearchToolSchema,
      async (input, context) => {
        return await searchNativeContext(
          runtime,
          nativeContextSearchToolSchema.parse(input),
          context.abortSignal,
        );
      },
    ),
  );
  register(
    nativeTool(
      "context_read_image",
      "Restore the immutable original image for a current context ref for one request. Retrieval follows the same model capability and request capacity limits.",
      nativeContextReadImageToolJsonSchema as JsonSchema,
      nativeContextReadImageToolSchema,
      async (input, context) => {
        const request = nativeContextReadImageToolSchema.parse(input),
          owner = await nativeReadOwner(runtime);
        const source = nativeSourceForRef(owner, request.ref);
        const proved = await ownedNativeImage(owner, source, context.abortSignal);
        if (!proved) throw new NativeContextRuntimeError("unavailable", "original-image");
        owner.restoreImageRefs ??= new Set();
        owner.restoreImageRefs.add(request.ref);
        const block: ModelMessageContentBlock = {
          type: "image",
          mediaType: proved.original.mediaType,
          dataUrl: `data:${proved.original.mediaType};base64,${Buffer.from(proved.bytes).toString("base64")}`,
          source: {
            id: `context-original-${request.ref}`,
            kind: "resource",
            uri: proved.original.artifactUri,
            originalImage: proved.original,
            sha256: proved.original.sha256,
            sizeBytes: proved.original.bytes,
            mimeType: proved.original.mediaType,
          },
        };
        const operation = finishNativeOperation(
          nativeOperation(owner.state!, {
            kind: "restore-image",
            trigger: "model",
            sources: [source],
            anchorMessageId: runtime.latestConversationMessageId,
          }),
          "completed",
        );
        await writeNativeState(owner, () => undefined, { operations: [operation] });
        owner.pendingOperationIds.push(operation.operationId);
        return { ref: request.ref, modelContent: [block] };
      },
      (output) => (output as { modelContent: ModelMessageContent }).modelContent,
    ),
  );
  register(
    nativeTool(
      "context_compress",
      "Compress complete context ranges identified by startRef/endRef. Supply faithful summaries preserving identifiers, decisions and unresolved work. Latest input, protected tools and incomplete exchanges cannot be folded.",
      nativeContextCompressToolJsonSchema as JsonSchema,
      nativeContextCompressToolSchema,
      async (input, context) => {
        const request = nativeContextCompressToolSchema.parse(input),
          owner = await nativeReadOwner(runtime);
        const entries = runtime.messageHistory.borrowReadOnlyRuntimeEntries();
        const budget = context.model ? nativeInputBudget(context.model) : owner.inputBudget;
        if (budget === null) throw new NativeContextRuntimeError("unavailable", "model-budget");
        const facts: {
          operations: import("@zcode/shared/native-context-compression").NativeContextOperation[];
        } = { operations: [] };
        await writeNativeState(
          owner,
          (next) => {
            if (context.abortSignal?.aborted) throw context.abortSignal.reason;
            const validated = validateNativeSummaryCandidate({
              ...request,
              entries,
              state: next,
              inputBudget: budget,
            });
            const operation = nativeOperation(next, {
              kind: "summary",
              trigger: "model",
              anchorMessageId: runtime.latestConversationMessageId,
            });
            operation.blockIds = validated.blockIds;
            operation.sources = nativeRecordSources(
              next.sources.filter((source) => validated.rawIds.includes(source.rawId)),
            );
            operation.summary = request.ranges.map((range) => range.summary).join("\n\n");
            next.kernel = validated.state.kernel;
            bindNativeProjectionOperation(next, operation.operationId, {
              blockIds: validated.blockIds,
            });
            facts.operations.push(finishNativeOperation(operation, "completed"));
          },
          facts,
        );
        const operation = facts.operations[0]!;
        return {
          blockIds: operation.blockIds,
          status: nativeStatus(owner),
          summaryTokens: nativeCountTokens(operation.summary),
        };
      },
    ),
  );
}
