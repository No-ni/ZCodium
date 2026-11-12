import { matchToolPattern } from "acp-kernel";
import type { NativeContextStoredState } from "@zcode/shared/native-context-compression";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";

const matches = (name: string, patterns: readonly string[]) =>
  patterns.some((pattern) => matchToolPattern(name, pattern));
type Pair = { name: string; call: string; result?: string };
function toolPairs(entries: readonly RuntimeMessageEntry[]): Pair[] {
  const pairs: Pair[] = [],
    pending = new Map<string, Pair>();
  for (const entry of entries) {
    if (entry.kind === "attachment" || !entry.canonical) continue;
    for (const call of entry.message.toolCalls ?? []) {
      const pair = { name: call.name, call: entry.canonical.messageId };
      pairs.push(pair);
      pending.set(call.id, pair);
    }
    if (entry.message.role === "tool" && entry.message.toolCallId) {
      const pair = pending.get(entry.message.toolCallId);
      if (pair) {
        pair.result = entry.canonical.messageId;
        pending.delete(entry.message.toolCallId);
      }
    }
  }
  return pairs;
}
export function nativeEarlyFoldGroups(
  entries: readonly RuntimeMessageEntry[],
  state: NativeContextStoredState,
): Set<string> {
  const policy = state.policy.parameters.history;
  const pairs = toolPairs(entries),
    eligible = new Set<string>(),
    excluded = new Set<string>();
  for (const pair of pairs) {
    const accept =
      pair.result &&
      matches(pair.name, policy.earlyFoldTools) &&
      !matches(pair.name, policy.preserveRecentTools);
    const target = accept ? eligible : excluded;
    target.add(pair.call);
    if (pair.result) target.add(pair.result);
  }
  let changed = true;
  while (changed) {
    const before = excluded.size;
    for (const pair of pairs)
      if (excluded.has(pair.call) || (pair.result && excluded.has(pair.result))) {
        excluded.add(pair.call);
        if (pair.result) excluded.add(pair.result);
      }
    changed = before !== excluded.size;
  }
  for (const id of excluded) eligible.delete(id);
  return eligible;
}
/** protectedLatest 只保护各实际工具名称的最后完整实例，再扩展同消息的配对。 */
export function nativeProtectedToolGroups(
  entries: readonly RuntimeMessageEntry[],
  state: NativeContextStoredState,
): Set<string> {
  const policy = state.policy.parameters.history;
  const pairs = toolPairs(entries),
    protectedGroups = new Set<string>(),
    latest = new Map<string, Pair>();
  for (const pair of pairs) {
    if (matches(pair.name, policy.protectedTools)) {
      protectedGroups.add(pair.call);
      if (pair.result) protectedGroups.add(pair.result);
    }
    if (matches(pair.name, policy.protectedLatestTools)) latest.set(pair.name, pair);
  }
  for (const pair of latest.values()) {
    protectedGroups.add(pair.call);
    if (pair.result) protectedGroups.add(pair.result);
  }
  for (const entry of entries)
    if (
      entry.kind !== "attachment" &&
      entry.canonical &&
      entry.message.role === "tool" &&
      entry.message.toolName &&
      matches(entry.message.toolName, policy.protectedTools)
    )
      protectedGroups.add(entry.canonical.messageId);
  let changed = true;
  while (changed) {
    const before = protectedGroups.size;
    for (const pair of pairs)
      if (protectedGroups.has(pair.call) || (pair.result && protectedGroups.has(pair.result))) {
        protectedGroups.add(pair.call);
        if (pair.result) protectedGroups.add(pair.result);
      }
    changed = before !== protectedGroups.size;
  }
  return protectedGroups;
}
