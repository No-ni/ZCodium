import type { NativeContextStoredState } from "@zcode/shared/native-context-compression";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { NativeSummaryRange } from "./guards.js";
import { coreMessagesOf } from "./sources.js";
import { kernelOf } from "./state.js";
import { nativeCountTokens } from "./measurements.js";

/** 有界批次只能在完整消息组及完整工具配对之间切分，不能截断正文。 */
export function splitNativeRange(
  entries: readonly RuntimeMessageEntry[],
  state: NativeContextStoredState,
  maximumTokens: number,
): NativeSummaryRange[] {
  const lastIndex = new Map<string, number>();
  entries.forEach((entry, index) => {
    if (entry.canonical) lastIndex.set(entry.canonical.messageId, index);
  });
  const pending = new Map<string, number>();
  const spans = new Map<number, number>();
  entries.forEach((entry, index) => {
    if (entry.kind === "attachment") return;
    for (const call of entry.message.toolCalls ?? []) pending.set(call.id, index);
    if (entry.message.toolCallId) {
      const start = pending.get(entry.message.toolCallId);
      if (start !== undefined) {
        spans.set(start, Math.max(spans.get(start) ?? start, index));
        pending.delete(entry.message.toolCallId);
      }
    }
  });
  for (const start of pending.values()) spans.set(start, entries.length - 1);
  const atoms: RuntimeMessageEntry[][] = [];
  let start = 0,
    end = 0;
  entries.forEach((entry, index) => {
    end = Math.max(
      end,
      entry.canonical ? lastIndex.get(entry.canonical.messageId)! : index,
      spans.get(index) ?? index,
    );
    if (index === end) {
      atoms.push(entries.slice(start, index + 1));
      start = index + 1;
    }
  });
  const ranges: NativeSummaryRange[] = [];
  let batch: RuntimeMessageEntry[] = [],
    tokens = 0;
  const flush = () => {
    const cores = coreMessagesOf(batch, state);
    const rawIds = cores.map((core) => core.id);
    const chars = cores.reduce((sum, core) => sum + (core.text?.length ?? 0), 0);
    if (rawIds.length && chars >= state.policy.parameters.summary.minRangeChars) {
      const refs = kernelOf(state).compression.messageRefs.byRaw;
      ranges.push({
        entries: batch,
        rawIds,
        chars,
        tokens,
        startRef: refs[rawIds[0]!]!,
        endRef: refs[rawIds.at(-1)!]!,
      });
    }
    batch = [];
    tokens = 0;
  };
  for (const atom of atoms) {
    const atomTokens = coreMessagesOf(atom, state).reduce(
      (sum, core) => sum + nativeCountTokens(core.text ?? ""),
      0,
    );
    if (tokens + atomTokens > maximumTokens) flush();
    if (atomTokens > maximumTokens) continue;
    batch.push(...atom);
    tokens += atomTokens;
  }
  flush();
  return ranges;
}
