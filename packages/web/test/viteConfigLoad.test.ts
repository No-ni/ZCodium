import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfigFromFile, type ConfigEnv, type UserConfig } from "vite";

const WEB_ROOT = resolve(import.meta.dirname, "..");
const CONFIG_FILE = resolve(WEB_ROOT, "vite.config.ts");

type RootPackage = {
  version: string;
  zcodeCompatibility?: { minCompatibleVersion?: string };
};

async function loadWebConfig(env: Pick<ConfigEnv, "command" | "mode">): Promise<UserConfig> {
  const result = await loadConfigFromFile(
    { isPreview: false, isSsrBuild: false, ...env },
    CONFIG_FILE,
    WEB_ROOT,
    "silent",
    undefined,
    "runner",
  );
  if (!result) throw new Error("Vite 未能加载 packages/web/vite.config.ts");
  return result.config;
}

async function readRootPackage(): Promise<RootPackage> {
  const raw = await readFile(resolve(WEB_ROOT, "../../package.json"), "utf8");
  return JSON.parse(raw) as RootPackage;
}

describe("web Vite config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([undefined, "   ", " 3.12.9-beta.1 "])(
    "构建版本使用手动值或 package 默认值：%s",
    async (override) => {
      vi.stubEnv("WEB_REMOTE_FRONTEND_VERSION", override);
      const { version } = await readRootPackage();
      const config = await loadWebConfig({ command: "build", mode: "production" });

      expect(config.define?.__ZCODE_VERSION__).toBe(JSON.stringify(override?.trim() || version));
    },
  );

  it("非法手动版本在构建配置加载时失败", async () => {
    vi.stubEnv("WEB_REMOTE_FRONTEND_VERSION", "../latest");

    await expect(loadWebConfig({ command: "build", mode: "production" })).rejects.toThrow(
      /version/i,
    );
  });

  it("publishes PDF.js CMaps for non-latin PDF rendering", async () => {
    const config = await loadWebConfig({ command: "build", mode: "production" });
    const pluginNames = (config.plugins ?? [])
      .flat()
      .map((plugin) => (plugin as { name?: string })?.name);

    expect(pluginNames).toContain("zcode:pdfjs-cmaps");
  });

  // define 用 toEqual 钉死整组键：产物只带本地构建身份，不向 renderer 注入远端授权变量或官网端点。
  it("生产构建的 define 只有本地版本、最低兼容版本、commit 与环境", async () => {
    vi.stubEnv("WEB_REMOTE_FRONTEND_VERSION", undefined);
    vi.stubEnv("ZCODE_ENV", "production");
    vi.stubEnv("ZCODE_COMMIT", "a1b2c3d");
    const pkg = await readRootPackage();

    const config = await loadWebConfig({ command: "build", mode: "production" });

    expect(config.define).toEqual({
      __ZCODE_VERSION__: JSON.stringify(pkg.version),
      __ZCODE_MIN_COMPATIBLE_VERSION__: JSON.stringify(
        pkg.zcodeCompatibility?.minCompatibleVersion ?? pkg.version,
      ),
      __ZCODE_COMMIT__: JSON.stringify("a1b2c3d"),
      __ZCODE_ENV__: JSON.stringify("production"),
    });
  });

  it.each([
    ["", "test"],
    ["development", "test"],
    ["PRODUCTION", "production"],
    ["  production  ", "production"],
  ] as const)("ZCODE_ENV=%s 时构建身份为 %s", async (value, expected) => {
    vi.stubEnv("ZCODE_ENV", value);

    const config = await loadWebConfig({ command: "build", mode: "production" });

    expect(config.define?.__ZCODE_ENV__).toBe(JSON.stringify(expected));
  });

  it("未提供 ZCODE_COMMIT 时构建身份落 unknown", async () => {
    vi.stubEnv("ZCODE_COMMIT", "");

    const config = await loadWebConfig({ command: "build", mode: "production" });

    expect(config.define?.__ZCODE_COMMIT__).toBe(JSON.stringify("unknown"));
  });

  it("远控只把同源 /ws 与 /api 代理到本地 Server", async () => {
    const config = await loadWebConfig({ command: "serve", mode: "development" });

    expect(config.server?.proxy).toEqual({
      "/ws": { target: "ws://localhost:3030", ws: true },
      "/api": { target: "http://localhost:3030" },
    });
  });

  it("生产构建只产出 Web 工作台与手机远控两个入口", async () => {
    const config = await loadWebConfig({ command: "build", mode: "production" });
    const input = config.build?.rollupOptions?.input as Record<string, string> | undefined;

    expect(Object.keys(input ?? {})).toEqual(["index", "mobile"]);
    expect(input?.index).toBe(resolve(WEB_ROOT, "index.html"));
    expect(input?.mobile).toBe(resolve(WEB_ROOT, "mobile.html"));
  });
});
