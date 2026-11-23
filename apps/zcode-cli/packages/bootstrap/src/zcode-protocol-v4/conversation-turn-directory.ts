import type {
  ConversationRow,
  ConversationTurnDirectoryEntry,
  TurnHeaderRow,
  UserInputRow,
  ConversationSnapshot,
  V4ConversationTurnDirectoryParams,
  V4ConversationTurnDirectoryResult,
} from "@zcode/shared/zcode-protocol-v4";

const PREVIEW_CHARS = 220;

/** 目录派生与缓存属于同一查询所有者；Publisher 只提供权威快照和水位。 */
export class ConversationTurnDirectoryQuery {
  private cache: {
    rows: WeakRef<readonly ConversationRow[]>;
    entries: ConversationTurnDirectoryEntry[];
  } | null = null;

  read(
    snapshot: ConversationSnapshot,
    params: V4ConversationTurnDirectoryParams,
    logEpoch: string,
  ): V4ConversationTurnDirectoryResult {
    // rows 引用变化即为 projection 的新分支；弱引用不额外保留历史正文。
    if (this.cache?.rows.deref() !== snapshot.rows.window) {
      this.cache = {
        rows: new WeakRef(snapshot.rows.window),
        entries: buildConversationTurnDirectory(snapshot.rows.window),
      };
    }
    return {
      ...sliceTurnDirectory(this.cache.entries, params.beforeRowId, params.limit ?? 200),
      atSeq: snapshot.seq,
      atLogEpoch: logEpoch,
    };
  }
}
function preview(text: string): string {
  const normalized = text
    .trim()
    .split(/\n\s*\n/u)
    .map((part) => part.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .slice(0, 2)
    .join("\n");
  return normalized.length <= PREVIEW_CHARS
    ? normalized
    : `${normalized.slice(0, PREVIEW_CHARS - 3).trimEnd()}...`;
}

/** 仅派生摘要；不把完整 user/tool/assistant 行发送给目录消费者。 */
export function buildConversationTurnDirectory(
  rows: readonly ConversationRow[],
): ConversationTurnDirectoryEntry[] {
  const turns = new Map<
    string,
    { header?: TurnHeaderRow; queries: UserInputRow[]; texts: string[]; streaming: boolean }
  >();
  for (const row of rows) {
    let turn = turns.get(row.turnId);
    if (!turn) {
      turn = { queries: [], texts: [], streaming: false };
      turns.set(row.turnId, turn);
    }
    if (row.kind === "turnHeader") turn.header = row;
    if (row.kind === "userInput" && row.origin === "realUser") turn.queries.push(row);
    if (row.kind === "assistantText") {
      turn.texts.push(row.text);
      turn.streaming ||= row.state === "streaming";
    }
  }
  const entries: ConversationTurnDirectoryEntry[] = [];
  for (const [turnId, turn] of turns) {
    const running = turn.header
      ? turn.header.executionKind !== "controlOnly" && turn.header.state === "running"
      : turn.streaming;
    const assistantPreview = preview(turn.texts.join("\n\n"));
    const assistantPreviewKind = turn.texts.length > 0 ? "text" : running ? "running" : "empty";
    turn.queries.forEach((row, index) =>
      entries.push({
        rowId: row.rowId,
        turnId,
        ...(row.entityId ? { entityId: row.entityId } : {}),
        userPreview: preview(row.text),
        assistantPreview,
        assistantPreviewKind,
        isRunning: running && index === turn.queries.length - 1,
      }),
    );
  }
  return entries.sort((left, right) => left.rowId - right.rowId);
}

export function sliceTurnDirectory(
  entries: readonly ConversationTurnDirectoryEntry[],
  beforeRowId: number | undefined,
  limit: number,
) {
  let low = 0;
  let high = entries.length;
  if (beforeRowId !== undefined) {
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (entries[mid]!.rowId < beforeRowId) low = mid + 1;
      else high = mid;
    }
  } else low = entries.length;
  const start = Math.max(0, low - limit);
  return { entries: entries.slice(start, low), hasMore: start > 0 };
}
