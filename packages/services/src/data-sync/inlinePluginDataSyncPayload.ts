import type { PluginDataSyncPayload } from "@zcode/shared";
import {
  normalizePluginIdKey,
  type PluginManifestInfo,
} from "#src/plugin-sync/pluginSyncService.js";

/**
 * inline 插件同步的 payload 形状与无 IO 纯辅助：解析后的插件条目、导入新建的插件信息，
 * 以及键归一化与记录判断。inlinePluginDataSync.ts 只 import 这里的内容，本文件不反向
 * 引用父文件，避免循环依赖。
 */
export interface ResolvedInlinePlugin {
  key: string;
  manifest: PluginManifestInfo;
  /** plugins.dirs 中登记的路径（resolve 后，未取 realpath）；覆盖时替换这个位置。 */
  configuredPath: string;
  /** 内容根：configuredPath 的 realpath。 */
  contentRoot: string;
  enabled: boolean;
  options: Record<string, unknown>;
  /** 作为目标时不能被覆盖的原因。 */
  overwriteBlockedReason?: "external-directory" | "target-symlink";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function inlinePluginKey(manifest: PluginManifestInfo): string {
  return normalizePluginIdKey(manifest.pluginId);
}

export interface CreatedPlugin {
  path: string;
  manifest: PluginManifestInfo;
  payloadItem: PluginDataSyncPayload["items"][number];
}
