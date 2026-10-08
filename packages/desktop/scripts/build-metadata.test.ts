import semver from "semver";
import { afterEach, describe, expect, it } from "vitest";
import { collectBuildMetadata } from "./build-metadata.mjs";

const RELEASE_BUILD_NUMBER_ENV = "ZCODE_RELEASE_BUILD_NUMBER";
const originalReleaseBuildNumber = process.env[RELEASE_BUILD_NUMBER_ENV];

afterEach(() => {
  if (originalReleaseBuildNumber === undefined) {
    delete process.env[RELEASE_BUILD_NUMBER_ENV];
  } else {
    process.env[RELEASE_BUILD_NUMBER_ENV] = originalReleaseBuildNumber;
  }
});

describe("collectBuildMetadata", () => {
  it("版本串 semver 合法，electron-updater 的 AppUpdater 构造可直接解析", () => {
    const metadata = collectBuildMetadata();
    expect(metadata.appVersion).toMatch(/^\d+\.\d+\.\d+-\d{8}\.\d+$/);
    expect(semver.valid(metadata.appVersion)).toBe(metadata.appVersion);
    expect(metadata.upstreamBaseline).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // 日期段取 commit 的 committer date：同一 commit 在任意时间、任意 CI job 派生结果一致。
  // electron-builder beforePack 校验 bundled-remote manifest 与此相等，collect 按此匹配产物名。
  it("同一 commit 多次收集得到相同版本串", () => {
    expect(collectBuildMetadata().appVersion).toBe(collectBuildMetadata().appVersion);
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
