import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";

const SOURCEMAP_REFERENCE_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".css"]);
// 只清理位于行首的 sourceMappingURL 注释。压缩后的 bundle 可能在模板字符串里内嵌
// 这段文本（例如内嵌 TypeScript 编译器的 emitter 源码），行中匹配会把该行剩余内容整段
// 吞掉，直接产出语法损坏的产物；真实的 sourcemap 注释总是由构建工具单独成行输出。
const SOURCE_MAPPING_URL_LINE_RE = /(?:^|\r?\n)[ \t]*\/\/[#@][ \t]*sourceMappingURL=[^\r\n]*/g;
const SOURCE_MAPPING_URL_BLOCK_RE =
  /(?:^|\r?\n)[ \t]*\/\*[#@][ \t]*sourceMappingURL=[\s\S]*?\*\/[ \t]*/g;
// Gen UI 离线库按原始 SHA256 固定；删掉 Lucide 的 sourcemap 注释也会破坏快照清单。
// renderer 与 Agent 各携带一份，两个位置都保留原始字节，普通构建代码照常清理。
const PINNED_GEN_UI_VENDOR_DIRECTORIES = [
  join("out", "plugin-sandbox", "vendor"),
  join("glm", "packages", "visualize-plugin", "skills", "visualize", "assets", "vendor"),
].map((directory) => `${sep}${directory}${sep}`);

export function stripSourceMappingUrlComments(source) {
  return source.replace(SOURCE_MAPPING_URL_LINE_RE, "").replace(SOURCE_MAPPING_URL_BLOCK_RE, "");
}

async function walkFiles(rootDir, visitor) {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const entryPath = resolve(rootDir, entry.name);
    // 跟随资源内链接，保持原 statSync 遍历的清理范围。
    const info = entry.isSymbolicLink() ? await stat(entryPath) : entry;
    if (info.isDirectory()) await walkFiles(entryPath, visitor);
    else if (info.isFile()) await visitor(entryPath);
  }
}

export async function stripSourceMappingUrlCommentsInDirectory(rootDir) {
  const summary = { filesChanged: 0, referencesRemoved: 0 };
  await walkFiles(rootDir, async (filePath) => {
    if (
      !SOURCEMAP_REFERENCE_EXTENSIONS.has(extname(filePath)) ||
      PINNED_GEN_UI_VENDOR_DIRECTORIES.some((directory) => filePath.includes(directory))
    ) {
      return;
    }
    const source = await readFile(filePath, "utf8");
    const referencesRemoved =
      (source.match(SOURCE_MAPPING_URL_LINE_RE)?.length ?? 0) +
      (source.match(SOURCE_MAPPING_URL_BLOCK_RE)?.length ?? 0);
    if (referencesRemoved === 0) {
      return;
    }

    await writeFile(filePath, stripSourceMappingUrlComments(source));
    summary.filesChanged++;
    summary.referencesRemoved += referencesRemoved;
  });
  return summary;
}

export async function removeSourceMapFilesInDirectory(rootDir) {
  const summary = { filesRemoved: 0 };
  await walkFiles(rootDir, async (filePath) => {
    if (extname(filePath) !== ".map") return;
    await unlink(filePath);
    summary.filesRemoved++;
  });
  return summary;
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function cleanupPackagedSourcemaps({
  appAsarPath,
  resourcesDir,
  runAsarCommand,
  runTimedAsync,
  replaceAppAsarFromStaging,
  prepareStaging = async () => false,
  logger = console,
}) {
  if (await pathExists(appAsarPath)) {
    await mkdir(tmpdir(), { recursive: true });
    const stagingDir = await mkdtemp(resolve(tmpdir(), "zcodium-app-asar-finalize-"));
    try {
      await runTimedAsync("afterPack:asar-finalize:extract", () =>
        runAsarCommand(["extract", appAsarPath, stagingDir]),
      );
      // 依赖注入与 sourcemap 清理此前分别解包和重写整个 archive；合并后仅提交一次候选包。
      const prepared = await prepareStaging(stagingDir);
      const stripSummary = await stripSourceMappingUrlCommentsInDirectory(stagingDir);
      const mapSummary = await removeSourceMapFilesInDirectory(stagingDir);
      const changed = prepared || stripSummary.referencesRemoved > 0 || mapSummary.filesRemoved > 0;
      if (changed) {
        logger.log(
          `[afterPack] stripped sourceMappingURL references=${stripSummary.referencesRemoved} files=${stripSummary.filesChanged} maps=${mapSummary.filesRemoved}`,
        );
        await runTimedAsync("afterPack:asar-finalize:pack", () =>
          replaceAppAsarFromStaging({ sourceDir: stagingDir, appAsarPath }),
        );
      } else {
        logger.log("[afterPack] app.asar finalization found no changes");
      }
    } finally {
      await rm(stagingDir, { force: true, recursive: true });
    }
  }

  const stripSummary = await stripSourceMappingUrlCommentsInDirectory(resourcesDir);
  const mapSummary = await removeSourceMapFilesInDirectory(resourcesDir);
  logger.log(
    `[afterPack] resources sourcemap cleanup references=${stripSummary.referencesRemoved} files=${stripSummary.filesChanged} maps=${mapSummary.filesRemoved}`,
  );
}
