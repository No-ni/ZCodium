import { defaultCountTokens } from "acp-kernel";
import {
  parseImageDataUrl,
  type ModelInputMessage,
  type ModelToolContract,
  type ModelUsage,
} from "@zcode/contracts";
import type { NativeContextImageMeasurement } from "@zcode/shared/native-context-compression";
export const nativeCountTokens = defaultCountTokens;
export function nativeTextEstimate(
  messages: readonly ModelInputMessage[],
  tools: readonly ModelToolContract[],
): number {
  let tokens = nativeCountTokens(JSON.stringify(tools));
  for (const message of messages) {
    tokens +=
      4 +
      nativeCountTokens(
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((block) => block.type === "text" || block.type === "reasoning")
              .map((block) => block.text)
              .join("\n"),
      );
    if (message.toolCalls?.length) tokens += nativeCountTokens(JSON.stringify(message.toolCalls));
  }
  return tokens;
}
export function nativeMeasurementScope(
  messages: readonly ModelInputMessage[],
): "complete" | "text-only" {
  return messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((block) => block.type !== "text" && block.type !== "reasoning"),
  )
    ? "text-only"
    : "complete";
}
export function nativeKnownCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}
/** 真实 0 保留；缺 input 可用同响应 total-output，不能将缺报告当成零。 */
export function nativeActualInput(usage?: ModelUsage): number | null {
  const input = nativeKnownCount(usage?.inputTokens);
  if (input !== null) return input;
  const total = nativeKnownCount(usage?.totalTokens),
    output = nativeKnownCount(usage?.outputTokens);
  return total !== null && output !== null ? Math.max(0, total - output) : null;
}
export function nativeImageBytes(messages: readonly ModelInputMessage[]): {
  count: number;
  coverage: number;
  bytes: number | null;
} {
  let count = 0,
    coverage = 0,
    bytes = 0;
  for (const message of messages)
    if (Array.isArray(message.content))
      for (const block of message.content)
        if (block.type === "image") {
          count++;
          const parsed = parseImageDataUrl(block.dataUrl);
          if (parsed) {
            coverage++;
            bytes += parsed.data.byteLength;
          }
        }
  return { count, coverage, bytes: coverage === count ? bytes : null };
}
export function nativeImageMeasurement(
  before: readonly ModelInputMessage[],
  after: readonly ModelInputMessage[],
  changes: Partial<
    Pick<
      NativeContextImageMeasurement,
      "omittedCount" | "foldedCount" | "resizedCount" | "restoredCount"
    >
  > = {},
): NativeContextImageMeasurement {
  const original = nativeImageBytes(before),
    sent = nativeImageBytes(after);
  return {
    sourceCount: original.count,
    sourceCoverage: original.coverage,
    sentCount: sent.count,
    omittedCount: 0,
    foldedCount: 0,
    resizedCount: 0,
    restoredCount: 0,
    beforeBytes: original.bytes,
    afterBytes: sent.bytes,
    ...changes,
  };
}
