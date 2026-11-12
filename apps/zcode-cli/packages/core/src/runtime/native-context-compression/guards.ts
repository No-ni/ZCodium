import { activeBlocks, matchToolPattern } from "acp-kernel";
import type { NativeContextStoredState } from "@zcode/shared/native-context-compression";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { nativeRawId } from "./identity.js";
import { kernelOf } from "./state.js";
import { coreMessagesOf } from "./sources.js";
import { nativeEarlyFoldGroups, nativeProtectedToolGroups } from "./soft-protection.js";
import { nativeImageHardProtectedGroups, nativeUserTurnStarts } from "./image-identity.js";

export const nativeToolMatches = (name: string | undefined, patterns: readonly string[]): boolean =>
  Boolean(name && patterns.some((pattern) => matchToolPattern(name, pattern)));
export const nativeMessageId = (rawId: string): string => rawId.split("#e")[0]!;
export const nativeRealUser = (entry: RuntimeMessageEntry): boolean =>
  entry.kind !== "attachment" &&
  entry.message.role === "user" &&
  (!entry.metadata || entry.metadata.source === "real_user");
export interface NativeSummaryRange {
  entries: RuntimeMessageEntry[];
  rawIds: string[];
  startRef: string;
  endRef: string;
  tokens: number;
  chars: number;
  blockIds?: string[];
  tier?: 1 | 2 | 3;
}

/** 保护先按真实消息判定，再扩展到同消息全部 entry 与完整工具配对。 */
export function protectedNativeIds(
  entries: readonly RuntimeMessageEntry[],
  state: NativeContextStoredState,
  countTokens: (text: string) => number,
): Set<string> {
  const policy = state.policy.parameters;
  const groups = new Set<string>();
  const add = (entry: RuntimeMessageEntry | undefined) => {
    if (entry?.canonical) groups.add(entry.canonical.messageId);
  };
  const earlyFoldGroups = nativeEarlyFoldGroups(entries, state);
  const addRecent = (entry: RuntimeMessageEntry | undefined) => {
    if (entry?.canonical && !earlyFoldGroups.has(entry.canonical.messageId)) add(entry);
  };
  const userIndices = nativeUserTurnStarts(entries);
  const latestUser = userIndices.at(-1) ?? 0;
  for (let index = latestUser; index < entries.length; index++) add(entries[index]);
  const keepFrom = userIndices.at(-policy.history.preserveTurns);
  if (policy.history.preserveTurns > 0 && keepFrom !== undefined)
    for (let index = keepFrom; index < entries.length; index++) addRecent(entries[index]);
  const distinctTail = new Set<string>();
  let tailTokens = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const item = entries[index]!;
    const messageId = item.canonical?.messageId;
    if (!messageId) continue;
    if (
      distinctTail.size < policy.history.preserveMessages ||
      tailTokens < policy.history.preserveTokens
    )
      addRecent(item);
    distinctTail.add(messageId);
    tailTokens += coreMessagesOf([item], state).reduce(
      (sum, core) => sum + countTokens(core.text ?? ""),
      0,
    );
  }
  const pending = new Map<string, RuntimeMessageEntry>();
  const pairs: [RuntimeMessageEntry, RuntimeMessageEntry][] = [];
  for (const id of nativeProtectedToolGroups(entries, state)) groups.add(id);
  for (const id of nativeImageHardProtectedGroups(entries, state)) groups.add(id);
  for (const item of entries) {
    if (item.kind === "attachment") {
      add(item);
      continue;
    }
    if (!item.canonical || item.message.role === "system") {
      add(item);
      continue;
    }
    const content = item.message.content;
    if (
      Array.isArray(content) &&
      content.some((block) =>
        block.type === "image"
          ? false
          : block.type === "reasoning"
            ? Boolean(block.providerOptions && Object.keys(block.providerOptions).length)
            : block.type !== "text",
      )
    )
      add(item);
    for (const call of item.message.toolCalls ?? []) {
      pending.set(call.id, item);
      if (
        nativeToolMatches(call.name, policy.history.protectedTools) ||
        (call.providerOptions && Object.keys(call.providerOptions).length)
      )
        add(item);
    }
    if (item.message.role === "tool") {
      const paired = item.message.toolCallId ? pending.get(item.message.toolCallId) : undefined;
      if (paired) {
        pairs.push([paired, item]);
        pending.delete(item.message.toolCallId!);
      } else add(item);
      if (nativeToolMatches(item.message.toolName, policy.history.protectedTools)) add(item);
    }
  }
  for (const item of pending.values()) add(item);
  // 一个消息可含多轮服务端工具；固定点扩展防止保留半对调用。
  let changed = true;
  while (changed) {
    const before = groups.size;
    for (const [call, result] of pairs)
      if (groups.has(call.canonical!.messageId) || groups.has(result.canonical!.messageId)) {
        add(call);
        add(result);
      }
    changed = groups.size !== before;
  }
  const ids = new Set<string>();
  for (const item of entries)
    if (item.canonical && groups.has(item.canonical.messageId)) {
      const raw = nativeRawId(item)!;
      ids.add(raw);
      if (item.kind !== "attachment")
        for (let index = 0; index < (item.message.toolCalls?.length ?? 0); index++)
          ids.add(`${raw}:c${index}`);
    }
  return ids;
}

export function nativeSummaryRanges(
  entries: readonly RuntimeMessageEntry[],
  state: NativeContextStoredState,
  countTokens: (text: string) => number,
): NativeSummaryRange[] {
  const protectedIds = protectedNativeIds(entries, state, countTokens);
  const compression = kernelOf(state).compression;
  const covered = new Set(
    activeBlocks(compression).flatMap((block) => block.effectiveMessageIds.map(nativeMessageId)),
  );
  const ranges: NativeSummaryRange[] = [];
  let run: RuntimeMessageEntry[] = [];
  const flush = () => {
    // 根因：一条 assistant 可展开 entry 与多个 call；漏 call 会让摘要只覆盖半条持久消息。
    const cores = coreMessagesOf(run, state);
    const rawIds = cores.map((core) => core.id);
    const chars = cores.reduce((sum, core) => sum + (core.text?.length ?? 0), 0);
    const startRef = compression.messageRefs.byRaw[rawIds[0]!],
      endRef = compression.messageRefs.byRaw[rawIds.at(-1)!];
    if (
      rawIds.length &&
      startRef &&
      endRef &&
      rawIds.every((raw) => compression.messageRefs.byRaw[raw]) &&
      chars >= state.policy.parameters.summary.minRangeChars
    ) {
      ranges.push({
        entries: run,
        rawIds,
        chars,
        tokens: cores.reduce((sum, core) => sum + countTokens(core.text ?? ""), 0),
        startRef,
        endRef,
      });
    }
    run = [];
  };
  const spans = new Map<
    string,
    { first: number; last: number; count: number; eligible: boolean }
  >();
  entries.forEach((item, index) => {
    const messageId = item.canonical?.messageId,
      raw = nativeRawId(item);
    if (!messageId) return;
    const eligible =
      item.kind !== "attachment" &&
      Boolean(raw) &&
      !protectedIds.has(raw!) &&
      !covered.has(messageId);
    const span = spans.get(messageId);
    if (span) {
      span.last = index;
      span.count++;
      span.eligible &&= eligible;
    } else spans.set(messageId, { first: index, last: index, count: 1, eligible });
  });
  for (const item of entries) {
    const raw = nativeRawId(item);
    const span = item.canonical ? spans.get(item.canonical.messageId) : undefined;
    // 跨其它消息/attachment 的非连续分片不能成为两个独立摘要范围，必须整组排除。
    if (!raw || !span?.eligible || span.last - span.first + 1 !== span.count) flush();
    else run.push(item);
  }
  flush();
  return ranges;
}
