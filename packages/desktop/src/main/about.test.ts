import { describe, expect, it } from "vitest";
import {
  createAboutSnapshot,
  formatAboutBuildValue,
  formatAboutDetail,
  resolveAboutApplicationName,
} from "./about.js";

describe("formatAboutBuildValue", () => {
  it("官方发布构建展示日期与发布序号", () => {
    expect(
      formatAboutBuildValue({
        buildTime: "2026-10-08T04:12:33.000Z",
        buildCommitId: "a1b2c3d4",
        releaseBuildNumber: 4382,
      }),
    ).toBe("2026-10-08 · #4382");
  });

  it("自建构建没有发布序号，展示短 commit id", () => {
    expect(
      formatAboutBuildValue({
        buildTime: "2026-10-08T04:12:33.000Z",
        buildCommitId: "a1b2c3d4",
        releaseBuildNumber: null,
      }),
    ).toBe("2026-10-08 · a1b2c3d4");
  });

  it("buildTime 缺格式时段降级为 unknown，不抛错", () => {
    expect(
      formatAboutBuildValue({
        buildTime: "unknown",
        buildCommitId: "a1b2c3d4",
        releaseBuildNumber: null,
      }),
    ).toBe("unknown · a1b2c3d4");
  });
});

describe("resolveAboutApplicationName", () => {
  it("取运行时应用名：正式包 ZCodium Exp、Preview 包 ZCodium Rust", () => {
    expect(resolveAboutApplicationName("ZCodium Exp")).toBe("ZCodium Exp");
    expect(resolveAboutApplicationName("ZCodium Rust")).toBe("ZCodium Rust");
  });

  it("空名回退，避免 About 出现空白产品名", () => {
    expect(resolveAboutApplicationName(undefined)).toBe("ZCodium Exp");
    expect(resolveAboutApplicationName("   ")).toBe("ZCodium Exp");
  });
});

describe("createAboutSnapshot", () => {
  it("releaseBuildNumber 来自 build-meta.json，缺省为 null", () => {
    const withNumber = createAboutSnapshot({
      buildMetadata: { releaseBuildNumber: 4382 },
    });
    expect(withNumber.releaseBuildNumber).toBe(4382);

    const withoutNumber = createAboutSnapshot({
      buildMetadata: { releaseBuildNumber: undefined },
    });
    expect(withoutNumber.releaseBuildNumber).toBeNull();
  });
});

describe("formatAboutDetail", () => {
  it("展示构建信息，不出现内部版本串", () => {
    const snapshot = createAboutSnapshot({
      appVersion: "3.14.3-20261008.1234",
      buildMetadata: {
        appVersion: "3.14.3-20261008.1234",
        buildCommitId: "a1b2c3d4",
        buildTime: "2026-10-08T04:12:33.000Z",
        releaseBuildNumber: 4382,
      },
    });
    const detail = formatAboutDetail(snapshot);
    expect(detail.startsWith("Build: 2026-10-08 · #4382")).toBe(true);
    // 详情块里 OS Version 行合法，只禁内部版本串与"版本"行
    expect(detail).not.toContain("\nVersion:");
    expect(detail).not.toContain("3.14.3-20261008.1234");
  });
});
