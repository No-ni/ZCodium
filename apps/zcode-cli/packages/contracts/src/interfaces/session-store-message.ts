import { isBlockIndex } from "../model/index.js";
import type {
  TextPart,
  ReasoningPart,
  FilePart,
  AgentPart,
  CompactionPart,
  SubtaskPart,
  RetryPart,
  StepStartPart,
  StepFinishPart,
  SnapshotPart,
  PatchPart,
} from "./session-store-message-parts.js";
import type { TimelinePart } from "./session-store-timeline-parts.js";
import type { ToolPart } from "./session-store-tool-parts.js";
import type { MessageInfo } from "./session-store-message-info.js";

export type MessagePart =
  | TextPart
  | ReasoningPart
  | FilePart
  | AgentPart
  | CompactionPart
  | TimelinePart
  | SubtaskPart
  | RetryPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | ToolPart;

/** 浏览器轮尾截图 tool part 的 `state.input.source`。它只用于展示，不是模型块，不带 blockIndex。 */
export const BROWSER_TURN_SCREENSHOT_SOURCE = "browser_turn_end" as const;

// 返回 boolean 而不是类型谓词：它只认一种 tool part，取反时不能把所有 ToolPart 都收窄掉。
// 仓库每次读取都会对所有 tool part 调用它；part data 没有 schema 校验，损坏数据可能没有 state 或 input，
// 按非截图处理，不能让一个坏 part 中断整个会话的读取。
export function isBrowserTurnScreenshotPart(part: MessagePart): boolean {
  return part.type === "tool" && part.state?.input?.source === BROWSER_TURN_SCREENSHOT_SOURCE;
}

type AssistantBlockPart = TextPart | ReasoningPart | ToolPart;

// 类型谓词只按 part 类型判断。截图也是 ToolPart，单独用 isBrowserTurnScreenshotPart 排除：
// 把截图判断放进类型谓词，false 分支会把所有 ToolPart 都收窄掉。
function isBlockTypePart(part: MessagePart): part is AssistantBlockPart {
  return part.type === "reasoning" || part.type === "text" || part.type === "tool";
}

/** 是否参与 assistant 块顺序：reasoning、text、tool，浏览器轮尾截图除外。 */
export function isAssistantBlockPart(part: MessagePart): boolean {
  return isBlockTypePart(part) && !isBrowserTurnScreenshotPart(part);
}

/** 参与 assistant 块顺序的 part，保持原顺序。 */
export function assistantBlockParts(parts: readonly MessagePart[]): AssistantBlockPart[] {
  return parts.filter(isBlockTypePart).filter((part) => !isBrowserTurnScreenshotPart(part));
}

/**
 * 有序 assistant 消息：至少有一个块 part，且所有块 part 的 blockIndex 都合法（isBlockIndex）。
 * 不满足时整条消息按旧数据处理，不存在“部分有序”。要求至少一个块 part：没有块 part 的旧消息
 * 留在旧路径，空消息的处理不变。
 * 见 apps/zcode-cli/docs/design/v2/model/assistant-block-order.md。
 */
export function hasOrderedAssistantBlocks(parts: readonly MessagePart[]): boolean {
  const blockParts = assistantBlockParts(parts);
  return blockParts.length > 0 && blockParts.every((part) => isBlockIndex(part.blockIndex));
}

export interface MessageWithParts {
  info: MessageInfo;
  parts: MessagePart[];
}
