import { createHash } from "node:crypto";
import {
  createAgentStateId,
  type BuiltInSubagentModelSelectionOverrides,
  type BuiltInSubagentName,
  type DataSyncModelOverrideSummary,
  type ModelSelection,
} from "@zcode/shared";
import { normalizeSubagentModelSelection } from "#src/subagents/subagentModelSelection.js";
import { stableStringify } from "./syncUtils.js";

const BUILT_IN_AGENT_NAMES: readonly BuiltInSubagentName[] = ["general-purpose", "Explore"];

/** 内置智能体模型覆盖行的对齐 key：状态 ID 带 `built-in:` 前缀，不会与用户子智能体的 key 相同。 */
function toBuiltInOverrideKey(name: BuiltInSubagentName): string {
  return createAgentStateId({ name, scope: "built-in", source: "built-in" });
}

const BUILT_IN_OVERRIDE_KEYS = new Set(BUILT_IN_AGENT_NAMES.map(toBuiltInOverrideKey));

interface ResolvedBuiltInOverride {
  key: string;
  name: BuiltInSubagentName;
  modelSelection: ModelSelection;
  hash: string;
}

/** 只有设了覆盖的内置智能体才是条目；继承默认的不列出，也就不会被推送或清除。 */
function resolveBuiltInOverrides(
  overrides: BuiltInSubagentModelSelectionOverrides,
): Map<string, ResolvedBuiltInOverride> {
  const resolved = new Map<string, ResolvedBuiltInOverride>();
  for (const name of BUILT_IN_AGENT_NAMES) {
    const modelSelection = normalizeSubagentModelSelection(overrides[name]);
    if (!modelSelection) continue;
    const key = toBuiltInOverrideKey(name);
    resolved.set(key, {
      key,
      name,
      modelSelection,
      hash: createHash("sha256").update(stableStringify(modelSelection)).digest("hex"),
    });
  }
  return resolved;
}

function toModelOverrideSummary(selection: ModelSelection): DataSyncModelOverrideSummary {
  const reasoningLevel = selection.options?.reasoningLevel;
  return { modelId: selection.modelId, ...(reasoningLevel ? { reasoningLevel } : {}) };
}
export {
  BUILT_IN_AGENT_NAMES,
  toBuiltInOverrideKey,
  BUILT_IN_OVERRIDE_KEYS,
  type ResolvedBuiltInOverride,
  resolveBuiltInOverrides,
  toModelOverrideSummary,
};
