import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import {
  isExecuteToolCall,
  isExploreToolCall,
  isShellToolCallAwaitingCommand,
} from "@/lib/exploreToolCall.js";
import { resolveToolCallIdentity, type ToolCallIdentity } from "@/lib/toolIdentity.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import type { AssistantWorkRow } from "@/v4/conversationTurnRenderUnits.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";

export interface ToolCallRowDerivation {
  legacyNode: TaskChatToolCallTreeNode;
  identity: ToolCallIdentity;
  isExplore: boolean;
  isExecute: boolean;
  isChanges: boolean;
  awaitingCommand: boolean;
}

export type ToolCallRowDerivationResolver = (row: AssistantWorkRow) => ToolCallRowDerivation | null;

export function createToolCallRowDerivationResolver(): ToolCallRowDerivationResolver {
  // 缓存只存活于本次投影；跨帧 row 对象可能重建，不能提升为模块级事实。
  const derivations = new WeakMap<ToolCallRow, ToolCallRowDerivation>();
  return (row) => {
    if (row.kind !== "toolCall") return null;
    const cached = derivations.get(row);
    if (cached) return cached;
    const legacyNode = toolCallRowToLegacyNode(row);
    const identity = resolveToolCallIdentity(legacyNode.toolCall);
    const derivation: ToolCallRowDerivation = {
      legacyNode,
      identity,
      isExplore: isExploreToolCall(legacyNode.toolCall, identity),
      isExecute: isExecuteToolCall(legacyNode.toolCall, identity),
      isChanges: identity.family === "file-write",
      awaitingCommand: isShellToolCallAwaitingCommand(legacyNode.toolCall, identity),
    };
    derivations.set(row, derivation);
    return derivation;
  };
}
