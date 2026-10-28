import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { projectToolReferences } from "../../tool/search/history.js";
import type { Model } from "../deps.js";
import type { AgentRuntimeConfig } from "../types.js";
import {
  buildProviderRequestMessages,
  type ProviderRequestMessageProjectionResult,
} from "./provider-request-messages.js";

export function buildRuntimeProviderRequestMessages(
  runtime: { readonly config: Pick<AgentRuntimeConfig, "midConversationSystem"> },
  input: {
    entries: readonly RuntimeMessageEntry[];
    applyCacheControl?: boolean;
    model: Model;
    /** 主轮已完成 ToolSearch 曝光；其余历史消费者默认按无 ToolSearch 请求降级。 */
    toolSearchProjected?: boolean;
  },
): ProviderRequestMessageProjectionResult {
  const useMidConversationSystem =
    runtime.config.midConversationSystem?.mode === "force" ||
    input.model.properties.supportsMidConversationSystem;
  return buildProviderRequestMessages({
    ...input,
    entries: input.toolSearchProjected
      ? input.entries
      : projectToolReferences(input.entries, "off", []).entries,
    useMidConversationSystem,
  });
}
