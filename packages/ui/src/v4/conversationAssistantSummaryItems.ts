import { isSessionToolName } from "@/ToolCallBlocks/session/contract.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import * as workflowToolNames from "@/lib/workflowToolNames.js";
import { isZCodeCuaToolName } from "@/lib/cuaPermissionAction.js";
import { joinFilePath } from "@/lib/path.js";
import { readRawToolCallFileSummaries } from "@/ToolCallBlocks/fileSummaries.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import type { ConversationReasoningVisibility } from "@/v4/conversationRowContext.js";
import type { AssistantWorkRow } from "@/v4/conversationTurnRenderUnits.js";
import {
  buildAssistantWorkRenderItems as buildGroupedItems,
  type ConversationAssistantWorkRenderItem as GroupedItem,
} from "@/v4/conversationAssistantWorkItems.js";
export type ConversationAssistantWorkRenderItem = Extract<
  GroupedItem,
  { kind: "row" | "agentToolCall" }
>;
export function isFlatAssistantWorkItem(
  item: GroupedItem,
): item is ConversationAssistantWorkRenderItem {
  return item.kind === "row" || item.kind === "agentToolCall";
}
export function buildAssistantWorkRenderItems(
  rows: readonly AssistantWorkRow[],
  visibility: ConversationReasoningVisibility & { messageStreamShowTodos?: boolean },
) {
  return buildGroupedItems(rows, visibility, {
    enableCuaGrouping: false,
    enableExploreGrouping: false,
    enableTerminalGrouping: false,
    enableChangesGrouping: false,
  }).filter(isFlatAssistantWorkItem);
}
// 本仓专用分组仍是边界；只在普通连续工具间运用上游摘要算法，不能吞掉CUA真实关系。
export function groupConsecutiveAssistantSummaries(items: readonly GroupedItem[]) {
  const groups: { key: string; items: GroupedItem[] }[] = [];
  let flat: ConversationAssistantWorkRenderItem[] = [];
  const flush = () => {
    groups.push(...groupConsecutiveFlatAssistantSummaries(flat));
    flat = [];
  };
  for (const item of items) {
    if (isFlatAssistantWorkItem(item)) flat.push(item);
    else {
      flush();
      groups.push({ key: item.key, items: [item] });
    }
  }
  flush();
  return groups;
}
export function getAssistantSummaryToolCategory(
  row: AssistantWorkRow,
): "explore" | "run" | "change" | "session" | null {
  if (row.kind !== "toolCall" || row.status === "pendingApproval") return null;
  const tool = toolCallRowToLegacyNode(row).toolCall;
  // 复用专用 renderer 的名字判定，避免 snake_case workflow 被通用 list/search 归类吞掉。
  if (Object.values(workflowToolNames).some((matches) => matches(tool))) return null;
  // 会话工具保留独立类别以维持代表图标优先级，统计时按调用次数合入执行数量。
  if (isSessionToolName(tool.toolName ?? tool.kind)) return "session";
  const family = resolveToolCallIdentity(tool).family;
  if (["file-read", "search", "web-fetch", "explore"].includes(family)) return "explore";
  if (
    family === "shell" ||
    family === "node-repl" ||
    [tool.toolName, tool.kind].some(isZCodeCuaToolName)
  )
    return "run";
  if (family === "file-write") return "change";
  return null;
}

/** 正文、Workflow、Subagent 与未归类工具是边界；不重新拼接真实工具关系。 */
export function groupConsecutiveFlatAssistantSummaries(
  items: readonly ConversationAssistantWorkRenderItem[],
) {
  const groups: { key: string; items: ConversationAssistantWorkRenderItem[] }[] = [];
  let current: (typeof groups)[number] | undefined;
  for (const item of items) {
    const summary =
      item.kind !== "agentToolCall" &&
      (item.row.kind === "reasoning" || getAssistantSummaryToolCategory(item.row) !== null);
    if (!summary) {
      groups.push({ key: item.key, items: [item] });
      current = undefined;
      continue;
    }
    if (!current) {
      current = { key: item.key, items: [] };
      groups.push(current);
    }
    current.items.push(item);
  }
  return groups;
}

// 工具行不可变；过去只缓存路径，文件列表仍在每次渲染重建 diff。两处共用完整摘要缓存。
const fileSummariesByRow = new WeakMap<
  ToolCallRow,
  ReturnType<typeof readRawToolCallFileSummaries>
>();
function fileSummaries(row: ToolCallRow) {
  const cached = fileSummariesByRow.get(row);
  if (cached) return cached;
  const tool = toolCallRowToLegacyNode(row).toolCall;
  const summaries = readRawToolCallFileSummaries(tool.raw, tool);
  fileSummariesByRow.set(row, summaries);
  return summaries;
}
function changedPaths(row: ToolCallRow): readonly string[] {
  // filePath 是目录展示字段；计数使用包含文件名的原始完整 path。
  return fileSummaries(row)
    .map((file) => file.path)
    .filter(Boolean);
}

// 路径别名曾被当作不同文件；计数和列表必须共用词法去重键，不依赖宿主文件系统。
function summaryFilePath(path: string, workspacePath?: string): string {
  const joined = (workspacePath ? joinFilePath(workspacePath, path) : path).replace(/\\/g, "/");
  const root = joined.startsWith("//")
    ? (joined.match(/^\/\/[^/]+\/[^/]+/)?.[0] ?? "//")
    : (joined.match(/^[A-Za-z]:\//)?.[0] ?? (joined.startsWith("/") ? "/" : ""));
  const parts: string[] = [];
  for (const part of joined.slice(root.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || !root) parts.push(part);
  }
  return root + (root && !root.endsWith("/") && parts.length ? "/" : "") + parts.join("/");
}

export function formatAssistantSummaryStatistics(
  items: readonly ConversationAssistantWorkRenderItem[],
  intl: IntlInstance,
  workspacePath?: string,
  completed = false,
): string {
  let explore = 0,
    run = 0,
    unresolved = 0;
  const files = new Set<string>();
  for (const item of items) {
    const category =
      item.kind === "agentToolCall" ? null : getAssistantSummaryToolCategory(item.row);
    if (category === "explore") explore++;
    // 统计工具调用，不统计返回的目标数；同一会话的多次操作也分别计数。
    if (category === "run" || category === "session") run++;
    if (category === "change" && item.row.kind === "toolCall") {
      const paths = changedPaths(item.row);
      if (!paths.length) unresolved++;
      for (const path of paths) files.add(summaryFilePath(path, workspacePath));
    }
  }
  const parts = (
    [
      ["explore", explore],
      ["run", run],
      ["change", files.size],
      ["unresolved", unresolved],
    ] as const
  )
    .filter(([, count]) => count > 0)
    .map(([category, count]) =>
      // 项目 intl 只替换占位符，不解析 ICU；复用 one/other 键，避免把模板原文显示给用户。
      intl.formatMessage(
        {
          id: `chat.summaryGroup.${category}.${completed ? "completed." : ""}${count === 1 ? "one" : "other"}`,
        },
        { count },
      ),
    );
  return (
    parts.join(intl.formatMessage({ id: "chat.summaryGroup.separator" })) ||
    intl.formatMessage({ id: "chat.summaryGroup.reasoning" })
  );
}

/** 整轮可见尾项决定可追加的组；不能把 history/正文的展示拆分当成独立生命周期。 */
export function getAssistantSummaryTailRowId(
  rows: readonly ConversationRow[],
  visibility: ConversationReasoningVisibility & { messageStreamShowTodos?: boolean },
): number | undefined {
  if (rows.at(-1)?.kind === "userInput") return undefined;
  const workRows = rows.filter(
    (row): row is AssistantWorkRow => row.kind !== "turnHeader" && row.kind !== "userInput",
  );
  return buildAssistantWorkRenderItems(workRows, visibility).at(-1)?.row.rowId;
}

/** 活动摘要与结构闭合分别派生，不能把暂时没有活动项误判为闭合。 */
export function getActiveAssistantSummaryItem(
  items: readonly ConversationAssistantWorkRenderItem[],
) {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    const row = item.row;
    if (
      row.kind === "reasoning"
        ? row.state === "streaming"
        : row.kind === "toolCall" && (row.status === "inputStreaming" || row.status === "running")
    )
      return item;
  }
  return undefined;
}

/** 只为统计选择代表图标，不改变工具顺序或活动摘要的图标。 */
export function getAssistantSummaryIconItem(items: readonly ConversationAssistantWorkRenderItem[]) {
  let selected: ConversationAssistantWorkRenderItem | undefined;
  let selectedPriority = Infinity;
  for (const item of items) {
    const category = getAssistantSummaryToolCategory(item.row);
    if (!category || item.row.kind !== "toolCall") continue;
    const tool = toolCallRowToLegacyNode(item.row).toolCall;
    const priority = [tool.toolName, tool.kind].some(isZCodeCuaToolName)
      ? 0
      : resolveToolCallIdentity(tool).family === "node-repl"
        ? 1
        : category === "change"
          ? 2
          : category === "run"
            ? 3
            : 4;
    if (priority < selectedPriority) {
      selected = item;
      selectedPriority = priority;
    }
  }
  return selected;
}

/** 仅 Change 的计数可展示文件；思考不计数，混合工具保留原统计。 */
export function getAssistantSummaryChangeFiles(
  items: readonly ConversationAssistantWorkRenderItem[],
  workspacePath?: string,
) {
  const files = new Map<string, ReturnType<typeof readRawToolCallFileSummaries>[number]>();
  let unresolved = 0;
  for (const item of items) {
    const category = getAssistantSummaryToolCategory(item.row);
    if (category && category !== "change") return undefined;
    if (category !== "change" || item.row.kind !== "toolCall") continue;
    const summaries = fileSummaries(item.row);
    if (!summaries.length) unresolved++;
    for (const file of summaries) {
      const path = summaryFilePath(file.path, workspacePath);
      if (!files.has(path)) files.set(path, { ...file, path });
    }
  }
  return files.size ? { files: [...files.values()], unresolved } : undefined;
}
