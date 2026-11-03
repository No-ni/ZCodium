import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

// 修复依据：官方 Linux 发行断言与本 fork 仅 Windows/macOS 的契约冲突，门禁应验证拒绝边界。
describe("electron-builder 桌面发行平台边界", () => {
  it("prerelease 也生成统一的 latest.yml", async () => {
    vi.stubEnv("ZCODE_TARGET_OS", "win32");
    const { default: config } = await import("../electron-builder.config.js");
    expect(config.detectUpdateChannel).toBe(false);
  });

  it.each(["win32", "darwin"])("%s 仅声明 NSIS/DMG，且不携带 Linux 分发配置", async (platform) => {
    vi.stubEnv("ZCODE_TARGET_OS", platform);
    const { default: config } = await import("../electron-builder.config.js");
    expect(config.win?.target).toEqual(["nsis"]);
    expect(config.mac?.target).toEqual(["dmg"]);
    for (const key of ["linux", "appImage", "deb", "rpm", "pacman"]) {
      expect(config).not.toHaveProperty(key);
    }
  });

  it("显式 Linux 目标在配置加载时被拒绝", async () => {
    vi.stubEnv("ZCODE_TARGET_OS", "linux");
    await expect(import("../electron-builder.config.js")).rejects.toThrow(
      "Unsupported desktop target OS: linux",
    );
  });
});
