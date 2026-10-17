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
import { extname, resolve } from "node:path";

const SOURCEMAP_REFERENCE_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".css"]);
// 只清理位于行首的 sourceMappingURL 注释，避免误删压缩代码中的字符串内容。
const SOURCE_MAPPING_URL_LINE_RE = /(?:^|\r?\n)[ \t]*\/\/[#@][ \t]*sourceMappingURL=[^\r\n]*/g;
const SOURCE_MAPPING_URL_BLOCK_RE =
  /(?:^|\r?\n)[ \t]*\/\*[#@][ \t]*sourceMappingURL=[\s\S]*?\*\/[ \t]*/g;

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
    // 与原 statSync walker 保持一致：资源中的链接也要清理，不能因异步化遗漏 sourcemap。
    const info = entry.isSymbolicLink() ? await stat(entryPath) : entry;
    if (info.isDirectory()) await walkFiles(entryPath, visitor);
    else if (info.isFile()) await visitor(entryPath);
  }
}

export async function stripSourceMappingUrlCommentsInDirectory(rootDir) {
  const summary = { filesChanged: 0, referencesRemoved: 0 };
  await walkFiles(rootDir, async (filePath) => {
    if (!SOURCEMAP_REFERENCE_EXTENSIONS.has(extname(filePath))) return;
    const source = await readFile(filePath, "utf8");
    const referencesRemoved =
      (source.match(SOURCE_MAPPING_URL_LINE_RE)?.length ?? 0) +
      (source.match(SOURCE_MAPPING_URL_BLOCK_RE)?.length ?? 0);
    if (referencesRemoved === 0) return;
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
    const stagingDir = await mkdtemp(resolve(tmpdir(), "zcode-app-asar-finalize-"));
    try {
      await runTimedAsync("afterPack:asar-finalize:extract", () =>
        runAsarCommand(["extract", appAsarPath, stagingDir]),
      );
      // Runtime 依赖注入与 sourcemap 清理此前各自 extract/repack 一遍，重复遍历和重写整个归档；
      // 同一 staging 事务串行完成两者，仅任一实际改变时提交一次候选归档。
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
      } else logger.log("[afterPack] app.asar finalization found no changes");
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
