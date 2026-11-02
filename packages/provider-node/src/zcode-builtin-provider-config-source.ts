import { watch, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { ProviderConfigLayerSnapshot, ProviderSource } from "@zcode/provider";
import {
  decodeZCodeBuiltinRelease,
  serializeZCodeBuiltinRelease,
  type ZCodeBuiltinRelease,
} from "./zcode-builtin-release.js";

export interface NodeZCodeBuiltinProviderConfigSourceOptions {
  readonly bundledFilePath: string;
  readonly watch?: boolean;
}

/** 只读随包配置；个人配置由独立 Repository 管理。 */
export class NodeZCodeBuiltinProviderConfigSource implements ProviderSource<ProviderConfigLayerSnapshot> {
  readonly #bundledFilePath: string;
  readonly #sourceKey: string;
  readonly #watchEnabled: boolean;
  readonly #listeners = new Set<(reason: string) => void>();
  #watcher: FSWatcher | null = null;
  #observedSignature: string | null = null;
  #watchRefresh = Promise.resolve();
  #disposed = false;

  constructor(options: NodeZCodeBuiltinProviderConfigSourceOptions) {
    const bundledFilePath = options.bundledFilePath.trim();
    if (!bundledFilePath) throw new Error("ZCode Built-in bundledFilePath 不能为空");
    this.#bundledFilePath = bundledFilePath;
    // Host 与 Worker 使用同一路径隔离来源，内容身份另计，避免同序号更新被忽略。
    this.#sourceKey = createHash("sha256").update(resolve(bundledFilePath)).digest("hex");
    this.#watchEnabled = options.watch !== false;
  }

  get filePath(): string {
    return this.#bundledFilePath;
  }

  async read(): Promise<ProviderConfigLayerSnapshot> {
    this.#assertNotDisposed();
    this.#ensureWatcher();
    const release = await this.#readRelease();
    // 同一次读取的内容签名可复用，但显式读取不能提前推进 watcher 的已观察版本。
    const signature = signatureOf(release);
    this.#observedSignature ??= signature;
    return snapshotFromRelease(release, this.#sourceKey, signature);
  }

  async #readRelease(): Promise<ZCodeBuiltinRelease> {
    // 只读随包基线：历史 Active/LKG 可能来自官方服务，即使版本更高也不能覆盖本地基线，
    // 所以这里不接受第二个来源路径，也不写任何缓存文件。
    return readBundledRelease(this.#bundledFilePath);
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#assertNotDisposed();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#watcher?.close();
    this.#watcher = null;
    this.#listeners.clear();
  }

  #ensureWatcher(): void {
    if (!this.#watchEnabled || this.#watcher || this.#disposed) return;
    const target = basename(this.#bundledFilePath);
    // 监听目录可能已被清理；挂载失败只能降级为「不监听」，不能让只读基线读取失败。
    // 失败时保持 #watcher 为 null，下一次读取会重新尝试挂载。
    try {
      this.#watcher = watch(dirname(this.#bundledFilePath), (_eventType, fileName) => {
        if (fileName === null || fileName.toString() === target) this.#scheduleWatchRefresh();
      });
    } catch {
      this.#watcher = null;
      return;
    }
    this.#watcher.on("error", () => this.#emit("watch-error"));
  }

  #scheduleWatchRefresh(): void {
    this.#watchRefresh = this.#watchRefresh.then(async () => {
      if (this.#disposed) return;
      try {
        const release = await this.#readRelease();
        const signature = signatureOf(release);
        if (this.#disposed || signature === this.#observedSignature) return;
        this.#observedSignature = signature;
        this.#emit("file-changed");
      } catch {
        this.#emit("watch-error");
      }
    });
  }

  #emit(reason: string): void {
    if (this.#disposed) return;
    for (const listener of this.#listeners) listener(reason);
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("NodeZCodeBuiltinProviderConfigSource 已 dispose");
  }
}

export function createNodeZCodeBuiltinProviderConfigSource(
  options: NodeZCodeBuiltinProviderConfigSourceOptions,
): NodeZCodeBuiltinProviderConfigSource {
  return new NodeZCodeBuiltinProviderConfigSource(options);
}

function snapshotFromRelease(
  release: ZCodeBuiltinRelease,
  sourceKey: string,
  signature: string,
): ProviderConfigLayerSnapshot {
  return Object.freeze({
    revision: `zcode-builtin:${release.revision}:${sourceKey}:${signature}`,
    providers: release.config.providers,
    providerTemplates: release.config.providerTemplates,
    models: release.config.modelConfigRules,
  });
}

function signatureOf(release: ZCodeBuiltinRelease): string {
  return createHash("sha256").update(serializeZCodeBuiltinRelease(release)).digest("hex");
}

/**
 * Bug 原因（取自上游 3.17.1 修复，按本仓「静态随包目录」契约适配）：随包配置在启动时物化到
 * `<envConfigRoot>/runtime/provider/bundled/zcode-builtin.json`，运行中该目录被清理后每次读取
 * 都拿到 ENOENT，配置同步持续失败直到进程重启。随包基线在进程生命周期内不可变（升级以退出旧
 * 进程为前提），因此按路径记住本进程最近一次成功解析的基线，仅在文件缺失时兜底，之后照常由
 * 监听恢复。内容损坏或 Schema 不兼容不兜底：那属于真实损坏，必须继续抛错让上层可见。
 * 用模块级缓存而非实例字段，是因为来源切换会新建实例，也要读到同一基线；本仓不把官方下载
 * 缓存当作可信来源，所以这里只可能保存随包资源的解析结果。
 */
const lastValidBundledReleaseByPath = new Map<string, ZCodeBuiltinRelease>();

async function readBundledRelease(filePath: string): Promise<ZCodeBuiltinRelease> {
  const key = resolve(filePath);
  let release: ZCodeBuiltinRelease;
  try {
    release = decodeZCodeBuiltinRelease(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    const baseline = isFileNotFound(error) ? lastValidBundledReleaseByPath.get(key) : undefined;
    if (!baseline) throw error;
    return baseline;
  }
  lastValidBundledReleaseByPath.set(key, release);
  return release;
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
