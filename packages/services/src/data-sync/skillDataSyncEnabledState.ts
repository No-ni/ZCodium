import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { DataSyncImportResultItem, SkillDataSyncPayload } from "@zcode/shared";
import { updateJsonObjectFile } from "#src/fs/atomicFileUtils.js";
import { isPathWithin } from "./directoryContent.js";
import {
  getCliConfigPath,
  isSkillEnabled,
  normalizeSkillConfigPath,
  readSkillEnabledOverrides,
  SKILL_FILE_NAME,
} from "./skillDataSyncDiscovery.js";
import { errorMessage } from "./syncUtils.js";

/**
 * 启用状态：新建项带上来源的启用状态，键换算为目标端 SKILL.md 路径；更新项不动，保留目标端状态。
 * config.json 写入失败（例如文件损坏）时删除需要写状态的新建项目录并标为失败，避免远端出现状态不对的技能。
 *
 * 修复：原来只给来源禁用的新建项写 `{ enable: false }`；目标端同路径残留的 `enable:false`（例如以前删除的
 * 技能留下的）不清除，来源启用的新建项在远端仍是禁用，列表哈希不含启用状态，还显示「已同步」。
 * 现在与 subagentDataSync 一致：先读目标端当前 override，只处理来源状态与目标状态不一致的新建项
 * （来源禁用→写 `{ enable: false }`；来源启用→删除该 key，开启态不落盘，见 skillsService 的 writeSkillEnabledMap）。
 * 来源启用且没有残留的新建项不写 config：文件损坏时按全部启用读取，这些项照常新建。
 */
export async function applyCreatedEnabledState(
  results: Array<DataSyncImportResultItem & { createdPath?: string }>,
  payloadByKey: Map<string, SkillDataSyncPayload["items"][number]>,
): Promise<void> {
  const overrides = await readSkillEnabledOverrides();
  const entries = results.flatMap((result) => {
    if (result.status !== "created" || !result.createdPath) return [];
    const skillFilePath = join(result.createdPath, SKILL_FILE_NAME);
    const disabled = payloadByKey.get(result.key)?.enabled === false;
    return disabled === !isSkillEnabled(overrides, skillFilePath)
      ? []
      : [{ result, configKey: normalizeSkillConfigPath(skillFilePath), disabled }];
  });
  if (entries.length === 0) return;
  try {
    await updateJsonObjectFile(getCliConfigPath(), (config) => {
      const next = { ...config };
      const skills =
        config.skills && typeof config.skills === "object" && !Array.isArray(config.skills)
          ? { ...(config.skills as Record<string, unknown>) }
          : {};
      for (const { configKey, disabled } of entries) {
        if (disabled) skills[configKey] = { enable: false };
        else delete skills[configKey];
      }
      if (Object.keys(skills).length > 0) next.skills = skills;
      else delete next.skills;
      return next;
    });
  } catch (error) {
    const removed = entries.map(({ result }) => result.createdPath!);
    for (const { result } of entries) {
      await rm(result.createdPath!, { recursive: true, force: true });
      result.status = "failed";
      result.error = errorMessage(error);
    }
    // 随被删除的上级目录一起写入的下级新建项，文件也已不在，同样标为失败。
    for (const result of results) {
      if (
        result.status === "created" &&
        result.createdPath &&
        removed.some((path) => isPathWithin(path, result.createdPath!))
      ) {
        result.status = "failed";
        result.error = errorMessage(error);
      }
    }
  }
}
