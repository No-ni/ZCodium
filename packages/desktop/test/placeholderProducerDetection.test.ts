import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isRealComputerUseProducerInstalled,
  readComputerUseProducer,
} from "../scripts/computer-use-producer.mjs";
import { stageDevCuaPluginRuntime } from "../../../scripts/stage-dev-cua-plugin-runtime.mjs";

const roots: string[] = [];

function createWorkspace(cuaManifest: Record<string, unknown> | null) {
  const root = mkdtempSync(join(tmpdir(), "zcode-cua-producer-"));
  roots.push(root);
  const desktopRoot = join(root, "packages", "desktop");
  mkdirSync(desktopRoot, { recursive: true });
  if (cuaManifest) {
    const cuaDir = join(root, "node_modules", "@zcode", "zcode-cua");
    mkdirSync(cuaDir, { recursive: true });
    writeFileSync(join(cuaDir, "package.json"), JSON.stringify(cuaManifest));
  }
  return desktopRoot;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("Computer Use producer detection", () => {
  it("真实 producer：已安装且未声明占位", () => {
    const desktopRoot = createWorkspace({ name: "@zcode/zcode-cua", version: "0.6.4" });
    expect(readComputerUseProducer({ desktopPackageRoot: desktopRoot })).toMatchObject({
      installed: true,
      placeholder: false,
    });
    expect(isRealComputerUseProducerInstalled({ desktopPackageRoot: desktopRoot })).toBe(true);
  });

  it("开源占位包：声明 zcodeCuaPlaceholder 时不算真实 producer", () => {
    const desktopRoot = createWorkspace({ name: "@zcode/zcode-cua", zcodeCuaPlaceholder: true });
    expect(readComputerUseProducer({ desktopPackageRoot: desktopRoot })).toMatchObject({
      installed: true,
      placeholder: true,
    });
    expect(isRealComputerUseProducerInstalled({ desktopPackageRoot: desktopRoot })).toBe(false);
  });

  it("未安装任何 producer 时不算真实 producer", async () => {
    const desktopRoot = createWorkspace(null);
    // 修复依据：项目内夹具的父级含主仓依赖，未安装场景须独立模拟所有祖先均无 producer。
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:fs")>()),
      existsSync: () => false,
    }));
    try {
      const isolated = await import("../scripts/computer-use-producer.mjs");
      expect(isolated.readComputerUseProducer({ desktopPackageRoot: desktopRoot }).installed).toBe(
        false,
      );
      expect(isolated.isRealComputerUseProducerInstalled({ desktopPackageRoot: desktopRoot })).toBe(
        false,
      );
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("占位包下 dev 插件运行时暂存直接跳过，不要求 sharp 与插件清单", () => {
    const desktopRoot = createWorkspace({ name: "@zcode/zcode-cua", zcodeCuaPlaceholder: true });
    expect(
      stageDevCuaPluginRuntime({
        env: { ZCODE_CUA_DEV_MODE: "1" },
        desktopPackageRoot: desktopRoot,
        pluginRoot: join(desktopRoot, "missing-plugin"),
      }),
    ).toEqual([]);
  });
});
