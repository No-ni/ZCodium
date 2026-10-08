import semver from "semver";
import { afterEach, describe, expect, it } from "vitest";
import { collectBuildMetadata, formatRollingAppVersion } from "./build-metadata.mjs";

const RELEASE_BUILD_NUMBER_ENV = "ZCODE_RELEASE_BUILD_NUMBER";
const originalReleaseBuildNumber = process.env[RELEASE_BUILD_NUMBER_ENV];

afterEach(() => {
  if (originalReleaseBuildNumber === undefined) {
    delete process.env[RELEASE_BUILD_NUMBER_ENV];
  } else {
    process.env[RELEASE_BUILD_NUMBER_ENV] = originalReleaseBuildNumber;
  }
});

describe("formatRollingAppVersion", () => {
  it("按 <上游基线>-<YYYYMMDD>.<commitCount> 拼装", () => {
    expect(formatRollingAppVersion("3.14.3", "20261008", 1234)).toBe("3.14.3-20261008.1234");
  });

  // 单调性是滚动更新的地基：跨天与同天多次构建都必须判新，否则 updater 不推更新。
  it("prerelease 段保证跨天与同天多次构建均单调递增", () => {
    const previousDay = formatRollingAppVersion("3.14.3", "20261008", 9);
    const nextDay = formatRollingAppVersion("3.14.3", "20261009", 1);
    const sameDayLater = formatRollingAppVersion("3.14.3", "20261008", 10);
    expect(semver.gt(nextDay, previousDay)).toBe(true);
    expect(semver.gt(sameDayLater, previousDay)).toBe(true);
    expect(semver.gt(nextDay, sameDayLater)).toBe(true);
  });

  it("上游基线 bump 后大于 bump 前的全部构建", () => {
    const beforeSync = formatRollingAppVersion("3.14.3", "20261009", 4321);
    const afterSync = formatRollingAppVersion("3.15.0", "20261008", 1);
    expect(semver.gt(afterSync, beforeSync)).toBe(true);
  });
});

describe("collectBuildMetadata", () => {
  it("版本串 semver 合法，electron-updater 的 AppUpdater 构造可直接解析", () => {
    const metadata = collectBuildMetadata();
    expect(metadata.appVersion).toMatch(/^\d+\.\d+\.\d+-\d{8}\.\d+$/);
    expect(semver.valid(metadata.appVersion)).toBe(metadata.appVersion);
    expect(metadata.upstreamBaseline).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("未注入发布序号时 releaseBuildNumber 为 null（自建构建）", () => {
    delete process.env[RELEASE_BUILD_NUMBER_ENV];
    expect(collectBuildMetadata().releaseBuildNumber).toBeNull();
  });

  it("CI 注入发布序号时解析为数字", () => {
    process.env[RELEASE_BUILD_NUMBER_ENV] = "4382";
    expect(collectBuildMetadata().releaseBuildNumber).toBe(4382);
  });

  it("发布序号非法时按未注入处理，不污染构建", () => {
    process.env[RELEASE_BUILD_NUMBER_ENV] = "not-a-number";
    expect(collectBuildMetadata().releaseBuildNumber).toBeNull();
  });
});
