import { type ConversationSelectionText } from "@zcode/shared";

export type ConversationSelectionContentType = "user" | "assistant" | "reasoning" | "tool";

/**
 * 选区在来源行里的文字位置，只给正文内的注释标记定位用，不进入发送载荷。
 * regionIndex 是行内第几个 [data-conversation-selectable] 区域，start/end 是该区域
 * 文本节点拼接串里的字符偏移（左闭右开）。
 */
export interface ConversationSelectionTextAnchor {
  regionIndex: number;
  start: number;
  end: number;
  /**
   * 描述时 Range.toString() 去空白后的文字，还原时用同一口径校验。
   * 不能拿 Selection.toString() 比：它会跳过 select-none 节点（如表格工具栏），
   * 跨单元格框选时与 Range 文本不一致，标记会被静默丢掉。
   */
  rangeText?: string;
}

export interface MessageSelectionReference extends ConversationSelectionText {
  id: string;
  sourceSessionId: string;
  sourceRowId: number;
  contentType: ConversationSelectionContentType;
  /** 仅渲染层使用的定位信息；缺失（旧引用、无法定位）时正文不画标记，chip 照常。 */
  anchor?: ConversationSelectionTextAnchor;
}

export interface MarkdownSelectionReference extends ConversationSelectionText {
  id: string;
  contentType: "markdown";
  sourceKey: string;
  sourceTitle: string;
}

export type ConversationSelectionReference = MessageSelectionReference | MarkdownSelectionReference;

export type ConversationSelectionDisplayReference =
  | ConversationSelectionText
  | ConversationSelectionReference;

const USER_SELECT_KEYS = new Set(["text", "path", "comment", "agent"]);

const USER_SELECT_BLOCK_PATTERN = /(?:\n\n)?# userselect:\n```userselect\n([\s\S]*?)\n```\s*$/;

const LEGACY_BLOCK_PATTERN =
  /(?:\n\n)?# Conversation selections:\n```zcode-conversation-selections\n([\s\S]*?)\n```\s*$/;

export function parsePromptConversationSelections(text: string): {
  visibleContent: string;
  references: readonly ConversationSelectionDisplayReference[];
} {
  const userSelectMatch = text.match(USER_SELECT_BLOCK_PATTERN);
  if (userSelectMatch) {
    return parseConversationSelectionBlock(text, userSelectMatch, (value) => {
      if (!isConversationSelectionText(value)) return null;
      // 与发送合同一致，历史保留文件路径、评论与 agent 来源，普通对话继续只恢复正文。
      return {
        ...(value.path ? { path: value.path } : {}),
        text: value.text,
        ...(value.agent ? { agent: value.agent } : {}),
        ...(value.comment ? { comment: value.comment } : {}),
      };
    });
  }
  const legacyMatch = text.match(LEGACY_BLOCK_PATTERN);
  if (!legacyMatch) return { visibleContent: text, references: [] };
  return parseConversationSelectionBlock(text, legacyMatch, (value) =>
    isConversationSelectionReference(value) ? value : null,
  );
}

function parseConversationSelectionBlock<T extends ConversationSelectionDisplayReference>(
  text: string,
  match: RegExpMatchArray,
  parseItem: (value: unknown) => T | null,
): { visibleContent: string; references: readonly T[] } {
  try {
    const parsed = JSON.parse(match[1] ?? "[]");
    if (!Array.isArray(parsed)) throw new Error("selection block is not an array");
    const references: T[] = [];
    for (const value of parsed) {
      const reference = parseItem(value);
      if (!reference) throw new Error("invalid selection reference");
      references.push(reference);
    }
    return {
      visibleContent: text.slice(0, match.index).trimEnd(),
      references,
    };
  } catch {
    return { visibleContent: text, references: [] };
  }
}

function isConversationSelectionText(value: unknown): value is ConversationSelectionText {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ConversationSelectionText>;
  return (
    typeof candidate.text === "string" &&
    (!("path" in value) ||
      (typeof candidate.path === "string" && candidate.path.trim().length > 0)) &&
    (!("comment" in value) || typeof candidate.comment === "string") &&
    (!("agent" in value) || typeof candidate.agent === "string") &&
    Object.keys(value).every((key) => USER_SELECT_KEYS.has(key))
  );
}

export function isConversationSelectionReference(
  value: unknown,
): value is ConversationSelectionReference {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ConversationSelectionReference>;
  if (candidate.contentType === "markdown") {
    return (
      typeof candidate.id === "string" &&
      typeof candidate.text === "string" &&
      typeof candidate.sourceKey === "string" &&
      typeof candidate.sourceTitle === "string"
    );
  }
  return (
    typeof candidate.id === "string" &&
    "sourceSessionId" in candidate &&
    typeof candidate.sourceSessionId === "string" &&
    "sourceRowId" in candidate &&
    typeof candidate.sourceRowId === "number" &&
    typeof candidate.text === "string" &&
    ["user", "assistant", "reasoning", "tool"].includes(candidate.contentType ?? "")
  );
}
export {
  USER_SELECT_KEYS,
  USER_SELECT_BLOCK_PATTERN,
  LEGACY_BLOCK_PATTERN,
  parseConversationSelectionBlock,
  isConversationSelectionText,
};
