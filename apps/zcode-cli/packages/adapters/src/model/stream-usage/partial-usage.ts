import type { LanguageModelUsage } from "ai";
import type { PartialStreamUsageInput } from "./contract.js";

type RawUsage = NonNullable<LanguageModelUsage["raw"]>;
const ANTHROPIC_FIELDS = [
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
];
const GOOGLE_FIELDS = [
  "promptTokenCount",
  "candidatesTokenCount",
  "totalTokenCount",
  "cachedContentTokenCount",
  "thoughtsTokenCount",
];
const OPENAI_CHAT_FIELDS = ["prompt_tokens", "completion_tokens", "total_tokens"];
const OPENAI_RESPONSES_FIELDS = ["input_tokens", "output_tokens", "total_tokens"];
const SERVER_TOOL_FIELDS = ["web_search_requests", "web_fetch_requests"];

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

function numbers(source: Record<string, unknown>, fields: readonly string[]): RawUsage {
  const result: RawUsage = {};
  for (const field of fields)
    if (Object.hasOwn(source, field)) result[field] = count(source[field]) ?? null;
  return result;
}

function rawUsage(raw: Record<string, unknown>, providerKind: string | undefined) {
  if (providerKind === "anthropic") {
    if (raw.type === "message_start") return record(record(raw.message).usage);
    if (raw.type === "message_delta") return record(raw.usage);
  }
  if (providerKind === "google") return record(raw.usageMetadata);
  if (providerKind === "openai" || providerKind === "openai-compatible") {
    if (raw.object === "chat.completion.chunk") return record(raw.usage);
    if (typeof raw.type === "string" && raw.type.startsWith("response."))
      return record(record(raw.response).usage);
  }
  return {};
}

/** 修复依据：SDK finish-step 前取消会丢 message_start 用量；只留真实数字，不把 raw 内容上送。 */
export function mergePartialStreamUsage(
  input: PartialStreamUsageInput,
): Partial<LanguageModelUsage> | undefined {
  const envelope = record(input.rawValue);
  const responses = typeof envelope.type === "string" && envelope.type.startsWith("response.");
  const source = rawUsage(envelope, input.providerKind);
  const fields =
    input.providerKind === "anthropic"
      ? ANTHROPIC_FIELDS
      : input.providerKind === "google"
        ? GOOGLE_FIELDS
        : responses
          ? OPENAI_RESPONSES_FIELDS
          : OPENAI_CHAT_FIELDS;
  const incoming = numbers(source, fields);
  const details: ReadonlyArray<readonly [string, readonly string[]]> =
    input.providerKind === "anthropic"
      ? [["server_tool_use", SERVER_TOOL_FIELDS]]
      : input.providerKind === "google"
        ? []
        : responses
          ? [
              ["input_tokens_details", ["cached_tokens"]],
              ["output_tokens_details", ["reasoning_tokens"]],
            ]
          : [
              ["prompt_tokens_details", ["cached_tokens"]],
              ["completion_tokens_details", ["reasoning_tokens"]],
            ];
  for (const [key, detailFields] of details) {
    if (!Object.hasOwn(source, key)) continue;
    const previous = record(input.previous?.raw?.[key]);
    incoming[key] = { ...previous, ...numbers(record(source[key]), detailFields) } as RawUsage;
  }
  if (Object.keys(incoming).length === 0) return input.previous;
  const raw: RawUsage = { ...input.previous?.raw, ...incoming };
  if (input.providerKind === "anthropic") {
    const base = count(raw.input_tokens);
    return {
      inputTokens:
        base === undefined
          ? undefined
          : base +
            (count(raw.cache_read_input_tokens) ?? 0) +
            (count(raw.cache_creation_input_tokens) ?? 0),
      outputTokens: count(raw.output_tokens),
      totalTokens: count(raw.total_tokens),
      raw,
    };
  }
  if (input.providerKind === "google") {
    const output = count(raw.candidatesTokenCount);
    return {
      inputTokens: count(raw.promptTokenCount),
      outputTokens:
        output === undefined ? undefined : output + (count(raw.thoughtsTokenCount) ?? 0),
      totalTokens: count(raw.totalTokenCount),
      raw,
      outputTokenDetails: { textTokens: output, reasoningTokens: count(raw.thoughtsTokenCount) },
    };
  }
  const outputDetails = record(
    raw[responses ? "output_tokens_details" : "completion_tokens_details"],
  );
  return {
    inputTokens: count(raw[responses ? "input_tokens" : "prompt_tokens"]),
    outputTokens: count(raw[responses ? "output_tokens" : "completion_tokens"]),
    totalTokens: count(raw.total_tokens),
    raw,
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: count(outputDetails.reasoning_tokens),
    },
  };
}
