import type { IZCodeAgentService } from "@zcode/services";
import { PROTOCOL_V4_LIMITS, type ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { formatConversationMarkdown } from "@/lib/conversationMarkdown.js";

type ReadRows = IZCodeAgentService["conversationRowsRangeV4"];
export type ConversationMarkdownTarget = Pick<
  Parameters<ReadRows>[0],
  "workspacePath" | "workspaceIdentity" | "remoteSessionId" | "sessionId"
> & {
  title: string;
  showReasoning: boolean;
};

export class ConversationMarkdownError extends Error {
  constructor(readonly code: "changed" | "empty" | "limit" | "read") {
    super(code);
  }
}

/** 不更改 timeline 的已加载窗口；分页失败时不返回部分历史。 */
export async function readConversationMarkdown(
  read: ReadRows,
  target: ConversationMarkdownTarget,
): Promise<string> {
  const { title, showReasoning, ...scope } = target;
  const pages: ConversationRow[][] = [];
  let beforeRowId: number | undefined;
  let revision: number | undefined;
  let epoch: string | undefined;
  let count = 0;
  while (true) {
    const page = await read({
      ...scope,
      ...(beforeRowId === undefined ? {} : { beforeRowId }),
      limit: PROTOCOL_V4_LIMITS.rowsRangeMaxLimit,
    });
    if (
      (revision !== undefined && revision !== page.atRevision) ||
      (epoch !== undefined && epoch !== page.atLogEpoch)
    )
      throw new ConversationMarkdownError("changed");
    revision = page.atRevision;
    epoch = page.atLogEpoch;
    for (let index = 0; index < page.rows.length; index++) {
      const rowId = page.rows[index]!.rowId;
      if (
        !Number.isSafeInteger(rowId) ||
        rowId < 0 ||
        (beforeRowId !== undefined && rowId >= beforeRowId) ||
        (index > 0 && page.rows[index - 1]!.rowId >= rowId)
      )
        throw new ConversationMarkdownError("read");
    }
    count += page.rows.length;
    if (count > 100_000) throw new ConversationMarkdownError("limit");
    pages.push(page.rows);
    if (!page.hasMore) break;
    const next = page.rows[0]?.rowId;
    if (next === undefined) throw new ConversationMarkdownError("read");
    beforeRowId = next;
  }
  const markdown = formatConversationMarkdown(title, pages.reverse().flat(), showReasoning);
  if (!markdown) throw new ConversationMarkdownError("empty");
  if (
    markdown.length > 32 * 1024 * 1024 ||
    new TextEncoder().encode(markdown).length > 32 * 1024 * 1024
  )
    throw new ConversationMarkdownError("limit");
  return markdown;
}
