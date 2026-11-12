import { mergePartialStreamUsage } from "./index.js";

export const cancelledAnthropicPrefix = mergePartialStreamUsage({
  providerKind: "anthropic",
  rawValue: {
    type: "message_start",
    message: { usage: { input_tokens: 4800, output_tokens: 0 } },
  },
});
