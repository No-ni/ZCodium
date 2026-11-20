import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  createAgentStateId,
  modelSelectionSchema,
  type BuiltInSubagentName,
  type DataSyncImportItem,
  type DataSyncImportResultItem,
  type DataSyncListItem,
  type ModelSelection,
  type SubagentDataSyncPayload,
} from "@zcode/shared";
import { migrateSubagentStateFile } from "@zcode/shared/node";
import {
  pathExists,
  readJsonObjectFileForUpdate,
  updateJsonObjectFile,
  writeFileAtomically,
} from "#src/fs/atomicFileUtils.js";
import { checkRemoteSyncDirectoriesWriteAccess } from "#src/remote-sync/remoteSyncWriteAccess.js";
import { parseSubagentMarkdown } from "#src/subagents/subagentMarkdown.js";
import { normalizeSubagentModelSelection } from "#src/subagents/subagentModelSelection.js";
import {
  resolveSubagentStateFile,
  resolveUserHomeDir,
  resolveUserSubagentRoot,
} from "#src/subagents/subagentStorage.js";
import { normalizeBuiltInSelectionOverrides } from "#src/subagents/subagentsService.js";
import type { IDataSyncCategoryService } from "./contract.js";
import { errorMessage } from "./syncUtils.js";
import {
  type ResolvedUserSubagent,
  hashContent,
  toSubagentKey,
  resolveUserSubagents,
} from "./subagentFileInventory.js";
import {
  BUILT_IN_AGENT_NAMES,
  toBuiltInOverrideKey,
  BUILT_IN_OVERRIDE_KEYS,
  type ResolvedBuiltInOverride,
  resolveBuiltInOverrides,
  toModelOverrideSummary,
} from "./subagentModelOverrides.js";

const AGENT_FILE_NAME = /^[^/\\]+\.(md|markdown)$/iu;

function toUserAgentStateId(key: string): string {
  return createAgentStateId({ name: key, scope: "user", source: "user" });
}

/** 只读展示：状态文件缺失或损坏时视为全部启用、没有内置覆盖。写入走 updateJsonObjectFile。 */
async function readSubagentState(): Promise<{
  disabled: Set<string>;
  builtInOverrides: Map<string, ResolvedBuiltInOverride>;
}> {
  const stateFile = await resolveSubagentStateFile();
  try {
    await migrateSubagentStateFile(stateFile);
    const parsed = JSON.parse(await readFile(stateFile, "utf-8")) as {
      disabledAgentIds?: unknown;
      builtInModelSelectionOverrides?: unknown;
    };
    return {
      disabled: new Set(
        Array.isArray(parsed.disabledAgentIds)
          ? parsed.disabledAgentIds.filter((id): id is string => typeof id === "string")
          : [],
      ),
      builtInOverrides: resolveBuiltInOverrides(
        normalizeBuiltInSelectionOverrides(parsed.builtInModelSelectionOverrides),
      ),
    };
  } catch {
    return { disabled: new Set(), builtInOverrides: new Map() };
  }
}

export function createSubagentDataSyncMethods(): IDataSyncCategoryService<SubagentDataSyncPayload> {
  async function importOne(
    item: DataSyncImportItem,
    payloadItem: SubagentDataSyncPayload["items"][number] | undefined,
    root: string,
    current: Map<string, ResolvedUserSubagent>,
  ): Promise<DataSyncImportResultItem & { createdPath?: string }> {
    const failed = (error: string) => ({ key: item.key, status: "failed" as const, error });
    if (!payloadItem) return failed("subagent is missing from the sync payload");
    if (!AGENT_FILE_NAME.test(payloadItem.fileName)) {
      return failed(`invalid subagent file name: ${payloadItem.fileName}`);
    }
    const content = Buffer.from(payloadItem.content);
    const parsed = parseSubagentMarkdown({
      content: content.toString("utf-8"),
      path: payloadItem.fileName,
      scope: "user",
    }).agent;
    if (!parsed || toSubagentKey(parsed.name) !== item.key) {
      return failed("subagent name does not match the sync key");
    }
    const existing = current.get(item.key);
    try {
      if (item.mode === "createOnly") {
        // 列表加载后目标端出现同名子智能体：不写入，提示刷新后重试。
        if (existing) return { key: item.key, status: "conflict" };
        const targetPath = join(root, payloadItem.fileName);
        if (await pathExists(targetPath))
          return failed(`target path already exists: ${targetPath}`);
        await mkdir(root, { recursive: true });
        await writeFileAtomically(targetPath, content);
        return { key: item.key, status: "created", createdPath: targetPath };
      }
      if (!existing || !item.expectedTargetHash) return { key: item.key, status: "conflict" };
      if (hashContent(existing.content) !== item.expectedTargetHash) {
        return { key: item.key, status: "conflict" };
      }
      // 替换目标端该 name 对应的实际文件（文件名可能与来源不同），不另建新文件。
      const { mode } = await lstat(existing.filePath);
      await writeFileAtomically(existing.filePath, content, mode);
      return { key: item.key, status: "updated" };
    } catch (error) {
      return failed(errorMessage(error));
    }
  }

  return {
    async listSyncItems() {
      const [{ agents }, { disabled, builtInOverrides }] = await Promise.all([
        resolveUserSubagents(),
        readSubagentState(),
      ]);
      const userItems: DataSyncListItem[] = [...agents.values()].map((agent) => ({
        key: agent.key,
        name: agent.name,
        description: agent.description,
        signature: { fileCount: 1, totalBytes: agent.content.byteLength },
        // 单个 markdown 文件，列表时已读入字节，哈希直接返回，比较时不再单独请求。
        contentHash: hashContent(agent.content),
        enabled: !disabled.has(toUserAgentStateId(agent.key)),
        ...(agent.dependencies ? { dependencies: agent.dependencies } : {}),
      }));
      // 内置智能体的模型覆盖与用户子智能体放在同一个列表（不分组），哈希直接返回。
      const overrideItems: DataSyncListItem[] = [...builtInOverrides.values()].map((override) => ({
        key: override.key,
        name: override.name,
        contentHash: override.hash,
        enabled: true,
        builtInModelOverride: toModelOverrideSummary(override.modelSelection),
      }));
      return { items: [...userItems, ...overrideItems], homeDir: resolveUserHomeDir() };
    },

    async getSyncContentHashes(params) {
      const [{ agents }, { builtInOverrides }] = await Promise.all([
        resolveUserSubagents(),
        readSubagentState(),
      ]);
      const hashes: Record<string, string> = {};
      for (const key of params.keys) {
        const agent = agents.get(key);
        const hash = agent ? hashContent(agent.content) : builtInOverrides.get(key)?.hash;
        if (hash) hashes[key] = hash;
      }
      return { hashes };
    },

    async checkSyncWriteAccess() {
      return await checkRemoteSyncDirectoriesWriteAccess([
        await resolveUserSubagentRoot(),
        dirname(await resolveSubagentStateFile()),
      ]);
    },

    async exportSyncItems(params) {
      const [{ agents }, { disabled, builtInOverrides }] = await Promise.all([
        resolveUserSubagents(),
        readSubagentState(),
      ]);
      return {
        sourceHomeDir: resolveUserHomeDir(),
        builtInModelOverrides: params.keys
          .filter((key) => BUILT_IN_OVERRIDE_KEYS.has(key))
          .map((key) => {
            const override = builtInOverrides.get(key);
            if (!override) throw new Error(`subagent sync item not found: ${key}`);
            return { key, name: override.name, modelSelection: override.modelSelection };
          }),
        items: params.keys
          .filter((key) => !BUILT_IN_OVERRIDE_KEYS.has(key))
          .map((key) => {
            const agent = agents.get(key);
            if (!agent) throw new Error(`subagent sync item not found: ${key}`);
            return {
              key,
              name: agent.name,
              fileName: basename(agent.filePath),
              content: new Uint8Array(agent.content),
              enabled: !disabled.has(toUserAgentStateId(key)),
            };
          }),
      };
    },

    async importSyncItems(params) {
      // 目标端同样先迁移再计算哈希，与列表时给出的 expectedTargetHash 口径一致。
      const { root, agents } = await resolveUserSubagents();
      const payloadByKey = new Map(params.payload.items.map((item) => [item.key, item]));
      const results: Array<DataSyncImportResultItem & { createdPath?: string }> = [];
      for (const item of params.items) {
        if (BUILT_IN_OVERRIDE_KEYS.has(item.key)) continue;
        results.push(await importOne(item, payloadByKey.get(item.key), root, agents));
      }
      await applyCreatedEnabledState(results, payloadByKey);
      const overrideResults = await importBuiltInModelOverrides(
        params.items.filter((item) => BUILT_IN_OVERRIDE_KEYS.has(item.key)),
        params.payload.builtInModelOverrides,
      );
      return {
        results: [
          ...results.map(({ createdPath: _createdPath, ...result }) => result),
          ...overrideResults,
        ],
      };
    },
  };
}

/**
 * 启用状态：新建项带上来源的禁用状态（`agents-state.json` 的 disabledAgentIds，键按 name，不用换算路径）；
 * 更新项不动，保留目标端状态。插件智能体的模型覆盖属于本机状态，不读也不写；内置智能体的覆盖见
 * importBuiltInModelOverrides。
 * 状态文件写入失败（例如文件损坏）时删除本次需要改状态的新建项并标为失败，避免远端出现状态不对的子智能体。
 *
 * 修复：原来只处理来源禁用的新建项，目标端残留的同名禁用 ID（例如以前删除的子智能体留下的）不清除，
 * 来源启用的新建项在远端仍是禁用；列表哈希不含启用状态，还显示「已同步」。
 * 现在先读目标端当前禁用集合，只处理来源状态与目标状态不一致的新建项（来源禁用→加入，来源启用→删除），
 * 与 commandDataSync 一致。不对所有新建项都写：状态文件损坏时按全部启用读取，来源启用的新建项不写、照常新建。
 */
async function applyCreatedEnabledState(
  results: Array<DataSyncImportResultItem & { createdPath?: string }>,
  payloadByKey: Map<string, SubagentDataSyncPayload["items"][number]>,
): Promise<void> {
  const currentDisabled = (await readSubagentState()).disabled;
  const entries = results.flatMap((result) => {
    if (result.status !== "created" || !result.createdPath) return [];
    const id = toUserAgentStateId(result.key);
    const disabled = payloadByKey.get(result.key)?.enabled === false;
    return disabled === currentDisabled.has(id) ? [] : [{ result, id, disabled }];
  });
  if (entries.length === 0) return;
  const stateFile = await resolveSubagentStateFile();
  try {
    await migrateSubagentStateFile(stateFile);
    await updateJsonObjectFile(stateFile, (state) => {
      const disabledIds = new Set(
        Array.isArray(state.disabledAgentIds)
          ? state.disabledAgentIds.filter((id): id is string => typeof id === "string")
          : [],
      );
      for (const { id, disabled } of entries) {
        if (disabled) disabledIds.add(id);
        else disabledIds.delete(id);
      }
      return { ...state, disabledAgentIds: [...disabledIds].sort() };
    });
  } catch (error) {
    for (const { result } of entries) {
      await rm(result.createdPath!, { force: true });
      result.status = "failed";
      result.error = errorMessage(error);
    }
  }
}

interface BuiltInOverrideCandidate {
  item: DataSyncImportItem;
  name: BuiltInSubagentName;
  selection: ModelSelection;
}

/** 在状态文件内容上逐项核对目标端当前值；没有项通过核对时 changed 为 false。 */
function planBuiltInOverrideImport(
  state: Record<string, unknown>,
  candidates: readonly BuiltInOverrideCandidate[],
): { results: DataSyncImportResultItem[]; next: Record<string, unknown>; changed: boolean } {
  const current = resolveBuiltInOverrides(
    normalizeBuiltInSelectionOverrides(state.builtInModelSelectionOverrides),
  );
  const raw = state.builtInModelSelectionOverrides;
  const overrides: Record<string, unknown> =
    raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  const results = candidates.map(({ item, name, selection }): DataSyncImportResultItem => {
    const existing = current.get(item.key);
    const conflict =
      item.mode === "createOnly"
        ? Boolean(existing)
        : !existing || !item.expectedTargetHash || existing.hash !== item.expectedTargetHash;
    if (conflict) return { key: item.key, status: "conflict" };
    overrides[name] = selection;
    return { key: item.key, status: item.mode === "createOnly" ? "created" : "updated" };
  });
  return {
    results,
    next: { ...state, builtInModelSelectionOverrides: overrides },
    changed: results.some((result) => result.status !== "conflict"),
  };
}

/**
 * 内置智能体模型覆盖的导入（docs/remote/data-sync.md「子智能体」）：迁移后逐项核对目标端当前值，
 * 只写通过核对的项；禁用状态、插件覆盖和未知字段原样保留。没有项通过核对时不写文件。
 * createOnly 时目标端已有覆盖、overwrite 时目标项哈希与 expectedTargetHash 不一致，都返回 conflict。
 * 不校验目标端是否有对应的 Provider 与模型，与用户子智能体 frontmatter 的 model 一致。
 * 状态文件损坏或写入失败时这些项全部失败，文件不变。
 */
async function importBuiltInModelOverrides(
  items: DataSyncImportItem[],
  payload: SubagentDataSyncPayload["builtInModelOverrides"],
): Promise<DataSyncImportResultItem[]> {
  if (items.length === 0) return [];
  const payloadByKey = new Map(payload.map((item) => [item.key, item]));
  const results = new Map<string, DataSyncImportResultItem>();
  const candidates: BuiltInOverrideCandidate[] = [];
  for (const item of items) {
    const payloadItem = payloadByKey.get(item.key);
    const selection = modelSelectionSchema.safeParse(payloadItem?.modelSelection).data;
    if (
      !payloadItem ||
      !selection ||
      !BUILT_IN_AGENT_NAMES.includes(payloadItem.name) ||
      toBuiltInOverrideKey(payloadItem.name) !== item.key
    ) {
      results.set(item.key, {
        key: item.key,
        status: "failed",
        error: "built-in subagent model override is missing or invalid in the sync payload",
      });
      continue;
    }
    candidates.push({
      item,
      name: payloadItem.name,
      selection: normalizeSubagentModelSelection(selection)!,
    });
  }
  if (candidates.length > 0) {
    const stateFile = await resolveSubagentStateFile();
    try {
      await migrateSubagentStateFile(stateFile);
      // 修复：原来核对写在 updateJsonObjectFile 的回调里，而它不论回调返回什么都会写文件，
      // 所有项都冲突时也重写远端状态文件（内容不变，字节与 mtime 改变），违背「冲突不写入」。
      // 修法同 hookDataSync：先在当前内容上试算，没有写入项时不碰文件；有写入项时在读改写中重新核对。
      let planned = planBuiltInOverrideImport(
        await readJsonObjectFileForUpdate(stateFile),
        candidates,
      );
      if (planned.changed) {
        await updateJsonObjectFile(stateFile, (state) => {
          planned = planBuiltInOverrideImport(state, candidates);
          return planned.next;
        });
      }
      for (const result of planned.results) results.set(result.key, result);
    } catch (error) {
      for (const { item } of candidates) {
        results.set(item.key, { key: item.key, status: "failed", error: errorMessage(error) });
      }
    }
  }
  return items.map((item) => results.get(item.key)!);
}
