import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  collectUserSkillCandidates,
  getUserZcodeSkillRoot,
  normalizeSkillNameKey,
  resolveUserHomeDir,
} from "#src/skill-sync/skillSyncService.js";
import { hasSymlinkWithin, isPathWithin } from "./directoryContent.js";

export const SKILL_FILE_NAME = "SKILL.md";
const SKILL_META_FILE_NAME = "_meta.json";

export interface ResolvedUserSkill {
  key: string;
  name: string;
  description: string;
  directoryName: string;
  /** 技能目录（可能是软链路径）。 */
  directoryPath: string;
  skillFilePath: string;
  location: "zcode" | "agents";
  /** 技能目录或其位于技能根以内的上级目录是软链。 */
  isSymlink: boolean;
}

export function getCliConfigPath(): string {
  return join(resolveUserHomeDir(), ".zcode", "cli", "config.json");
}

export function normalizeSkillConfigPath(path: string): string {
  return path.replaceAll("\\", "/");
}

/** 按归一化 name 对齐的用户级技能；同名时保留候选排序中的第一项（`.zcode` 优先）。 */
export async function resolveUserSkills(): Promise<Map<string, ResolvedUserSkill>> {
  const zcodeRoot = getUserZcodeSkillRoot();
  const result = new Map<string, ResolvedUserSkill>();
  for (const candidate of await collectUserSkillCandidates()) {
    const key = normalizeSkillNameKey(candidate.name);
    if (result.has(key)) continue;
    const directoryPath = dirname(candidate.path);
    const location = isPathWithin(zcodeRoot, directoryPath) ? "zcode" : "agents";
    result.set(key, {
      key,
      name: candidate.name,
      description: candidate.description,
      directoryName: candidate.directoryName,
      directoryPath,
      skillFilePath: candidate.path,
      location,
      isSymlink: location === "zcode" ? await hasSymlinkWithin(zcodeRoot, directoryPath) : false,
    });
  }
  return result;
}

/** 只读展示：config.json 损坏时按空配置处理。写入走 updateJsonObjectFile。 */
export async function readSkillEnabledOverrides(): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(getCliConfigPath(), "utf-8")) as unknown;
    const skills =
      parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).skills : undefined;
    return skills && typeof skills === "object" ? (skills as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function isSkillEnabled(overrides: Record<string, unknown>, skillFilePath: string): boolean {
  const override = overrides[normalizeSkillConfigPath(skillFilePath)];
  return !(
    override &&
    typeof override === "object" &&
    (override as Record<string, unknown>).enable === false
  );
}

/** 版本只取技能商店安装元数据（_meta.json），没有时不比较版本。 */
export async function readSkillStoreVersion(directoryPath: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(join(directoryPath, SKILL_META_FILE_NAME), "utf-8"),
    ) as unknown;
    const version =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>).version
        : undefined;
    return typeof version === "string" && version.trim() ? version.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** 本次导入中已写入目标端的技能：来源相对目录（`/` 分隔）→ 目标端落位目录。 */
export interface PlacedSkill {
  directoryName: string;
  path: string;
}

export function directoryDepth(directoryName: string | undefined): number {
  return directoryName ? directoryName.split("/").length : 0;
}

/** 来源目录包含 `directoryName` 的最近一个已落位技能。 */
export function findPlacedAncestor(
  placed: readonly PlacedSkill[],
  directoryName: string,
): PlacedSkill | undefined {
  let nearest: PlacedSkill | undefined;
  for (const candidate of placed) {
    if (
      directoryName.startsWith(`${candidate.directoryName}/`) &&
      (!nearest || candidate.directoryName.length > nearest.directoryName.length)
    ) {
      nearest = candidate;
    }
  }
  return nearest;
}

/** 同一端内目录包含 `skill` 目录的最近一个技能（列表的 parentKey）。 */
export function findParentSkill(
  skill: ResolvedUserSkill,
  skills: readonly ResolvedUserSkill[],
): ResolvedUserSkill | undefined {
  let nearest: ResolvedUserSkill | undefined;
  for (const other of skills) {
    if (
      other !== skill &&
      isPathWithin(other.directoryPath, skill.directoryPath) &&
      (!nearest || isPathWithin(nearest.directoryPath, other.directoryPath))
    ) {
      nearest = other;
    }
  }
  return nearest;
}
