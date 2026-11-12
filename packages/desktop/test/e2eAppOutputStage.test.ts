import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { stageE2EAppOutput } from "./e2e/helpers/e2e-app-output-stage.js";

const testDirs: string[] = [];
const desktopTestRoot = resolve("packages/desktop");

afterEach(async () => {
  await Promise.all(
    testDirs.splice(0).map(async (dir) => {
      // 原因：递归清理只允许本测试生成的真实目录，不跟随被替换的 junction 或符号链接。
      if (
        !relative(desktopTestRoot, dir).startsWith(".e2e-stage-test-") ||
        (await lstat(dir)).isSymbolicLink() ||
        relative(dir, await realpath(dir)) !== ""
      )
        throw new Error("Invalid E2E staging test cleanup path");
      await rm(dir, { force: true, recursive: true });
    }),
  );
});

async function createTestDirs() {
  if (relative(desktopTestRoot, await realpath(desktopTestRoot)) !== "")
    throw new Error("E2E staging test parent crosses a symbolic link");
  const root = await mkdtemp(resolve(desktopTestRoot, ".e2e-stage-test-"));
  testDirs.push(root);
  return {
    destination: resolve(root, "destination"),
    root,
    source: resolve(root, "source"),
  };
}

describe("desktop E2E app output staging", () => {
  it("共享构建被类型检查原地覆盖后，递归快照保持原产物", async () => {
    const { destination, source } = await createTestDirs();
    await mkdir(resolve(source, "host"), { recursive: true });
    const sourceEntry = resolve(source, "host", "index.js");
    await writeFile(sourceEntry, "bundled-host");
    await stageE2EAppOutput(source, destination);
    await writeFile(sourceEntry, "unbundled-tsc-output");
    expect(await readFile(resolve(destination, "host", "index.js"), "utf8")).toBe("bundled-host");
  });

  it("用例修改隔离副本时，不污染共享构建或其他 shard", async () => {
    const { destination, root, source } = await createTestDirs();
    await mkdir(source, { recursive: true });
    await writeFile(resolve(source, "main.js"), "original");
    const another = resolve(root, "another-shard");
    await stageE2EAppOutput(source, destination);
    await stageE2EAppOutput(source, another);
    await writeFile(resolve(destination, "main.js"), "case-specific");
    expect(await readFile(resolve(source, "main.js"), "utf8")).toBe("original");
    expect(await readFile(resolve(another, "main.js"), "utf8")).toBe("original");
  });

  it("Windows 开发态图标位于隔离 Main 的相对资源目录，复制后保持独立原字节", async () => {
    const { destination, root, source } = await createTestDirs();
    const icons = resolve(root, "source-icons");
    await mkdir(source, { recursive: true });
    await mkdir(icons);
    for (const name of ["icon.ico", "icon_windows.png"]) {
      await writeFile(resolve(icons, name), `original-${name}`);
    }
    await stageE2EAppOutput(source, destination, {
      developmentIcons: { sourceDir: icons, platform: "win32" },
    });
    for (const name of ["icon.ico", "icon_windows.png"]) {
      await writeFile(resolve(icons, name), "modified-source");
      expect(await readFile(resolve(destination, "main", "../../build", name), "utf8")).toBe(
        `original-${name}`,
      );
    }
  });

  it("macOS 只复制现有 PNG，缺少当前平台图标时拒绝准备", async () => {
    const { destination, root, source } = await createTestDirs();
    const icons = resolve(root, "source-icons");
    await mkdir(source, { recursive: true });
    await mkdir(icons);
    await writeFile(resolve(icons, "icon.png"), "mac-icon");
    await writeFile(resolve(icons, "icon.ico"), "unused-windows-icon");
    await stageE2EAppOutput(source, destination, {
      developmentIcons: { sourceDir: icons, platform: "darwin" },
    });
    expect(await readFile(resolve(destination, "../build/icon.png"), "utf8")).toBe("mac-icon");
    await expect(access(resolve(destination, "../build/icon.ico"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      stageE2EAppOutput(source, resolve(root, "missing-icons"), {
        developmentIcons: { sourceDir: icons, platform: "win32" },
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("替换隔离应用前验证路径，清理旧产物但保留共享源", async () => {
    const { destination, source } = await createTestDirs();
    await mkdir(source, { recursive: true });
    await mkdir(destination);
    await writeFile(resolve(destination, "stale.js"), "stale");
    await writeFile(resolve(source, "main.js"), "fresh");
    await stageE2EAppOutput(source, destination, { replace: true });
    await expect(access(resolve(destination, "stale.js"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(resolve(source, "main.js"), "utf8")).toBe("fresh");
    for (const destinationPath of [source, resolve(source, "nested"), resolve(source, "..")]) {
      await expect(stageE2EAppOutput(source, destinationPath, { replace: true })).rejects.toThrow(
        "must be disjoint",
      );
    }
    expect(await readFile(resolve(source, "main.js"), "utf8")).toBe("fresh");
  });
});
