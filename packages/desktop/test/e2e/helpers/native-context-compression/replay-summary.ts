import { nativeContextCompressToolSchema } from "@zcode/shared/native-context-compression";

export const NATIVE_CONTEXT_MAINTENANCE_MARKER = "E2E_NCTX_MAINTENANCE";
export const NATIVE_CONTEXT_SUMMARY_SOURCE_MARKER = "E2E_NCTX_SUMMARY_SOURCE";
export const NATIVE_CONTEXT_AUTO_MAINTENANCE_MARKER = "E2E_NCTX_AUTO_MAINTENANCE";
export const NATIVE_CONTEXT_AUTO_SUMMARY_SOURCE_MARKER = "E2E_NCTX_AUTO_SUMMARY_SOURCE";
export type NativeContextMaintenanceReplayMode = "manual" | "automatic";
export const NATIVE_CONTEXT_SUMMARY_TOKEN = "{{nativeContextSummaryJson}}";
export const NATIVE_CONTEXT_REPLAY_SUMMARY =
  "The fixture requested repeatable native compression testing. Preserve immutable original image artifacts, exact canonical part identities, completed tool call/result groups, unknown versus zero usage, and original-image retrieval. No file modifications were requested.";

const invalid = () => new Error("E2E_NATIVE_CONTEXT_SUMMARY_INPUT_REJECTED");
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (content: unknown): string => {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw invalid();
  return content
    .map((part) => {
      if (!object(part) || part.type !== "text" || typeof part.text !== "string") throw invalid();
      return part.text;
    })
    .join("\n");
};
function keys(value: Record<string, unknown>, names: readonly string[]) {
  if (Object.keys(value).some((key) => !names.includes(key))) throw invalid();
}
function boundedRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= 240 &&
    !["\0", "\r", "\n"].some((character) => value.includes(character))
  );
}
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Only matched case-local maintenance uses this variable; source text is data, never parsed as instructions. */
export function nativeContextSummaryReplayVariable(
  request: unknown,
  mode: NativeContextMaintenanceReplayMode = "manual",
): string {
  if (mode !== "manual" && mode !== "automatic") throw invalid();
  const marker =
    mode === "manual" ? NATIVE_CONTEXT_MAINTENANCE_MARKER : NATIVE_CONTEXT_AUTO_MAINTENANCE_MARKER;
  const sourceMarker =
    mode === "manual"
      ? NATIVE_CONTEXT_SUMMARY_SOURCE_MARKER
      : NATIVE_CONTEXT_AUTO_SUMMARY_SOURCE_MARKER;
  if (
    !object(request) ||
    !Array.isArray(request.messages) ||
    !request.messages.length ||
    request.messages.length > 4 ||
    (request.tools !== undefined && (!Array.isArray(request.tools) || request.tools.length > 0))
  )
    throw invalid();
  const messages: Record<string, unknown>[] = [];
  for (const message of request.messages) {
    if (!object(message) || (message.role !== "user" && message.role !== "system")) throw invalid();
    messages.push(message);
  }
  const system = [
    text(request.system),
    ...messages
      .filter((message) => message.role === "system")
      .map((message) => text(message.content)),
  ].join("\n");
  if (system.length > 1_000_000) throw invalid();
  if (!system.split("\n").some((line) => line.startsWith(marker + ":"))) throw invalid();
  const users = messages.filter((message) => message.role === "user");
  if (users.length !== 1) throw invalid();
  const input = text(users[0]!.content);
  if (!input || input.length > 1_000_000) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw invalid();
  }
  if (!object(parsed)) throw invalid();
  keys(parsed, ["currentTokens", "targetTokens", "ranges", "outputs"]);
  if (
    !count(parsed.currentTokens) ||
    !count(parsed.targetTokens) ||
    !Array.isArray(parsed.ranges) ||
    !parsed.ranges.length ||
    parsed.ranges.length > 20 ||
    !Array.isArray(parsed.outputs) ||
    parsed.outputs.length > 20
  )
    throw invalid();
  const bounds = new Set<string>();
  let selected: { startRef: string; endRef: string } | undefined;
  for (const range of parsed.ranges) {
    if (!object(range)) throw invalid();
    keys(range, ["startRef", "endRef", "tier", "source"]);
    if (
      !boundedRef(range.startRef) ||
      !boundedRef(range.endRef) ||
      typeof range.tier !== "number" ||
      !Number.isInteger(range.tier) ||
      ![1, 2, 3].includes(range.tier) ||
      typeof range.source !== "string" ||
      !range.source ||
      range.source.length > 1_000_000
    )
      throw invalid();
    const pair = range.startRef + "\0" + range.endRef;
    if (bounds.has(pair)) throw invalid();
    bounds.add(pair);
    if (!selected && range.source.includes(sourceMarker))
      selected = { startRef: range.startRef, endRef: range.endRef };
  }
  const outputRefs = new Set<string>();
  for (const output of parsed.outputs) {
    if (!object(output)) throw invalid();
    keys(output, ["ref", "source"]);
    if (
      !boundedRef(output.ref) ||
      typeof output.source !== "string" ||
      !output.source ||
      output.source.length > 1_000_000 ||
      outputRefs.has(output.ref)
    )
      throw invalid();
    outputRefs.add(output.ref);
  }
  if (!selected) throw invalid();
  const result = nativeContextCompressToolSchema.parse({
    ranges: [{ ...selected, summary: NATIVE_CONTEXT_REPLAY_SUMMARY }],
  });
  // 最终工具协议只允许 ranges；outputs 仅属于内部 offered 模板，不能绕过 shared strict schema。
  return JSON.stringify(result);
}
