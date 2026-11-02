import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { JsonSchema } from "../model/index.js";

export const TOOL_SEARCH_NAME = "ToolSearch";
export const LOCAL_TOOL_SEARCH_NAME = "LocalToolSearch";
export const TOOL_SEARCH_BETA = "advanced-tool-use-2025-11-20";
export const TOOL_SEARCH_DEFAULT_RESULTS = 5;
export const TOOL_SEARCH_DISPLAY_MAX_QUERY_BYTES = 4096;
export const TOOL_SEARCH_DISPLAY_MAX_NAME_BYTES = 512;
export const TOOL_SEARCH_DISPLAY_MAX_MATCHES = 100;
const displayEncoder = new TextEncoder();
export const toolSearchToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("tool_search"),
    query: z
      .string()
      .max(TOOL_SEARCH_DISPLAY_MAX_QUERY_BYTES)
      .refine(
        (value) => displayEncoder.encode(value).byteLength <= TOOL_SEARCH_DISPLAY_MAX_QUERY_BYTES,
      ),
    matches: z
      .array(
        z
          .string()
          .min(1)
          .max(TOOL_SEARCH_DISPLAY_MAX_NAME_BYTES)
          .refine(
            (value) =>
              displayEncoder.encode(value).byteLength <= TOOL_SEARCH_DISPLAY_MAX_NAME_BYTES,
          ),
      )
      .max(TOOL_SEARCH_DISPLAY_MAX_MATCHES),
    totalMatches: z.number().int().nonnegative(),
    totalDeferredTools: z.number().int().nonnegative(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ToolSearchToolResultDisplayPayload = z.infer<
  typeof toolSearchToolResultDisplayPayloadSchema
>;
export const ToolSearchModeSchema = z.enum(["auto", "native", "local", "off"]);
export type ToolSearchMode = z.infer<typeof ToolSearchModeSchema>;
export type ResolvedToolSearchMode = Exclude<ToolSearchMode, "auto">;

// Local 与 Native 只在发给模型的工具名上分叉，检索语义共用同一套常量。
export function toolSearchNameForMode(mode: ResolvedToolSearchMode): string {
  return mode === "local" ? LOCAL_TOOL_SEARCH_NAME : TOOL_SEARCH_NAME;
}
export function isToolSearchName(name: string | undefined): boolean {
  return name === TOOL_SEARCH_NAME || name === LOCAL_TOOL_SEARCH_NAME;
}

export const ToolSearchAnnouncementSchema = z
  .object({
    addedNames: z.array(z.string().min(1)),
    removedNames: z.array(z.string().min(1)),
    readdedNames: z.array(z.string().min(1)),
  })
  .strict()
  .refine((delta) => delta.readdedNames.every((name) => delta.addedNames.includes(name)), {
    message: "Readded tool names must be included in addedNames",
  });
export type ToolSearchAnnouncement = z.infer<typeof ToolSearchAnnouncementSchema>;

export const ToolReferenceContentSchema = z
  .object({ type: z.literal("tool_reference"), toolName: z.string().min(1) })
  .strict();
export type ModelToolReferenceContentBlock = z.infer<typeof ToolReferenceContentSchema>;
export const PersistedToolSearchContentSchema = z
  .array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string() }).strict(),
      ToolReferenceContentSchema,
    ]),
  )
  .min(1);
export const ToolSearchInputSchema = z
  .object({
    query: z
      .string()
      .describe(
        'Find tools by keywords, or use "select:<name>[,<name>...]" for exact selection. Regular expressions are not supported.',
      ),
    max_results: z
      .number()
      .int()
      .positive()
      .optional()
      .default(TOOL_SEARCH_DEFAULT_RESULTS)
      .describe("Maximum keyword matches to return (default: 5)"),
  })
  .strict();
export const ToolSearchOutputSchema = z
  .object({
    matches: z.array(z.string().min(1)),
    query: z.string(),
    total_deferred_tools: z.number().int().nonnegative(),
  })
  .strict();
// 控制工具 schema 不走剥除 $ref 的旧 subset helper；Local 必须能传递原始完整 JSONSchema。
// 转换器会把带默认值的字段视为可选；模型侧要求显式传入，执行侧仍先补默认值。
export const ToolSearchInputJsonSchema: JsonSchema = {
  ...(zodToJsonSchema(ToolSearchInputSchema) as JsonSchema),
  required: ["query", "max_results"],
};
export const ToolSearchOutputJsonSchema = zodToJsonSchema(ToolSearchOutputSchema) as JsonSchema;
export interface ToolSearchCapability {
  readonly protocolSupported: boolean;
  readonly defaultEnabled: boolean;
}
export interface ModelRequestCapabilities {
  readonly toolSearch?: ToolSearchCapability;
  /** 协议会合并相邻 user 文本时，将紧随 tool result 的提醒并入其内容。 */
  readonly foldRemindersIntoToolResults?: boolean;
}
export interface ToolSearchCandidate {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly mcp?: { readonly serverName: string; readonly toolName: string };
  readonly description?: string;
  readonly searchHint?: string;
  readonly deferred: boolean;
}
export interface ToolSearchExecutionContext {
  readonly mode: ResolvedToolSearchMode;
  readonly enabled: boolean;
  readonly catalog: readonly ToolSearchCandidate[];
  readonly discovered: ReadonlySet<string>;
}
