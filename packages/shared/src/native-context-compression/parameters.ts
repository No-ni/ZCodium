import { z } from "zod";
import { collectParameterFields } from "./field-descriptors.js";
import { nativeContextTriggerParametersSchema } from "./trigger-parameters.js";
import {
  nativeContextHistoryParametersSchema,
  nativeContextReasoningParametersSchema,
  nativeContextSummaryParametersSchema,
} from "./history-parameters.js";
import {
  nativeContextRetrievalParametersSchema,
  nativeContextToolParametersSchema,
} from "./tool-parameters.js";
import { nativeContextImageParametersSchema } from "./image-parameters.js";
import {
  nativeContextMaintenanceParametersSchema,
  nativeContextPromptParametersSchema,
} from "./prompt-parameters.js";
import type {
  NativeContextParameterPath,
  NativeContextParameterValue,
  NativeContextParameters,
} from "./types.js";

export const nativeContextParametersSchema = z
  .object({
    trigger: nativeContextTriggerParametersSchema,
    history: nativeContextHistoryParametersSchema,
    summary: nativeContextSummaryParametersSchema,
    reasoning: nativeContextReasoningParametersSchema,
    tools: nativeContextToolParametersSchema,
    retrieval: nativeContextRetrievalParametersSchema,
    images: nativeContextImageParametersSchema,
    maintenance: nativeContextMaintenanceParametersSchema,
    prompts: nativeContextPromptParametersSchema,
  })
  .strict()
  .superRefine((parameters, context) => {
    const { trigger, summary, tools, images } = parameters;
    const issue = (path: string[], message: string) =>
      context.addIssue({ code: "custom", path, message });
    if (trigger.start.kind === trigger.target.kind && trigger.target.value >= trigger.start.value) {
      issue(["trigger", "target"], "Compression target must be below the start threshold.");
    }
    // 混合单位必须等到 Runtime 取得真实 ModelPort 输入预算后再比较。
    if (trigger.start.kind === "percent") {
      if (trigger.start.value > trigger.capacityPercent) {
        issue(
          ["trigger", "capacityPercent"],
          "Capacity fallback must be at or above the start threshold.",
        );
      }
      if (trigger.opportunisticPercent > trigger.start.value) {
        issue(
          ["trigger", "opportunisticPercent"],
          "Opportunistic usage must not exceed the start threshold.",
        );
      }
    }
    if (trigger.adaptive.floorTokens > trigger.adaptive.capTokens) {
      issue(
        ["trigger", "adaptive", "floorTokens"],
        "Adaptive lower bound must not exceed the upper bound.",
      );
    }
    if (summary.maxChars !== 0 && summary.minChars > summary.maxChars) {
      issue(["summary", "minChars"], "Minimum summary length must not exceed the maximum.");
    }
    if (summary.tier3BlockCount <= summary.tier2BlockCount) {
      issue(["summary", "tier3BlockCount"], "T3 block count must exceed T2 block count.");
    }
    if (tools.simplify.enabled && !tools.distill.enabled) {
      issue(
        ["tools", "simplify", "enabled"],
        "Tool simplification requires immediate model summaries.",
      );
    }
    if (images.minJpegQuality > images.jpegQuality) {
      issue(["images", "minJpegQuality"], "Minimum JPEG quality must not exceed target quality.");
    }
    if (images.minEdge > images.maxEdge) {
      issue(["images", "minEdge"], "Minimum edge must not exceed the maximum edge.");
    }
  }) satisfies z.ZodType<NativeContextParameters>;

export const NATIVE_CONTEXT_PARAMETER_FIELDS = collectParameterFields(
  nativeContextParametersSchema,
);
const parameterPaths = new Set<string>(NATIVE_CONTEXT_PARAMETER_FIELDS.map(({ path }) => path));
function checkedPathKeys(path: NativeContextParameterPath): string[] {
  if (!parameterPaths.has(path)) throw new Error("Unknown native context parameter path.");
  return path.split(".");
}
function readPath(parameters: NativeContextParameters, keys: readonly string[]): unknown {
  let value: unknown = parameters;
  for (const key of keys) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) {
      throw new Error("Native context parameters must contain the complete field path.");
    }
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
function writePath(target: object, keys: readonly string[], value: unknown): void {
  let parent = target as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) {
    if (!Object.hasOwn(parent, key)) parent[key] = {};
    parent = parent[key] as Record<string, unknown>;
  }
  const last = keys.at(-1);
  if (!last) throw new Error("Native context parameter path must not be empty.");
  parent[last] = value;
}

export function createRecommendedNativeContextParameters(): NativeContextParameters {
  const defaults: Record<string, unknown> = {};
  for (const field of NATIVE_CONTEXT_PARAMETER_FIELDS) {
    writePath(defaults, checkedPathKeys(field.path), field.value);
  }
  // Zod 为数组和阈值对象生成新副本，不让推荐元数据成为可修改的任务事实。
  return nativeContextParametersSchema.parse(defaults);
}

export function getNativeContextParameterValue<TPath extends NativeContextParameterPath>(
  parameters: NativeContextParameters,
  path: TPath,
): NativeContextParameterValue<TPath> {
  return structuredClone(
    readPath(parameters, checkedPathKeys(path)),
  ) as NativeContextParameterValue<TPath>;
}

/** 只创建表单草稿；完整校验/保存由调用者使用 configuration/policy schema 完成。 */
export function setNativeContextParameterValue<TPath extends NativeContextParameterPath>(
  parameters: NativeContextParameters,
  path: TPath,
  value: Readonly<NativeContextParameterValue<TPath>>,
): NativeContextParameters {
  const keys = checkedPathKeys(path);
  readPath(parameters, keys);
  const draft = structuredClone(parameters);
  writePath(draft, keys, structuredClone(value));
  return draft;
}
