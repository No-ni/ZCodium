import type { AssistantTextRow, UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import type { ChatSearchResultHighlightRequest } from "@/v4/legacyChatViewTypes.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";
import { projectAssistantCodeComments } from "@/lib/assistantCodeComment.js";

export type ConversationFindRowKind = "userInput" | "assistantText";

export interface ConversationFindMatch {
  globalIndex: number;
  unitIndex: number;
  rowId: number;
  rowKind: ConversationFindRowKind;
  rowMatchIndex: number;
  start: number;
  end: number;
  sourceText: string;
}

interface ConversationFindIndex {
  query: string;
  matches: ConversationFindMatch[];
  matchCount: number;
  loadedRowCount: number;
}

export interface ConversationFindMatchKey {
  rowId: number;
  rowKind: ConversationFindRowKind;
  rowMatchIndex: number;
}

interface ConversationFindTarget {
  unitIndex: number;
  rowId: number;
  rowKind: ConversationFindRowKind;
  text: string;
}

function normalizeConversationFindQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

function addTargetsForUnit(
  targets: ConversationFindTarget[],
  unit: ConversationTurnRenderUnit,
  unitIndex: number,
  projectCodeComments: boolean,
) {
  const latestAssistantState = unit.latestAssistantTextRow?.state;
  const projectUnitCodeComments =
    projectCodeComments &&
    (unit.isRunning ||
      latestAssistantState === "complete" ||
      latestAssistantState === "interrupted");
  for (const row of unit.visibleUserInputs) {
    targets.push(createTarget(unitIndex, row));
  }
  for (const row of unit.assistantTextRows) {
    targets.push({
      ...createTarget(unitIndex, row),
      text: projectUnitCodeComments
        ? projectAssistantCodeComments(row.text, {
            streaming: row.state === "streaming",
          }).visibleText
        : row.text,
    });
  }
}

function createTarget(
  unitIndex: number,
  row: UserInputRow | AssistantTextRow,
): ConversationFindTarget {
  return {
    unitIndex,
    rowId: row.rowId,
    rowKind: row.kind,
    text: row.text,
  };
}

export function buildConversationFindIndex(
  units: readonly ConversationTurnRenderUnit[],
  query: string,
  options: { projectAssistantCodeComments?: boolean } = {},
): ConversationFindIndex {
  const normalizedQuery = normalizeConversationFindQuery(query);
  if (!normalizedQuery) {
    // 搜索关闭时也会随流式轮次更新调用；只计数，避免构造 target 和解析整段评论正文。
    return {
      query: normalizedQuery,
      matches: [],
      matchCount: 0,
      loadedRowCount: units.reduce(
        (count, unit) => count + unit.visibleUserInputs.length + unit.assistantTextRows.length,
        0,
      ),
    };
  }

  const targets: ConversationFindTarget[] = [];
  units.forEach((unit, unitIndex) =>
    addTargetsForUnit(targets, unit, unitIndex, options.projectAssistantCodeComments === true),
  );

  const matches: ConversationFindMatch[] = [];
  for (const target of targets) {
    const normalizedText = target.text.toLocaleLowerCase();
    let searchStart = 0;
    let rowMatchIndex = 0;
    while (searchStart < normalizedText.length) {
      const matchIndex = normalizedText.indexOf(normalizedQuery, searchStart);
      if (matchIndex === -1) {
        break;
      }
      matches.push({
        globalIndex: matches.length,
        unitIndex: target.unitIndex,
        rowId: target.rowId,
        rowKind: target.rowKind,
        rowMatchIndex,
        start: matchIndex,
        end: matchIndex + normalizedQuery.length,
        sourceText: target.text,
      });
      rowMatchIndex += 1;
      searchStart = matchIndex + normalizedQuery.length;
    }
  }

  return {
    query: normalizedQuery,
    matches,
    matchCount: matches.length,
    loadedRowCount: targets.length,
  };
}

export function getConversationFindMatchKey(
  match: ConversationFindMatch | null | undefined,
): ConversationFindMatchKey | null {
  if (!match) {
    return null;
  }
  return {
    rowId: match.rowId,
    rowKind: match.rowKind,
    rowMatchIndex: match.rowMatchIndex,
  };
}

export function findConversationMatchIndexByKey(
  index: ConversationFindIndex,
  key: ConversationFindMatchKey | null | undefined,
): number {
  if (!key) {
    return -1;
  }
  return index.matches.findIndex(
    (match) =>
      match.rowId === key.rowId &&
      match.rowKind === key.rowKind &&
      match.rowMatchIndex === key.rowMatchIndex,
  );
}

export function resolveConversationFindActiveIndex(
  index: ConversationFindIndex,
  preferredIndex: number,
): number {
  if (index.matchCount === 0) {
    return -1;
  }
  if (preferredIndex >= 0 && preferredIndex < index.matchCount) {
    return preferredIndex;
  }
  return 0;
}

function normalizeSearchResultProbeText(text: string): string {
  return text
    .replace(/^\.{3}/, "")
    .replace(/\.{3}$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function resolveSearchResultHighlightMatch(
  index: ConversationFindIndex,
  request: ChatSearchResultHighlightRequest,
): ConversationFindMatch | null {
  if (index.matchCount === 0) {
    return null;
  }

  const snippet = request.snippet?.trim();
  if (snippet) {
    const probe = normalizeSearchResultProbeText(snippet).toLocaleLowerCase();
    // 同一正文的每个查询命中都携带 sourceText；逐命中规范化会把长正文处理放大为平方量。
    // 仅在本次定位内跳过已检查文本，仍按原 matches 顺序返回首个命中对象。
    const checkedSources = new Set<string>();
    if (probe) {
      for (const match of index.matches) {
        if (checkedSources.has(match.sourceText)) continue;
        checkedSources.add(match.sourceText);
        if (normalizeSearchResultProbeText(match.sourceText).toLocaleLowerCase().includes(probe)) {
          return match;
        }
      }
    }
  }

  const preferredIndex = request.snippetIndex ?? 0;
  return index.matches[preferredIndex] ?? index.matches[0] ?? null;
}
