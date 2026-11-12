const MAX_OFFERED_CHARS = 1_000_000;
const MAX_OFFERED_RANGES = 20;
const MAX_REF_CHARS = 240;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const ref = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_REF_CHARS &&
  value.trim() === value &&
  !/\s/u.test(value) &&
  !value.includes("[") &&
  !value.includes("]") &&
  !value.includes("\0");
const invalid = () =>
  new Error("NCTX interruption has no unique canonical source in the real offered range");

/** 范围可跨多条消息；必须用本场来源所在的真实 header，不能把 startRef 当作来源身份。 */
export function nativeContextOfferedSourceRef(request: unknown, marker: string): string {
  if (
    !object(request) ||
    !Array.isArray(request.messages) ||
    request.messages.length > 4 ||
    !marker ||
    marker.length > MAX_REF_CHARS
  )
    throw invalid();
  const users = request.messages.filter((message) => object(message) && message.role === "user");
  if (users.length !== 1) throw invalid();
  const user = users[0] as Record<string, unknown>;
  const content = user.content;
  const input =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => {
              if (!object(part) || part.type !== "text" || typeof part.text !== "string")
                throw invalid();
              return part.text;
            })
            .join("\n")
        : "";
  if (!input || input.length > MAX_OFFERED_CHARS) throw invalid();
  const parsed: unknown = JSON.parse(input);
  if (
    !object(parsed) ||
    !Array.isArray(parsed.ranges) ||
    !parsed.ranges.length ||
    parsed.ranges.length > MAX_OFFERED_RANGES
  )
    throw invalid();
  const sources = new Set<string>();
  for (const range of parsed.ranges) {
    if (
      !object(range) ||
      !ref(range.startRef) ||
      !ref(range.endRef) ||
      typeof range.source !== "string" ||
      range.source.length > MAX_OFFERED_CHARS
    )
      throw invalid();
    if (!range.source.includes(marker)) continue;
    const headers = [
      ...range.source.matchAll(
        /^\[([^\]\s]+) (?:user|assistant|tool|system|attachment)(?: firstSeen=\d+)?\]\r?\n/gmu,
      ),
    ];
    if (!headers.length || headers[0]![1] !== range.startRef || headers.at(-1)![1] !== range.endRef)
      throw invalid();
    for (const [index, header] of headers.entries()) {
      const body = range.source.slice(header.index! + header[0].length, headers[index + 1]?.index);
      if (!body.split("\n").some((line) => line.startsWith(marker + ":"))) continue;
      if (!ref(header[1])) throw invalid();
      sources.add(header[1]);
    }
  }
  if (sources.size !== 1) throw invalid();
  return [...sources][0]!;
}
