import type {
  ModelReasoningContentBlock,
  ModelStreamEvent,
  ModelTextResult,
  ModelToolCall,
  ModelUsage,
} from "@zcode/contracts";

/**
 * 把一次 model.streamText 聚合成完整 ModelTextResult。后台辅助任务（Memory
 * Extraction、标题生成）用流式传输避免长响应被网关掐断，但不需要把增量推给 UI，
 * 只在流结束后消费聚合结果。
 */
export async function collectModelStreamResult(input: {
  events: AsyncIterable<ModelStreamEvent>;
}): Promise<ModelTextResult> {
  let text = "";
  let finishReason: string | undefined;
  let providerMetadata: Record<string, unknown> | undefined;
  let usage: ModelUsage = {};
  const toolCalls: ModelToolCall[] = [];
  const reasoning: ModelReasoningContentBlock[] = [];
  const reasoningById = new Map<string, ModelReasoningContentBlock>();

  for await (const event of input.events) {
    switch (event.type) {
      case "text_delta":
        text += event.text;
        break;

      case "reasoning_start": {
        getOrCreateReasoningBlock(event.id, event.providerMetadata, {
          reasoning,
          reasoningById,
        });
        break;
      }

      case "reasoning_delta": {
        const block = getOrCreateReasoningBlock(event.id, event.providerMetadata, {
          reasoning,
          reasoningById,
        });
        block.text += event.text;
        if (event.providerMetadata) block.providerOptions = event.providerMetadata;
        break;
      }

      case "reasoning_end": {
        const block = reasoningById.get(event.id);
        if (block && event.providerMetadata) {
          block.providerOptions = event.providerMetadata;
        }
        reasoningById.delete(event.id);
        break;
      }

      case "tool_call":
        toolCalls.push(event.toolCall);
        break;

      case "finish":
        finishReason = event.finishReason;
        usage = event.usage;
        providerMetadata = event.providerMetadata;
        break;

      case "error":
        throw normalizeCollectedStreamError(event.error);

      case "start":
      case "text_start":
      case "text_end":
      case "tool_input_start":
      case "tool_input_delta":
      case "tool_input_end":
      case "compact_stream_boundary":
        break;
    }
  }

  // 自然截断可能没有 error 事件；未完成的流不能触发记忆写入或持久化半截标题。
  if (finishReason === undefined || finishReason === "error") {
    throw new Error("Model stream ended without a successful finish");
  }

  return {
    finishReason,
    ...(providerMetadata ? { providerMetadata } : {}),
    text,
    ...(reasoning.length > 0 ? { reasoning } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    usage,
  };
}

function getOrCreateReasoningBlock(
  id: string | undefined,
  providerMetadata: Record<string, unknown> | undefined,
  state: {
    reasoning: ModelReasoningContentBlock[];
    reasoningById: Map<string, ModelReasoningContentBlock>;
  },
): ModelReasoningContentBlock {
  const blockId = id ?? "__zcode_default_reasoning__";
  const existing = state.reasoningById.get(blockId);
  if (existing) {
    return existing;
  }

  // Anthropic-compatible providers can emit thinking deltas without a
  // distinct start event; preserve the block for later replay.
  const block: ModelReasoningContentBlock = {
    type: "reasoning",
    text: "",
    ...(providerMetadata ? { providerOptions: providerMetadata } : {}),
  };
  state.reasoningById.set(blockId, block);
  state.reasoning.push(block);
  return block;
}

function normalizeCollectedStreamError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Model stream failed", { cause: error });
}
