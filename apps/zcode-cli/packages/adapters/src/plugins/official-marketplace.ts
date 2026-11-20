import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";

const BUNDLED_PARTITION_FILE = "bundled-marketplace.json";

interface BundledMarketplacePartition {
  manifest: Record<string, unknown>;
  version: 1;
}

export async function writeBundledOfficialMarketplacePartition(input: {
  manifest: Record<string, unknown>;
  storageRoot: string;
}): Promise<Record<string, unknown>> {
  assertOfficialManifest(input.manifest);
  await writeJsonFile(partitionPath(input.storageRoot, BUNDLED_PARTITION_FILE), {
    manifest: input.manifest,
    version: 1,
  } satisfies BundledMarketplacePartition);
  return input.manifest;
}

/** 只有当前随包 seed 是内置目录权威，历史 CDN/合并缓存不能复活条目。 */
export function loadBundledOfficialMarketplaceSync(
  storageRoot: string,
): Record<string, unknown> | undefined {
  return readBundledPartition(storageRoot)?.manifest;
}

export function getBundledMarketplaceRecordSync(storageRoot: string) {
  const manifest = loadBundledOfficialMarketplaceSync(storageRoot);
  return {
    id: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
    source: { source: "bundled" as const },
    name: "ZCodium",
    description: "Plugins bundled with ZCodium.",
    addedAt: "",
    pluginCount: readPluginEntries(manifest).length,
  };
}

export function loadBundledOfficialPluginRootsSync(storageRoot: string): string[] | undefined {
  const bundledPartition = readBundledPartition(storageRoot);
  if (!bundledPartition) return undefined;

  const officialCacheRoot = resolve(storageRoot, "cache", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE);
  return readPluginEntries(bundledPartition.manifest).flatMap((plugin) => {
    const name = readPluginName(plugin);
    const cachePath = typeof plugin.cachePath === "string" ? plugin.cachePath : undefined;
    if (!name || !cachePath) return [];

    const pluginCacheRoot = resolve(officialCacheRoot, name);
    const resolvedCachePath = resolve(cachePath);
    if (
      !isStrictDescendant(officialCacheRoot, pluginCacheRoot) ||
      !isStrictDescendant(pluginCacheRoot, resolvedCachePath)
    ) {
      return [];
    }
    return [resolvedCachePath];
  });
}

function readBundledPartition(storageRoot: string): BundledMarketplacePartition | undefined {
  const value = readJsonRecord(partitionPath(storageRoot, BUNDLED_PARTITION_FILE));
  if (
    !value ||
    value.version !== 1 ||
    !isRecord(value.manifest) ||
    value.manifest.name !== ZCODE_OFFICIAL_PLUGIN_MARKETPLACE ||
    !Array.isArray(value.manifest.plugins)
  )
    return undefined;
  return {
    manifest: value.manifest,
    version: 1,
  };
}

function readPluginEntries(
  manifest: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  return Array.isArray(manifest?.plugins) ? manifest.plugins.filter(isRecord) : [];
}

function readPluginName(plugin: Record<string, unknown>): string | undefined {
  return typeof plugin.name === "string" && plugin.name.length > 0 ? plugin.name : undefined;
}

function isStrictDescendant(parentPath: string, childPath: string): boolean {
  const relativePath = relative(parentPath, childPath);
  return (
    relativePath.length > 0 &&
    !isAbsolute(relativePath) &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`)
  );
}

function assertOfficialManifest(manifest: Record<string, unknown>): void {
  if (manifest.name !== ZCODE_OFFICIAL_PLUGIN_MARKETPLACE) {
    throw new Error(
      `Official marketplace manifest must be named ${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`,
    );
  }
}

function partitionPath(storageRoot: string, fileName: string): string {
  return join(storageRoot, "marketplaces", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE, fileName);
}

function readJsonRecord(path: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  // 写入由分片文件锁串行发布；同内容不落盘，失败保留上一份完整 seed。
  await withFileLock(path, async () => {
    try {
      if ((await readFile(path, "utf8")) === contents) return;
    } catch {
      /* 读取失败继续实际写入。 */
    }
    await atomicWritePrivateTextFile(path, contents);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadBundledOfficialMarketplace(
  storageRoot: string,
): Promise<Record<string, unknown> | undefined> {
  return (await readBundledPartitionAsync(storageRoot))?.manifest;
}

export async function loadBundledOfficialPluginRoots(
  storageRoot: string,
): Promise<string[] | undefined> {
  const bundledPartition = await readBundledPartitionAsync(storageRoot);
  if (!bundledPartition) return undefined;

  const officialCacheRoot = resolve(storageRoot, "cache", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE);
  return readPluginEntries(bundledPartition.manifest).flatMap((plugin) => {
    const name = readPluginName(plugin);
    const cachePath = typeof plugin.cachePath === "string" ? plugin.cachePath : undefined;
    if (!name || !cachePath) return [];

    const pluginCacheRoot = resolve(officialCacheRoot, name);
    const resolvedCachePath = resolve(cachePath);
    if (
      !isStrictDescendant(officialCacheRoot, pluginCacheRoot) ||
      !isStrictDescendant(pluginCacheRoot, resolvedCachePath)
    ) {
      return [];
    }
    return [resolvedCachePath];
  });
}

async function readBundledPartitionAsync(
  storageRoot: string,
): Promise<BundledMarketplacePartition | undefined> {
  const value = await readJsonRecordAsync(partitionPath(storageRoot, BUNDLED_PARTITION_FILE));
  if (
    !value ||
    value.version !== 1 ||
    !isRecord(value.manifest) ||
    value.manifest.name !== ZCODE_OFFICIAL_PLUGIN_MARKETPLACE ||
    !Array.isArray(value.manifest.plugins)
  )
    return undefined;
  return {
    manifest: value.manifest,
    version: 1,
  };
}

async function readJsonRecordAsync(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
