import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { resolvePluginUiLogicalScope } from "./pluginUiLogicalScope.js";

/** ：最近几个回合的插件卡片默认展开，更早的按默认收进折叠区。 */
export const PLUGIN_UI_AUTO_EXPAND_TURNS = 3;

/** 一个逻辑 UI：仅显式 surface 或权限范围一致的 widgetSessionId 共用，其余调用独立。 */
export interface PluginUiLogicalInstance {
  key: string;
  /** 当前显示的调用：最新一次成功（非 isError）的；没有成功的就是最新一条。 */
  activeToolCallId: string;
  /** 被较新成功结果替代的成功调用；它们不建沙箱，只保留普通工具记录。 */
  supersededToolCallIds: string[];
}

/** 单条插件工具行的展示裁决；渲染层据此决定进不进折叠区、要不要建沙箱。 */
export interface PluginUiRowDisposition {
  key: string;
  superseded: boolean;
  /** 所在回合在最近 PLUGIN_UI_AUTO_EXPAND_TURNS 个回合内。 */
  autoExpand: boolean;
  /** 工具级 `openai/widgetShowCodexWidgetInline`（display.ui.showInline）。 */
  forcedInline: boolean;
}

export interface PluginUiInstanceDerivation {
  instances: PluginUiLogicalInstance[];
  byToolCallId: Readonly<Record<string, PluginUiRowDisposition>>;
}

export const EMPTY_PLUGIN_UI_INSTANCE_DERIVATION: PluginUiInstanceDerivation = {
  instances: [],
  byToolCallId: {},
};

function isPluginUiToolRow(row: ConversationRow): row is ToolCallRow {
  return (
    row.kind === "toolCall" && row.display?.kind === "mcp_tool" && row.display.ui !== undefined
  );
}

function isSuccessfulUiRow(row: ToolCallRow): boolean {
  return (
    row.status === "success" &&
    !(row.display?.kind === "mcp_tool" && row.display.ui?.isError === true)
  );
}

/**
 * 纯函数：从投影行推导逻辑 UI 实例与每行的展示裁决（V-a）。
 * key 同时绑定来源、server、资源、权限与逻辑视图；同 key 内最新一次成功结果替代更早的成功结果，
 * running / failed / isError 的行既不替代别人也不被替代（各自显示自己的状态）。
 * autoExpand 按全部行的回合顺序取最近 N 个回合（回合里没有插件卡片也算一个回合）。
 */
export function deriveLogicalUiInstances(
  rows: readonly ConversationRow[],
  options: { autoExpandTurns?: number } = {},
): PluginUiInstanceDerivation {
  const pluginRows = rows.filter(isPluginUiToolRow);
  // 普通流式正文也会触发派生；没有候选插件时回合目录无用途，先返回避免读全量 turnId。
  if (pluginRows.length === 0) return { instances: [], byToolCallId: {} };

  // 流式更新会重复派生全部历史；用调用内成员索引避免逐行 includes 回扫已见回合。
  const seenTurns: Record<string, true | undefined> = Object.create(null);
  const turnOrder: string[] = [];
  for (const row of rows) {
    const turnId = row.turnId;
    if (seenTurns[turnId]) continue;
    seenTurns[turnId] = true;
    turnOrder.push(turnId);
  }
  const recentTurns = turnOrder.slice(-(options.autoExpandTurns ?? PLUGIN_UI_AUTO_EXPAND_TURNS));
  const recentTurnIds: Record<string, true | undefined> = Object.create(null);
  for (const turnId of recentTurns) recentTurnIds[turnId] = true;
  const groupKeys: string[] = [];
  const groups: Record<string, ToolCallRow[]> = {};
  for (const row of pluginRows) {
    const display = row.display;
    if (display?.kind !== "mcp_tool" || !display.ui) continue;
    const logical = resolvePluginUiLogicalScope(display.ui, {
      kind: "toolCall",
      toolCallId: row.toolCallId,
    });
    const key = JSON.stringify([
      display.ui.pluginId,
      display.serverName,
      display.ui.resourceUri,
      logical,
    ]);
    const group = groups[key];
    if (group) group.push(row);
    else {
      groups[key] = [row];
      groupKeys.push(key);
    }
  }
  const instances: PluginUiLogicalInstance[] = [];
  const byToolCallId: Record<string, PluginUiRowDisposition> = {};
  for (const key of groupKeys) {
    const group = groups[key]!;
    const successes = group.filter(isSuccessfulUiRow);
    const active = successes.at(-1) ?? group.at(-1)!;
    const superseded = successes.filter((row) => row !== active).map((row) => row.toolCallId);
    // 同一 surface 的多次成功结果仍保留原数组顺序和重复 ID，成员判断不再逐行回扫。
    const supersededIds: Record<string, true | undefined> = Object.create(null);
    for (const toolCallId of superseded) supersededIds[toolCallId] = true;
    instances.push({ key, activeToolCallId: active.toolCallId, supersededToolCallIds: superseded });
    for (const row of group) {
      // toolCallId 是协议字符串；普通赋值会触发 __proto__ setter、丢掉自有裁决。
      // 显式数据属性保留既有普通对象输出和重复 ID 的最后写入规则，不改变原型。
      Object.defineProperty(byToolCallId, row.toolCallId, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: {
          key,
          superseded: supersededIds[row.toolCallId] === true,
          autoExpand: recentTurnIds[row.turnId] === true,
          forcedInline: row.display?.kind === "mcp_tool" && row.display.ui?.showInline === true,
        },
      });
    }
  }
  return { instances, byToolCallId };
}
