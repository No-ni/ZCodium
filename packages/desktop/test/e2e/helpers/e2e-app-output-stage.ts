import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../../../../..");

function contains(parent: string, target: string) {
  const suffix = relative(parent, target);
  return (
    suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
  );
}

async function assertStagingPath(path: string) {
  const target = resolve(path);
  if (
    !isAbsolute(path) ||
    relative(repositoryRoot, target) === "" ||
    !contains(repositoryRoot, target)
  )
    throw new Error("E2E staging path must stay within the approved worktree");
  const volume = parse(target).root;
  let current = volume;
  for (const segment of relative(volume, target).split(sep)) {
    current = join(current, segment);
    let entry;
    try {
      entry = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (entry.isSymbolicLink() || relative(current, await realpath(current)) !== "")
      throw new Error("E2E staging path crosses a junction or symbolic link");
    if (current !== target && !entry.isDirectory()) throw new Error("Invalid E2E staging parent");
  }
  return target;
}

export async function stageE2EAppOutput(
  sourceDir: string,
  destinationDir: string,
  options: {
    replace?: boolean;
    developmentIcons?: { sourceDir: string; platform: NodeJS.Platform };
  } = {},
) {
  await Promise.all([assertStagingPath(sourceDir), assertStagingPath(destinationDir)]);
  if (contains(sourceDir, destinationDir) || contains(destinationDir, sourceDir))
    throw new Error("E2E staging source and destination must be disjoint");
  const iconNames =
    options.developmentIcons?.platform === "win32"
      ? ["icon.ico", "icon_windows.png"]
      : options.developmentIcons?.platform === "darwin"
        ? ["icon.png"]
        : [];
  const buildDir = resolve(destinationDir, "../build");
  const icons = await Promise.all(
    iconNames.map(async (name) => {
      const source = join(options.developmentIcons!.sourceDir, name);
      const destination = join(buildDir, name);
      await Promise.all([assertStagingPath(source), assertStagingPath(destination)]);
      if (!(await lstat(source)).isFile()) throw new Error("Unsupported E2E icon resource");
      return { source, destination };
    }),
  );
  // 原因：清理前验证工作树边界及资源，拒绝 junction 写穿或删除共享源；仅替换当前 run 的副本。
  if (options.replace) await rm(destinationDir, { force: true, recursive: true });
  await copyAppOutput(sourceDir, destinationDir);
  if (icons.length) {
    await mkdir(buildDir, { recursive: true });
    await Promise.all(
      icons.map(({ source, destination }) =>
        copyFile(source, destination, constants.COPYFILE_FICLONE),
      ),
    );
  }
}

async function copyAppOutput(sourceDir: string, destinationDir: string) {
  await Promise.all([assertStagingPath(sourceDir), assertStagingPath(destinationDir)]);
  await mkdir(destinationDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const sourcePath = join(sourceDir, entry.name);
      const destinationPath = join(destinationDir, entry.name);
      if (entry.isDirectory()) {
        await copyAppOutput(sourcePath, destinationPath);
        return;
      }
      if (!entry.isFile()) {
        throw new Error("Unsupported E2E app output entry");
      }
      await assertStagingPath(destinationPath);
      // 硬链接共享 inode，类型检查原地覆盖 out 或用例改写副本都会污染其他运行。
      // 写时复制使用独立 inode；不支持克隆的文件系统由 Node 自动回退为普通复制。
      await copyFile(sourcePath, destinationPath, constants.COPYFILE_FICLONE);
    }),
  );
}
