import { createHash } from "node:crypto";
import { modelMessageContentToText } from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";

export const nativeHash = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
export function nativeRawId(entry: RuntimeMessageEntry): string | null {
  return entry.canonical ? `${entry.canonical.messageId}#e${entry.canonical.entryIndex}` : null;
}
export function nativeEntryText(entry: RuntimeMessageEntry): string {
  return entry.kind === "attachment"
    ? entry.content
    : modelMessageContentToText(entry.message.content);
}
export function historyVersionOf(entries: readonly RuntimeMessageEntry[]): string {
  return nativeHash(
    JSON.stringify(
      entries.map((entry) => ({
        id: nativeRawId(entry),
        role: entry.kind === "attachment" ? "attachment" : entry.message.role,
        text: nativeEntryText(entry),
        calls: entry.kind === "attachment" ? [] : entry.message.toolCalls,
        images:
          entry.kind !== "attachment" && Array.isArray(entry.message.content)
            ? entry.message.content
                .filter((block) => block.type === "image")
                .map((block) => nativeHash(block.dataUrl))
            : [],
      })),
    ),
  );
}
