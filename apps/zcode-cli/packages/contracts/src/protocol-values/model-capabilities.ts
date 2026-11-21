import { z } from "zod";

export const ToolReferenceContentSchema = z
  .object({ type: z.literal("tool_reference"), toolName: z.string().min(1) })
  .strict();
export type ModelToolReferenceContentBlock = z.infer<typeof ToolReferenceContentSchema>;
export interface ToolSearchCapability {
  readonly protocolSupported: boolean;
  readonly defaultEnabled: boolean;
}
export interface ModelRequestCapabilities {
  readonly toolSearch?: ToolSearchCapability;
  /** 协议会合并相邻 user 文本时，将紧随 tool result 的提醒并入其内容。 */
  readonly foldRemindersIntoToolResults?: boolean;
  /** 保留本仓 Provider 的空白/仅思考回复投影约束，所有装饰器共用此能力契约。 */
  readonly dropReasoningOnlyOrBlankAssistants?: boolean;
}
