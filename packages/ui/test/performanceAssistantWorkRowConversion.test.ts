import { describe, expect, it, vi } from "vitest";
import type {
  AssistantTextRow,
  ReasoningRow,
  SubagentRow,
  ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  buildAssistantWorkRenderItems,
  ENABLE_CHANGES_TOOL_CALL_GROUPING,
  ENABLE_EXPLORE_TOOL_CALL_GROUPING,
  ENABLE_TERMINAL_TOOL_CALL_GROUPING,
  type ConversationAssistantWorkRenderItem,
} from "@/v4/conversationAssistantWorkItems.js";
import type { AssistantWorkRow } from "@/v4/conversationTurnRenderUnits.js";
import { ENABLE_CUA_TOOL_CALL_GROUPING, prepareCuaGroups } from "@/v4/conversationCuaGroups.js";
import {
  isConversationReasoningRowVisible,
  type ConversationReasoningVisibility,
} from "@/v4/conversationRowContext.js";
import { isExploreToolCall, isShellToolCallAwaitingCommand } from "@/lib/exploreToolCall.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import * as toolCallRowAdapterModule from "@/v4/toolCallRowAdapter.js";
import * as toolIdentityModule from "@/lib/toolIdentity.js";

/**
 * Regression: assistant work-item projection re-derives each tool call row.
 *
 * Rationale lives in the candidate report for this round: inside one
 * `buildAssistantWorkRenderItems` pass the same ToolCallRow was converted by
 * `toolCallRowToLegacyNode` once per classification predicate (explore check,
 * execute check, and the inputStreaming/running shell "awaiting command" check),
 * and `isExecuteToolCall` re-resolved tool identity and tool commands on the same
 * {kind, input} up to three times. Streaming projection rebuilds rows every frame,
 * so the repeated derivations accumulate per frame.
 *
 * This file freezes the pre-change implementation as an oracle (never shipped):
 * every predicate converts the row again, and the old isExecuteToolCall derivation
 * is inlined. Production output must stay item-for-item identical, while the
 * in-call legacy conversion / identity resolution budgets lock the reduction.
 */

// ────────────────────────────────────────────
// Synthetic rows
// ────────────────────────────────────────────

const TURN_ID = "turn-1";

function baseRow(rowId: number) {
  return { rowId, turnId: TURN_ID, createdAt: 1_700_000_000_000, createdAtSeq: rowId };
}

function toolRow(rowId: number, toolName: string, fields: Partial<ToolCallRow> = {}): ToolCallRow {
  return {
    ...baseRow(rowId),
    kind: "toolCall",
    toolCallId: "call-" + rowId,
    toolName,
    status: "success",
    inputText: "",
    ...fields,
  };
}

function textRow(rowId: number, fields: Partial<AssistantTextRow> = {}): AssistantTextRow {
  return {
    ...baseRow(rowId),
    kind: "assistantText",
    text: "answer " + rowId,
    state: "complete",
    ...fields,
  };
}

function reasoningRow(rowId: number, fields: Partial<ReasoningRow> = {}): ReasoningRow {
  return {
    ...baseRow(rowId),
    kind: "reasoning",
    text: "think " + rowId,
    state: "complete",
    ...fields,
  };
}

function subagentRow(rowId: number, fields: Partial<SubagentRow> = {}): SubagentRow {
  return {
    ...baseRow(rowId),
    kind: "subagent",
    subagentType: "general-purpose",
    status: "success",
    summaryText: "done",
    ...fields,
  };
}

function markerRow(rowId: number): AssistantWorkRow {
  return {
    ...baseRow(rowId),
    kind: "timelineMarker",
    marker: { type: "compact", status: "running" },
  } as unknown as AssistantWorkRow;
}

function artifactRow(rowId: number): AssistantWorkRow {
  return {
    ...baseRow(rowId),
    kind: "artifact",
    artifactVersionId: "v1",
    logicalArtifactKey: "key-" + rowId,
    displayName: "artifact " + rowId,
    artifactType: "text",
    mimeType: "text/plain",
    sizeBytes: 1,
    sha256: "0".repeat(64),
    ref: "ref-" + rowId,
    state: "current",
  } as unknown as AssistantWorkRow;
}

// ────────────────────────────────────────────
// Frozen pre-change oracle (never shipped)
// ────────────────────────────────────────────

const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task", "subagent"]);

function oracleIsToolCallRow(row: AssistantWorkRow): row is ToolCallRow {
  return row.kind === "toolCall";
}

function oracleIsAgentToolCallRow(row: AssistantWorkRow): row is ToolCallRow {
  return oracleIsToolCallRow(row) && SUBAGENT_TOOL_NAMES.has(row.toolName);
}

/** Frozen call pattern: every predicate converts the whole row again. */
function oracleIsExploreToolCallRow(row: AssistantWorkRow): row is ToolCallRow {
  if (!oracleIsToolCallRow(row)) return false;
  const legacyNode = toolCallRowToLegacyNode(row);
  return isExploreToolCall({ kind: legacyNode.toolCall.kind, input: legacyNode.toolCall.input });
}

/** Frozen isExecuteToolCall derivation inlined: identity and commands re-resolved. */
function oracleIsExecuteToolCallRow(row: AssistantWorkRow): row is ToolCallRow {
  if (!oracleIsToolCallRow(row)) return false;
  const legacyNode = toolCallRowToLegacyNode(row);
  const { kind, input } = legacyNode.toolCall;
  const identity = resolveToolCallIdentity({ kind, input });
  return (
    identity.family === "shell" &&
    !isShellToolCallAwaitingCommand({ kind, input }) &&
    !isExploreToolCall({ kind, input })
  );
}

function oracleIsChangesToolCallRow(row: AssistantWorkRow): row is ToolCallRow {
  if (!oracleIsToolCallRow(row)) return false;
  return resolveToolCallIdentity(toolCallRowToLegacyNode(row).toolCall).family === "file-write";
}

function oracleShouldDeferUnclassifiedShellToolCall(row: AssistantWorkRow): boolean {
  if (!oracleIsToolCallRow(row) || (row.status !== "inputStreaming" && row.status !== "running")) {
    return false;
  }
  const legacyNode = toolCallRowToLegacyNode(row);
  return isShellToolCallAwaitingCommand({
    kind: legacyNode.toolCall.kind,
    input: legacyNode.toolCall.input,
  });
}

function oracleResolveGroupStageStatus(
  rows: readonly ToolCallRow[],
  stageTailIsRunning: boolean,
): string {
  if (stageTailIsRunning) return "in_progress";
  return rows.some((row) => row.status === "cancelled") ? "stopped" : "completed";
}

type ExploreGroupItem = Extract<ConversationAssistantWorkRenderItem, { kind: "exploreGroup" }>;
type ExecuteGroupItem = Extract<ConversationAssistantWorkRenderItem, { kind: "executeGroup" }>;
type ChangesGroupItem = Extract<ConversationAssistantWorkRenderItem, { kind: "changesGroup" }>;

function oracleBuildExploreGroup(
  rows: ToolCallRow[],
  stageTailIsRunning: boolean,
): ExploreGroupItem {
  const firstRow = rows[0]!;
  const childToolCalls = rows.map(toolCallRowToLegacyNode);
  return {
    kind: "exploreGroup",
    key: "explore:" + firstRow.rowId,
    rowId: firstRow.rowId,
    rows,
    node: {
      toolCall: {
        toolId: "explore:" + firstRow.toolCallId,
        toolName: "Explore",
        kind: "Explore",
        title: "Explore",
        input: {},
        status: oracleResolveGroupStageStatus(rows, stageTailIsRunning),
        startedAt: typeof firstRow.startedAt === "number" ? firstRow.startedAt : undefined,
      },
      childToolCalls,
    },
  };
}

function oracleBuildExecuteGroup(
  rows: ToolCallRow[],
  stageTailIsRunning: boolean,
): ExecuteGroupItem {
  const firstRow = rows[0]!;
  return {
    kind: "executeGroup",
    key: "execute:" + firstRow.rowId,
    rowId: firstRow.rowId,
    rows,
    node: {
      toolCall: {
        toolId: "execute:" + firstRow.toolCallId,
        toolName: "ExecuteGroup",
        kind: "executeGroup",
        title: "Execute",
        input: {},
        status: oracleResolveGroupStageStatus(rows, stageTailIsRunning),
        startedAt: typeof firstRow.startedAt === "number" ? firstRow.startedAt : undefined,
      },
      childToolCalls: rows.map(toolCallRowToLegacyNode),
    },
  };
}

function oracleBuildChangesGroup(
  rows: ToolCallRow[],
  stageTailIsRunning: boolean,
): ChangesGroupItem {
  const firstRow = rows[0]!;
  return {
    kind: "changesGroup",
    key: "changes:" + firstRow.rowId,
    rowId: firstRow.rowId,
    rows,
    node: {
      toolCall: {
        toolId: "changes:" + firstRow.toolCallId,
        toolName: "ChangesGroup",
        kind: "changesGroup",
        title: "Changes",
        input: {},
        status: stageTailIsRunning ? "in_progress" : "completed",
      },
      childToolCalls: rows.map(toolCallRowToLegacyNode),
    },
  };
}

function oraclePairSubagentRows(rows: readonly AssistantWorkRow[]): {
  subagentByAgentToolRowId: Map<number, SubagentRow>;
  claimedSubagentRowIds: Set<number>;
} {
  const subagentByAgentToolRowId = new Map<number, SubagentRow>();
  const claimedSubagentRowIds = new Set<number>();
  const agentToolByTurnAndCallId = new Map<string, ToolCallRow>();
  const agentToolRows: ToolCallRow[] = [];
  const subagentRows: SubagentRow[] = [];
  const legacySubagentRows: SubagentRow[] = [];

  for (const row of rows) {
    if (oracleIsAgentToolCallRow(row)) {
      agentToolRows.push(row);
      agentToolByTurnAndCallId.set(row.turnId + "\u0000" + row.toolCallId, row);
    } else if (row.kind === "subagent") {
      subagentRows.push(row);
    }
  }
  for (const row of subagentRows) {
    if (!row.parentToolCallId) {
      legacySubagentRows.push(row);
      continue;
    }
    const host = agentToolByTurnAndCallId.get(row.turnId + "\u0000" + row.parentToolCallId);
    if (host && host.turnId === row.turnId && !subagentByAgentToolRowId.has(host.rowId)) {
      subagentByAgentToolRowId.set(host.rowId, row);
      claimedSubagentRowIds.add(row.rowId);
    }
  }

  const remainingAgentToolsByTurn = new Map<string, ToolCallRow[]>();
  for (const row of agentToolRows) {
    if (subagentByAgentToolRowId.has(row.rowId)) continue;
    const turnRows = remainingAgentToolsByTurn.get(row.turnId);
    if (turnRows) {
      turnRows.push(row);
    } else {
      remainingAgentToolsByTurn.set(row.turnId, [row]);
    }
  }
  const legacySubagentsByTurn = new Map<string, SubagentRow[]>();
  for (const row of legacySubagentRows) {
    const turnRows = legacySubagentsByTurn.get(row.turnId);
    if (turnRows) {
      turnRows.push(row);
    } else {
      legacySubagentsByTurn.set(row.turnId, [row]);
    }
  }
  for (const [turnId, subagentRowsForTurn] of legacySubagentsByTurn) {
    const toolRows = remainingAgentToolsByTurn.get(turnId);
    if (toolRows?.length !== 1 || subagentRowsForTurn.length !== 1) continue;
    const host = toolRows[0];
    const subagent = subagentRowsForTurn[0];
    if (!host || !subagent) continue;
    subagentByAgentToolRowId.set(host.rowId, subagent);
    claimedSubagentRowIds.add(subagent.rowId);
  }

  return { subagentByAgentToolRowId, claimedSubagentRowIds };
}

interface OracleOptions {
  stageTailIsRunning?: boolean;
  enableCuaGrouping?: boolean;
  enableExploreGrouping?: boolean;
  enableTerminalGrouping?: boolean;
  enableChangesGrouping?: boolean;
}

/** Line-for-line equivalent of the pre-change implementation; comparison baseline only. */
function oracleBuildAssistantWorkRenderItems(
  rows: readonly AssistantWorkRow[],
  reasoningVisibility: ConversationReasoningVisibility,
  options?: OracleOptions,
): ConversationAssistantWorkRenderItem[] {
  const items: ConversationAssistantWorkRenderItem[] = [];
  const enableExploreGrouping = options?.enableExploreGrouping ?? ENABLE_EXPLORE_TOOL_CALL_GROUPING;
  const enableCuaGrouping = options?.enableCuaGrouping ?? ENABLE_CUA_TOOL_CALL_GROUPING;
  const enableTerminalGrouping =
    options?.enableTerminalGrouping ?? ENABLE_TERMINAL_TOOL_CALL_GROUPING;
  const enableChangesGrouping = options?.enableChangesGrouping ?? ENABLE_CHANGES_TOOL_CALL_GROUPING;
  const visibleRows = rows.filter((row) => {
    if (
      row.kind === "reasoning" &&
      !isConversationReasoningRowVisible(row.rowId, reasoningVisibility)
    ) {
      return false;
    }
    return !oracleShouldDeferUnclassifiedShellToolCall(row);
  });
  const { subagentByAgentToolRowId, claimedSubagentRowIds } = oraclePairSubagentRows(visibleRows);
  const preparedRows = prepareCuaGroups(
    visibleRows,
    enableCuaGrouping,
    options?.stageTailIsRunning === true,
  );
  let index = 0;

  while (index < preparedRows.length) {
    const row = preparedRows[index];
    if (!row) {
      index += 1;
      continue;
    }

    if (row.kind === "cuaGroup") {
      items.push(row);
      index += 1;
      continue;
    }

    if (row.kind === "subagent" && claimedSubagentRowIds.has(row.rowId)) {
      index += 1;
      continue;
    }
    if (oracleIsToolCallRow(row)) {
      const pairedSubagent = subagentByAgentToolRowId.get(row.rowId);
      if (pairedSubagent) {
        items.push({
          kind: "agentToolCall",
          key: "agent:" + row.rowId,
          row,
          subagentRow: pairedSubagent,
        });
        index += 1;
        continue;
      }
    }

    const isExploreRow = oracleIsExploreToolCallRow(row);
    if (!isExploreRow) {
      if (enableChangesGrouping && oracleIsChangesToolCallRow(row)) {
        const groupRows: ToolCallRow[] = [row];
        index += 1;
        while (index < preparedRows.length) {
          const nextRow = preparedRows[index];
          if (!nextRow || nextRow.kind === "cuaGroup" || !oracleIsChangesToolCallRow(nextRow))
            break;
          groupRows.push(nextRow);
          index += 1;
        }
        if (groupRows.length === 1) {
          const singleRow = groupRows[0]!;
          items.push({ kind: "row", key: "row:" + singleRow.rowId, row: singleRow });
          continue;
        }
        items.push(
          oracleBuildChangesGroup(
            groupRows,
            options?.stageTailIsRunning === true && index === preparedRows.length,
          ),
        );
        continue;
      }
      if (enableTerminalGrouping && oracleIsExecuteToolCallRow(row)) {
        const groupRows: ToolCallRow[] = [row];
        index += 1;
        while (index < preparedRows.length) {
          const nextRow = preparedRows[index];
          if (!nextRow || nextRow.kind === "cuaGroup" || !oracleIsExecuteToolCallRow(nextRow)) {
            break;
          }
          groupRows.push(nextRow);
          index += 1;
        }
        if (groupRows.length === 1) {
          const singleRow = groupRows[0]!;
          items.push({ kind: "row", key: "row:" + singleRow.rowId, row: singleRow });
          continue;
        }
        items.push(
          oracleBuildExecuteGroup(
            groupRows,
            options?.stageTailIsRunning === true && index === preparedRows.length,
          ),
        );
        continue;
      }
      items.push({
        kind: "row",
        key: "row:" + row.rowId,
        row,
      });
      index += 1;
      continue;
    }

    if (!enableExploreGrouping) {
      items.push({
        kind: "row",
        key: "row:" + row.rowId,
        row,
      });
      index += 1;
      continue;
    }

    const groupRows: ToolCallRow[] = [row];
    index += 1;
    while (index < preparedRows.length) {
      const nextRow = preparedRows[index];
      if (!nextRow || nextRow.kind === "cuaGroup" || !oracleIsExploreToolCallRow(nextRow)) {
        break;
      }
      groupRows.push(nextRow);
      index += 1;
    }
    if (groupRows.length === 1) {
      items.push({ kind: "row", key: "row:" + row.rowId, row });
      continue;
    }
    items.push(
      oracleBuildExploreGroup(
        groupRows,
        options?.stageTailIsRunning === true && index === preparedRows.length,
      ),
    );
  }

  return items;
}
// ────────────────────────────────────────────
// Equivalence helper
// ────────────────────────────────────────────

const DEFAULT_VISIBILITY: ConversationReasoningVisibility = { messageStreamShowReasoning: true };

function expectMatchesOracle(
  rows: AssistantWorkRow[],
  visibility: ConversationReasoningVisibility = DEFAULT_VISIBILITY,
  options?: OracleOptions,
): ConversationAssistantWorkRenderItem[] {
  const production = buildAssistantWorkRenderItems(rows, visibility, options);
  const oracle = oracleBuildAssistantWorkRenderItems(rows, visibility, options);
  expect(production).toEqual(oracle);
  return production;
}

function rowIdsOfItems(items: ConversationAssistantWorkRenderItem[]): number[] {
  return items.flatMap((item) => {
    if (item.kind === "row" || item.kind === "agentToolCall") return [item.row.rowId];
    if (
      item.kind === "exploreGroup" ||
      item.kind === "executeGroup" ||
      item.kind === "changesGroup" ||
      item.kind === "cuaGroup"
    ) {
      return item.rows.map((row) => row.rowId);
    }
    return [];
  });
}

describe("assistant work item projection equivalence", () => {
  it("locks the shell classification matrix and read/write grouping", () => {
    const rows: AssistantWorkRow[] = [
      toolRow(1, "Bash", { input: { command: "rg --files" } }),
      toolRow(2, "Bash", { input: { command: "ls -la" } }),
      toolRow(3, "Bash", { input: { command: "rm -rf build" } }),
      toolRow(4, "Bash", { input: { command: "mv a b" } }),
      toolRow(5, "Bash", { input: { command: "echo hi > out.txt" } }),
      toolRow(6, "Bash", { input: { command: "for f in *.md; do cat $f; done" } }),
      toolRow(7, "Bash", { status: "inputStreaming", inputText: "" }),
      toolRow(8, "Bash", { status: "inputStreaming", inputText: '{"command":"rg --fi' }),
      toolRow(9, "Read", { input: { file_path: "/repo/a.ts" } }),
    ];
    const items = expectMatchesOracle(rows);
    const kinds = items.map((item) => item.kind);
    // [rg,ls] 探索分组；[rm,mv,echo>] 执行分组（重定向写入不是探索）；
    // [for-loop,流式半截,Read] 探索分组（半截输入经预览解析出命令）。
    expect(kinds).toEqual(["exploreGroup", "executeGroup", "exploreGroup"]);
    const rowIds = rowIdsOfItems(items);
    // 等待命令输入的 shell 必须被推迟，不进入任何渲染项。
    expect(rowIds).not.toContain(7);
    // 流式半截输入必须经预览解析后参与探索分组判定。
    expect(rowIds).toContain(8);
    expect(rowIds).toEqual([1, 2, 3, 4, 5, 6, 8, 9]);
  });

  it("locks known tool families, legacy kinds and array commands", () => {
    const rows: AssistantWorkRow[] = [
      toolRow(1, "Read", { input: { file_path: "/a.ts" } }),
      textRow(2),
      toolRow(3, "Grep", { input: { pattern: "x" } }),
      textRow(4),
      toolRow(5, "Edit", { input: { file_path: "/a.ts", old_string: "a", new_string: "b" } }),
      textRow(6),
      toolRow(7, "Write", { input: { file_path: "/b.ts", content: "x" } }),
      textRow(8),
      toolRow(9, "TodoWrite", { input: { todos: [] } }),
      textRow(10),
      toolRow(11, "EnterPlanMode", { input: {} }),
      textRow(12),
      toolRow(13, "Foo", { input: { anything: 1 } }),
      textRow(14),
      toolRow(15, "Explore", { input: { query: "auth" } }),
      textRow(16),
      toolRow(17, "Execute", { input: { command: "pnpm test" } }),
      textRow(18),
      toolRow(19, "Bash", { input: { command: ["zsh", "-lc", "ls -la"] } }),
      textRow(20),
      toolRow(21, "Bash", { input: { command: ["bash", "-c", "rm -rf x"] } }),
    ];
    const items = expectMatchesOracle(rows);
    // 正文行同为 AssistantWorkRow，逐一成为独立渲染项；工具行彼此隔离，不形成分组。
    expect(items.map((item) => item.kind)).toEqual(Array.from({ length: 21 }, () => "row"));
    expect(rowIdsOfItems(items)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    ]);
  });

  it("locks agent tool and subagent pairing", () => {
    const rows: AssistantWorkRow[] = [
      toolRow(1, "Agent", { input: { prompt: "a" }, toolCallId: "call-a1" }),
      subagentRow(2, { parentToolCallId: "call-a1" }),
      textRow(3),
      toolRow(4, "Agent", { input: { prompt: "b" }, toolCallId: "call-a2" }),
      textRow(5),
      toolRow(6, "Agent", { input: { prompt: "c" }, toolCallId: "call-a3" }),
      subagentRow(7),
      textRow(8),
      toolRow(9, "Agent", { input: { prompt: "d" }, toolCallId: "call-a4" }),
      subagentRow(10),
      subagentRow(11),
      textRow(12),
      subagentRow(13, { parentToolCallId: "call-missing" }),
    ];
    const items = expectMatchesOracle(rows);
    const agentItems = items.filter((item) => item.kind === "agentToolCall");
    // 只有 parentToolCallId 精确命中的新式配对成立；turn 内未配对 Agent 不唯一时
    // 不做 legacy 单配对（4/6/9 三个 Agent + 三个无 parent 的 subagent 属歧义）。
    expect(agentItems.map((item) => item.row.rowId)).toEqual([1]);
    expect(agentItems[0]!.subagentRow.rowId).toBe(2);
    const agentOnlyRowIds = items
      .filter((item) => item.kind === "row" && item.row.kind === "toolCall")
      .map((item) => item.row.rowId);
    expect(agentOnlyRowIds).toEqual([4, 6, 9]);
    // 未配对与歧义组合的 subagent 必须保持独立渲染，不能被吞进 Agent 块。
    const subagentRowIds = items
      .filter((item) => item.kind === "row" && item.row.kind === "subagent")
      .map((item) => item.row.rowId);
    expect(subagentRowIds).toEqual([7, 10, 11, 13]);
    // legacy 快照路径：turn 内恰好一个未配对 Agent 与一个无 parent subagent 才配对。
    const legacyPair: AssistantWorkRow[] = [
      toolRow(1, "Agent", { input: { prompt: "a" }, toolCallId: "call-l1" }),
      subagentRow(2),
    ];
    const legacyItems = expectMatchesOracle(legacyPair);
    expect(legacyItems.map((item) => item.kind)).toEqual(["agentToolCall"]);
    expect(legacyItems[0]!.kind === "agentToolCall" && legacyItems[0].subagentRow.rowId).toBe(2);
  });

  it("locks official CUA tool grouping and response boundaries", () => {
    // 纯 CUA response：正文事件进组；组活性只由 stageTailIsRunning 决定。
    const pure: AssistantWorkRow[] = [
      toolRow(1, "mcp__computer-use__screenshot", { input: {}, assistantResponseId: "r1" }),
      toolRow(2, "mcp__plugin_zcode-cua_computer-use__click", {
        input: {},
        assistantResponseId: "r1",
      }),
      textRow(3, { assistantResponseId: "r1" }),
    ];
    for (const stageTailIsRunning of [false, true]) {
      const items = expectMatchesOracle(pure, DEFAULT_VISIBILITY, { stageTailIsRunning });
      const cuaGroups = items.filter((item) => item.kind === "cuaGroup");
      expect(cuaGroups).toHaveLength(1);
      expect(cuaGroups[0]!.rows.map((row) => row.rowId)).toEqual([1, 2]);
      expect(cuaGroups[0]!.events.map((event) => event.kind)).toEqual([
        "tool",
        "tool",
        "assistantMessage",
      ]);
      expect(cuaGroups[0]!.active).toBe(stageTailIsRunning);
    }
    // 混入非 CUA 工具的 response：正文留在组外，非 CUA 工具行即组边界。
    const mixed: AssistantWorkRow[] = [
      toolRow(1, "mcp__computer-use__screenshot", { input: {}, assistantResponseId: "r1" }),
      toolRow(2, "mcp__plugin_zcode-cua_computer-use__click", {
        input: {},
        assistantResponseId: "r1",
      }),
      textRow(3, { assistantResponseId: "r1" }),
      toolRow(4, "Read", { input: { file_path: "/a.ts" }, assistantResponseId: "r1" }),
      toolRow(5, "mcp__computer-use__screenshot", {
        input: {},
        assistantResponseId: "r2",
        status: "running",
      }),
      toolRow(6, "mcp__computer-use__screenshot", { input: {}, assistantResponseId: "r2" }),
    ];
    for (const stageTailIsRunning of [false, true]) {
      const items = expectMatchesOracle(mixed, DEFAULT_VISIBILITY, { stageTailIsRunning });
      const cuaGroups = items.filter((item) => item.kind === "cuaGroup");
      expect(cuaGroups).toHaveLength(2);
      expect(cuaGroups[0]!.rows.map((row) => row.rowId)).toEqual([1, 2]);
      expect(cuaGroups[0]!.events.map((event) => event.kind)).toEqual(["tool", "tool"]);
      expect(cuaGroups[0]!.active).toBe(false);
      expect(cuaGroups[1]!.rows.map((row) => row.rowId)).toEqual([5, 6]);
      expect(cuaGroups[1]!.active).toBe(stageTailIsRunning);
    }
  });

  it("locks explore/execute interleave and stage tail status", () => {
    const rows: AssistantWorkRow[] = [
      toolRow(1, "Bash", { input: { command: "rg --files" } }),
      toolRow(2, "Bash", { input: { command: "ls -la" } }),
      toolRow(3, "Bash", { input: { command: "rm -rf build" } }),
      toolRow(4, "Bash", { input: { command: "mv a b" }, status: "cancelled" }),
    ];
    const idle = expectMatchesOracle(rows, DEFAULT_VISIBILITY, { stageTailIsRunning: false });
    expect(idle.map((item) => item.kind)).toEqual(["exploreGroup", "executeGroup"]);
    const exploreGroup = idle[0]!;
    const executeGroup = idle[1]!;
    expect(exploreGroup.kind === "exploreGroup" && exploreGroup.node.toolCall.status).toBe(
      "completed",
    );
    expect(executeGroup.kind === "executeGroup" && executeGroup.node.toolCall.status).toBe(
      "stopped",
    );
    const running = expectMatchesOracle(rows, DEFAULT_VISIBILITY, { stageTailIsRunning: true });
    expect(running.map((item) => item.kind)).toEqual(["exploreGroup", "executeGroup"]);
    const runningExecute = running[1]!;
    expect(runningExecute.kind === "executeGroup" && runningExecute.node.toolCall.status).toBe(
      "in_progress",
    );
  });

  it("locks changes grouping switch", () => {
    const rows: AssistantWorkRow[] = [
      toolRow(1, "Edit", { input: { file_path: "/a.ts", old_string: "a", new_string: "b" } }),
      toolRow(2, "Edit", { input: { file_path: "/b.ts", old_string: "c", new_string: "d" } }),
      toolRow(3, "Write", { input: { file_path: "/c.ts", content: "x" } }),
    ];
    const grouped = expectMatchesOracle(rows, DEFAULT_VISIBILITY, { enableChangesGrouping: true });
    expect(grouped.map((item) => item.kind)).toEqual(["changesGroup"]);
    expect(grouped[0]!.kind === "changesGroup" && grouped[0].rows.map((row) => row.rowId)).toEqual([
      1, 2, 3,
    ]);
    const ungrouped = expectMatchesOracle(rows, DEFAULT_VISIBILITY, {
      enableChangesGrouping: false,
    });
    expect(ungrouped.map((item) => item.kind)).toEqual(["row", "row", "row"]);
    const single = expectMatchesOracle([rows[0]!], DEFAULT_VISIBILITY, {
      enableChangesGrouping: true,
    });
    expect(single.map((item) => item.kind)).toEqual(["row"]);
  });

  it("locks reasoning visibility filtering", () => {
    const rows: AssistantWorkRow[] = [
      reasoningRow(1),
      reasoningRow(2),
      reasoningRow(3),
      textRow(4),
    ];
    const shown = expectMatchesOracle(rows, { messageStreamShowReasoning: true });
    expect(shown.map((item) => item.kind)).toEqual(["row", "row", "row", "row"]);
    const hidden = expectMatchesOracle(rows, {
      messageStreamShowReasoning: false,
      messageStreamFirstReasoningRowId: 2,
    });
    expect(rowIdsOfItems(hidden)).toEqual([2, 4]);
  });

  it("locks grouping option matrix", () => {
    const rows: AssistantWorkRow[] = [
      toolRow(1, "Bash", { input: { command: "rg --files" } }),
      toolRow(2, "Bash", { input: { command: "ls -la" } }),
      toolRow(3, "Bash", { input: { command: "rm -rf build" } }),
      toolRow(4, "Bash", { input: { command: "mv a b" } }),
    ];
    const combinations: OracleOptions[] = [
      { enableExploreGrouping: false, enableTerminalGrouping: true },
      { enableExploreGrouping: true, enableTerminalGrouping: false },
      { enableExploreGrouping: false, enableTerminalGrouping: false },
      { enableExploreGrouping: true, enableTerminalGrouping: true },
      { enableChangesGrouping: true, enableExploreGrouping: true, enableTerminalGrouping: true },
    ];
    for (const options of combinations) {
      expectMatchesOracle(rows, DEFAULT_VISIBILITY, options);
    }
    const bothOff = expectMatchesOracle(rows, DEFAULT_VISIBILITY, {
      enableExploreGrouping: false,
      enableTerminalGrouping: false,
    });
    expect(bothOff.map((item) => item.kind)).toEqual(["row", "row", "row", "row"]);
  });

  it("locks non tool rows passthrough", () => {
    const rows: AssistantWorkRow[] = [
      artifactRow(1),
      markerRow(2),
      subagentRow(3),
      textRow(4, { state: "streaming", assistantResponseId: "r1" }),
      textRow(5, { state: "complete" }),
      reasoningRow(6, { text: "" }),
    ];
    const items = expectMatchesOracle(rows);
    expect(items.every((item) => item.kind === "row")).toBe(true);
    expect(rowIdsOfItems(items)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("locks deferred awaiting shell not breaking explore grouping", () => {
    const rows: AssistantWorkRow[] = [
      toolRow(1, "Bash", { input: { command: "rg --files" } }),
      toolRow(2, "Bash", { status: "inputStreaming", inputText: "" }),
      toolRow(3, "Bash", { input: { command: "ls -la" } }),
    ];
    const items = expectMatchesOracle(rows);
    expect(items.map((item) => item.kind)).toEqual(["exploreGroup"]);
    expect(items[0]!.kind === "exploreGroup" && items[0].rows.map((row) => row.rowId)).toEqual([
      1, 3,
    ]);
  });
});

// ────────────────────────────────────────────
// Seeded random equivalence
// ────────────────────────────────────────────

function createLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const TOOL_TEMPLATES: Array<{
  toolName: string;
  input?: unknown;
  inputText?: string;
  status?: ToolCallRow["status"];
}> = [
  { toolName: "Read", input: { file_path: "/repo/a.ts" } },
  { toolName: "Grep", input: { pattern: "foo", path: "/repo" } },
  { toolName: "Glob", input: { pattern: "**/*.ts" } },
  { toolName: "Edit", input: { file_path: "/repo/a.ts", old_string: "a", new_string: "b" } },
  { toolName: "Write", input: { file_path: "/repo/b.ts", content: "x" } },
  { toolName: "ApplyPatch", input: { patch: "..." } },
  { toolName: "Bash", input: { command: "rg --files" } },
  { toolName: "Bash", input: { command: "rm -rf build" } },
  { toolName: "Bash", input: { command: "echo hi > out.txt" } },
  { toolName: "Bash", input: { command: "for f in *.md; do cat $f; done" } },
  { toolName: "Bash", input: { command: ["zsh", "-lc", "ls -la"] } },
  { toolName: "Bash", input: { command: ["bash", "-c", "rm -rf x"] } },
  { toolName: "Bash", status: "inputStreaming", inputText: '{"command":"rg --fi' },
  { toolName: "Bash", status: "running", inputText: "" },
  { toolName: "Bash", status: "pendingApproval", input: { command: "pnpm test" } },
  { toolName: "Execute", input: { command: "pnpm test" } },
  { toolName: "Explore", input: { query: "auth" } },
  { toolName: "Agent", input: { prompt: "do", subagent_type: "general-purpose" } },
  { toolName: "Task", input: { prompt: "do" } },
  { toolName: "TodoWrite", input: { todos: [] } },
  { toolName: "EnterPlanMode", input: {} },
  { toolName: "mcp__computer-use__screenshot", input: {} },
  { toolName: "Foo", input: { anything: 1 } },
];

function buildRandomRows(random: () => number, count: number): AssistantWorkRow[] {
  const rows: AssistantWorkRow[] = [];
  for (let rowId = 1; rowId <= count; rowId += 1) {
    const pick = random();
    if (pick < 0.7) {
      const template = TOOL_TEMPLATES[Math.floor(random() * TOOL_TEMPLATES.length)]!;
      rows.push(
        toolRow(rowId, template.toolName, {
          ...(template.input !== undefined ? { input: template.input } : {}),
          ...(template.inputText !== undefined ? { inputText: template.inputText } : {}),
          ...(template.status !== undefined ? { status: template.status } : {}),
          ...(random() < 0.4 ? { assistantResponseId: "resp-" + Math.ceil(rowId / 3) } : {}),
          ...(random() < 0.15 ? { backgrounded: true } : {}),
        }),
      );
    } else if (pick < 0.8) {
      rows.push(
        textRow(rowId, {
          state: random() < 0.5 ? "streaming" : "complete",
          ...(random() < 0.6 ? { assistantResponseId: "resp-" + Math.ceil(rowId / 3) } : {}),
        }),
      );
    } else if (pick < 0.88) {
      rows.push(reasoningRow(rowId, { text: random() < 0.2 ? "" : "think " + rowId }));
    } else if (pick < 0.96) {
      rows.push(
        subagentRow(rowId, {
          status: random() < 0.5 ? "running" : "success",
          ...(random() < 0.7 ? { parentToolCallId: "call-" + Math.max(1, rowId - 1) } : {}),
        }),
      );
    } else {
      rows.push(markerRow(rowId));
    }
  }
  return rows;
}

describe("assistant work item projection seeded equivalence", () => {
  it("matches the frozen oracle on seeded random workloads (seed 20261031)", () => {
    const random = createLcg(20261031);
    for (let round = 0; round < 6; round += 1) {
      const rows = buildRandomRows(random, 24 + round * 9);
      const visibility: ConversationReasoningVisibility = {
        messageStreamShowReasoning: random() < 0.5,
        ...(random() < 0.5
          ? { messageStreamFirstReasoningRowId: 1 + Math.floor(random() * 6) }
          : {}),
      };
      const options: OracleOptions = {
        stageTailIsRunning: random() < 0.5,
        enableExploreGrouping: random() < 0.8,
        enableTerminalGrouping: random() < 0.8,
        enableChangesGrouping: random() < 0.3,
      };
      expectMatchesOracle(rows, visibility, options);
    }
  });

  it("matches the frozen oracle on seeded random workloads (seed 7)", () => {
    const random = createLcg(7);
    for (let round = 0; round < 6; round += 1) {
      const rows = buildRandomRows(random, 18 + round * 7);
      const visibility: ConversationReasoningVisibility = {
        messageStreamShowReasoning: random() < 0.5,
        ...(random() < 0.5
          ? { messageStreamFirstReasoningRowId: 1 + Math.floor(random() * 4) }
          : {}),
      };
      const options: OracleOptions = {
        stageTailIsRunning: random() < 0.5,
        enableExploreGrouping: random() < 0.9,
        enableTerminalGrouping: random() < 0.9,
        enableChangesGrouping: random() < 0.5,
      };
      expectMatchesOracle(rows, visibility, options);
    }
  });
});

// ────────────────────────────────────────────
// In-call derivation budgets
// ────────────────────────────────────────────

/**
 * 预算载荷：18 个非只读 shell（execute 族）与正文行交替，避免形成连续分组，
 * 也不产生 CUA/子代理行；分组内复检与子项转换都不会发生，计数只反映分类推导。
 */
function buildBudgetWorkload(): { rows: AssistantWorkRow[]; toolCallRowCount: number } {
  const rows: AssistantWorkRow[] = [];
  let rowId = 1;
  for (let index = 0; index < 18; index += 1) {
    rows.push(toolRow(rowId, "Bash", { input: { command: "rm -rf build-" + index } }));
    rowId += 1;
    rows.push(textRow(rowId));
    rowId += 1;
  }
  return { rows, toolCallRowCount: 18 };
}

describe("assistant work item projection derivation budgets", () => {
  it("converts each tool call row at most once per projection pass", () => {
    const { rows, toolCallRowCount } = buildBudgetWorkload();
    const conversionSpy = vi.spyOn(toolCallRowAdapterModule, "toolCallRowToLegacyNode");
    try {
      conversionSpy.mockClear();
      buildAssistantWorkRenderItems(rows, DEFAULT_VISIBILITY, {
        enableCuaGrouping: true,
        enableExploreGrouping: true,
        enableTerminalGrouping: true,
        enableChangesGrouping: false,
      });
      const conversions = conversionSpy.mock.calls.length;
      expect(
        conversions,
        "legacy 转换次数 " +
          conversions +
          " 必须不超过 toolCall 行数 " +
          toolCallRowCount +
          "（修复前每次判定都重新转换整行）",
      ).toBeLessThanOrEqual(toolCallRowCount);
    } finally {
      conversionSpy.mockRestore();
    }
  });

  it("resolves tool identity at most twice per tool call row", () => {
    const { rows, toolCallRowCount } = buildBudgetWorkload();
    const identitySpy = vi.spyOn(toolIdentityModule, "resolveToolCallIdentity");
    try {
      identitySpy.mockClear();
      buildAssistantWorkRenderItems(rows, DEFAULT_VISIBILITY, {
        enableCuaGrouping: true,
        enableExploreGrouping: true,
        enableTerminalGrouping: true,
        enableChangesGrouping: false,
      });
      const identities = identitySpy.mock.calls.length;
      expect(
        identities,
        "身份解析次数 " +
          identities +
          " 必须不超过 2 × toolCall 行数 " +
          2 * toolCallRowCount +
          "（explore 与 execute 判定各一次；修复前 isExecuteToolCall 内重复解析）",
      ).toBeLessThanOrEqual(2 * toolCallRowCount);
    } finally {
      identitySpy.mockRestore();
    }
  });
});
