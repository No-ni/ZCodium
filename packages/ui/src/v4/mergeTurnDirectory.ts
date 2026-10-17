import type { ConversationTurnDirectoryEntry } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTurnNavigatorItem } from "./conversationTurnNavigatorHelpers.js";

export function mergeTurnDirectory(
  loaded: ConversationTurnNavigatorItem[],
  directory: readonly ConversationTurnDirectoryEntry[] | null | undefined,
  labels: { empty: string; running: string; user: string },
): ConversationTurnNavigatorItem[] {
  if (!directory) return loaded;
  const byRowId = new Map(loaded.map((item) => [item.rowId, item]));
  const result = directory.map((entry): ConversationTurnNavigatorItem => {
    const current = byRowId.get(entry.rowId);
    byRowId.delete(entry.rowId);
    // 已加载正文覆盖目录旧摘要；流式文本不需要重新请求整个目录。
    if (current) return current;
    return {
      ...entry,
      key: `${entry.turnId}:query:${entry.entityId ?? entry.rowId}`,
      unitIndex: -1,
      userPreview: entry.userPreview || labels.user,
      assistantPreview:
        entry.assistantPreview ||
        (entry.assistantPreviewKind === "running" ? labels.running : labels.empty),
    };
  });
  return [...result, ...byRowId.values()].sort((a, b) => a.rowId - b.rowId);
}
