import { realpath, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pickPortablePluginOptions, type DataSyncImportResultItem } from "@zcode/shared";
import { updateJsonObjectFile } from "#src/fs/atomicFileUtils.js";
import {
  getUserZcodeConfigPath,
  getUserZcodePluginRoot,
  normalizePluginIdKey,
  readPluginManifestInfo,
  readUserPluginConfigState,
} from "#src/plugin-sync/pluginSyncService.js";
import { hasSymlinkWithin, isPathWithin } from "./directoryContent.js";
import { inlinePluginKey, isRecord } from "./inlinePluginDataSyncPayload.js";
import type { CreatedPlugin, ResolvedInlinePlugin } from "./inlinePluginDataSyncPayload.js";
import { errorMessage } from "./syncUtils.js";

/**
 * inline 插件的登记表读写：把 plugins.dirs 里登记的 inline 插件解析成条目，以及把导入新建的
 * 插件一次性写回 config.json（dirs、启用状态、安全 options）。从 inlinePluginDataSync.ts 拆出：
 * 那边是同步流程本身，这里是配置与插件目录之间唯一的读写入口。本文件不反向引用父文件。
 */

/**
 * 按 `name@inline`（小写）对齐 plugins.dirs 中登记的 inline 插件；目录名只表示位置。
 * 同 id 重复时保留第一项，与 CLI 运行时「重复插件忽略」一致。
 */
export async function resolveInlinePlugins(): Promise<Map<string, ResolvedInlinePlugin>> {
  const config = await readUserPluginConfigState();
  const pluginRoot = getUserZcodePluginRoot();
  const result = new Map<string, ResolvedInlinePlugin>();
  for (const rawDir of config.dirs) {
    const configuredPath = resolve(rawDir);
    const contentRoot = await realpath(configuredPath).catch(() => null);
    if (!contentRoot) continue;
    const manifest = await readPluginManifestInfo(contentRoot);
    if (!manifest) continue;
    const key = inlinePluginKey(manifest);
    if (result.has(key)) continue;
    const overwriteBlockedReason = !isPathWithin(pluginRoot, configuredPath)
      ? ("external-directory" as const)
      : (await hasSymlinkWithin(pluginRoot, configuredPath))
        ? ("target-symlink" as const)
        : undefined;
    const options = config.options[manifest.pluginId];
    result.set(key, {
      key,
      manifest,
      configuredPath,
      contentRoot,
      enabled: config.enabledOverrides.get(key) ?? true,
      options: isRecord(options) ? options : {},
      ...(overwriteBlockedReason ? { overwriteBlockedReason } : {}),
    });
  }
  return result;
}

/**
 * 新建的插件目录只有登记到 plugins.dirs 才会被 Agent 发现：一次写入 dirs、启用状态和安全 options。
 * 启用状态按通用规则带上来源状态；options 按目标端（刚写入的 manifest）schema 再筛一次后合并。
 * config.json 写入失败（例如文件损坏）时删除本次新建的目录并标为失败，避免留下未登记的半同步目录。
 */
export async function registerCreatedPlugins(
  results: Array<DataSyncImportResultItem & { created?: CreatedPlugin }>,
): Promise<void> {
  const created = results.filter((result) => result.status === "created" && result.created);
  if (created.length === 0) return;
  try {
    await updateJsonObjectFile(getUserZcodeConfigPath(), (config) => {
      const plugins: Record<string, unknown> = isRecord(config.plugins) ? config.plugins : {};
      const dirs = Array.isArray(plugins.dirs)
        ? plugins.dirs.filter((dir): dir is string => typeof dir === "string")
        : [];
      const enabledPlugins = isRecord(plugins.enabledPlugins) ? { ...plugins.enabledPlugins } : {};
      const pluginOptions = isRecord(plugins.options) ? { ...plugins.options } : {};
      for (const { created: entry } of created) {
        const { path, manifest, payloadItem } = entry!;
        if (!dirs.some((dir) => resolve(dir) === path)) dirs.push(path);
        const id = manifest.pluginId;
        // 去掉同 id 的旧启用覆盖（大小写不同也算），新建项的有效状态与来源一致。
        for (const existingId of Object.keys(enabledPlugins)) {
          if (normalizePluginIdKey(existingId) === normalizePluginIdKey(id)) {
            delete enabledPlugins[existingId];
          }
        }
        if (!payloadItem.enabled) enabledPlugins[id] = false;
        const portable = pickPortablePluginOptions(payloadItem.options, manifest.userConfig);
        if (Object.keys(portable).length > 0) {
          pluginOptions[id] = {
            ...(isRecord(pluginOptions[id]) ? pluginOptions[id] : {}),
            ...portable,
          };
        }
      }
      const nextPlugins: Record<string, unknown> = { ...plugins, dirs };
      if (Object.keys(enabledPlugins).length > 0) nextPlugins.enabledPlugins = enabledPlugins;
      else delete nextPlugins.enabledPlugins;
      if (Object.keys(pluginOptions).length > 0) nextPlugins.options = pluginOptions;
      return { ...config, plugins: nextPlugins };
    });
  } catch (error) {
    for (const result of created) {
      await rm(result.created!.path, { recursive: true, force: true });
      result.status = "failed";
      result.error = errorMessage(error);
    }
  }
}
