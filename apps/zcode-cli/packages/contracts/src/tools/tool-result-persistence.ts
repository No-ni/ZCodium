import { z } from "zod";
import { PersistedToolSearchContentSchema } from "./tool-search.js";
import {
  COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION,
  toolResultDisplayPayloadSchema,
} from "./tool-result-display-schema.js";
import type { ToolResultDisplayPayload } from "./tool-result-display-schema.js";

export const toolResultSerializationMetadataSchema = z
  .object({
    truncated: z.boolean(),
    originalBytes: z.number().int().nonnegative(),
    returnedBytes: z.number().int().nonnegative(),
    budgetStrategy: z.enum(["inline", "truncate", "artifact"]),
    artifactPath: z.string().min(1).optional(),
  })
  .strict();

export type ToolResultSerializationMetadata = z.infer<typeof toolResultSerializationMetadataSchema>;

export const completedToolPartMetadataSchema = z
  .object({
    // 错误结果沿用字符串内容；仅接受数组会使 V4 冷恢复丢弃整份 metadata，包括 display。
    modelContent: z.union([z.string(), PersistedToolSearchContentSchema]).optional(),
    schemaVersion: z.literal(COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION),
    display: toolResultDisplayPayloadSchema.optional(),
    serialization: toolResultSerializationMetadataSchema.optional(),
  })
  .passthrough();

export type CompletedToolPartMetadata = z.infer<typeof completedToolPartMetadataSchema>;

export function parseCompletedToolPartMetadata(
  input: unknown,
): CompletedToolPartMetadata | undefined {
  const scrubbed =
    isPlainRecord(input) && "display" in input
      ? { ...input, display: scrubPersistedDisplay(input.display) }
      : input;
  const result = completedToolPartMetadataSchema.safeParse(scrubbed);
  return result.success ? result.data : undefined;
}

export function parseToolResultDisplayPayload(
  input: unknown,
): ToolResultDisplayPayload | undefined {
  const result = toolResultDisplayPayloadSchema.safeParse(scrubPersistedDisplay(input));
  return result.success ? result.data : undefined;
}

/**
 * 解析前的统一清洗。
 *
 * display 是**落库**的：它写进 tool part 的 `metadata.display`，此后每次读取都要重新过
 * 一遍严格解析，而渲染端对每一帧同样有一份严格的镜像 schema。所以剥离必须发生在 CLI 侧、
 * 解析之前——上面两个入口就是唯一的卡点，v4 冷启动水合与 session-transcript 回放都经过它。
 *
 * 每个 stripper 只认自己那一个 kind，只改在场的键，别的 kind 原样进入解析。
 */
function scrubPersistedDisplay(display: unknown): unknown {
  return stripProviderStopFromGetWorkflowRunError(stripWithdrawnRefinedNames(display));
}

/**
 * 剥掉持久化 get_workflow_run 卡上的 `providerStop`。
 *
 * 早期构造侧曾把只属于模型通道的 `providerStop` 一并写进 display，而渲染端的
 * 镜像 schema 从来只认 `{code, message}`，那些帧一律被拒。构造侧已经改成只带
 * code / message，但历史持久化的 part 每次冷启动都会被重新读一遍，只能在这里剥。
 *
 * 只认 kind 为 get_workflow_run、且 error 是普通对象、且 `providerStop` 在场的载荷；不带
 * 该键的 error 与缺席的 error 原样返回，不凭空添一个 undefined。
 */
function stripProviderStopFromGetWorkflowRunError(display: unknown): unknown {
  if (!isPlainRecord(display) || display.kind !== "get_workflow_run") return display;
  const error = display.error;
  if (!isPlainRecord(error) || !("providerStop" in error)) return display;
  const { providerStop: _dropped, ...rest } = error;
  return { ...display, error: rest };
}

/**
 * 剥掉已撤回的模型精炼字段。
 *
 * 之前持久化的 create_workflow display 里，车道与阶段可能带 `refinedName`、
 * step 可能带 `refinedLabel`。这三个字段已从 schema 删除，而两个入口都是 `.strict()`
 * 解析：不先剥掉，旧会话的整个 display（连同图）会在这里被拒掉，而不只是丢一个名字。
 *
 * 只认 create_workflow 且带 causalityGraph 的载荷；别的 kind 原样进入解析。只改在场的
 * 键，不给缺席的 `phases` 之类凭空添一个 undefined。
 */
function stripWithdrawnRefinedNames(display: unknown): unknown {
  if (!isPlainRecord(display) || display.kind !== "create_workflow") return display;
  const graph = display.causalityGraph;
  if (!isPlainRecord(graph)) return display;
  return {
    ...display,
    causalityGraph: {
      ...graph,
      ...("lanes" in graph ? { lanes: withoutKey(graph.lanes, "refinedName") } : {}),
      ...("steps" in graph ? { steps: withoutKey(graph.steps, "refinedLabel") } : {}),
      ...("phases" in graph ? { phases: withoutKey(graph.phases, "refinedName") } : {}),
    },
  };
}

function withoutKey(items: unknown, key: string): unknown {
  if (!Array.isArray(items)) return items;
  return items.map((item) => {
    if (!isPlainRecord(item) || !(key in item)) return item;
    const { [key]: _dropped, ...rest } = item;
    return rest;
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
