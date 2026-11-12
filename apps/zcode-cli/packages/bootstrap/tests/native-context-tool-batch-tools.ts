import assert from "node:assert/strict";
import { z } from "zod";
import type { ToolEntry } from "@zcode/core";
import { batchSignal, BATCH_CALL_IDS, BATCH_TOOLS } from "./native-context-tool-batch-model.js";

export function gatedBatchTool(
  index: 0 | 1,
  gate: { entered: ReturnType<typeof batchSignal>; release: ReturnType<typeof batchSignal> },
  order: string[],
): ToolEntry {
  const slot = index === 0 ? "first" : "second";
  const inputSchema = z.object({ slot: z.literal(slot) }).strict();
  return {
    capability: "Return one synthetic read-only observation after the fixture gate opens",
    metadata: {
      name: BATCH_TOOLS[index],
      description: "Synthetic real batch observation",
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      sideEffectScope: "none",
      riskLevel: "low",
      needsApproval: false,
    },
    inputSchema: {
      type: "object",
      properties: { slot: { type: "string", enum: [slot] } },
      required: ["slot"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { slot: { type: "string" }, observation: { type: "string" } },
      required: ["slot", "observation"],
      additionalProperties: false,
    },
    runtimeInputSchema: inputSchema,
    permission: {
      permission: "nativeContextBatchFixture",
      reason: "Synthetic read-only test observation",
      riskLevel: "low",
      sideEffectScope: "none",
      needsApproval: false,
      patternSources: ["toolName"],
      denyPriority: "beforeAsk",
    },
    resultBudget: { maxInlineBytes: 4096, maxModelBytes: 4096, strategy: "truncate" },
    timeout: { kind: "none" },
    cancellation: {
      supported: true,
      cleanup: "none",
      userVisibleMessage: "Synthetic tool cancelled",
    },
    trace: {
      required: true,
      propagateToAdapters: false,
      recordInput: "summary",
      recordOutput: "summary",
    },
    async handler(input, context) {
      assert.deepEqual(inputSchema.parse(input), { slot });
      assert.equal(context.toolCallId, BATCH_CALL_IDS[index]);
      assert.equal(context.abortSignal.aborted, false);
      order.push(`tool-${slot}-entered`);
      gate.entered.resolve();
      await gate.release.promise;
      context.abortSignal.throwIfAborted();
      order.push(`tool-${slot}-returned`);
      return { slot, observation: `Synthetic ${slot} observation is complete.` };
    },
  };
}
