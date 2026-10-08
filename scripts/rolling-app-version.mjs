import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ZCodium Exp. 滚动版本串的唯一派生实现（无发版版号，学 Arch）。
 *
 * 规则（.agents/specs/rolling-update.md）：
 * - 版本串 = `<上游基线>-<YYYYMMDD>.<commitCount>`，例 `3.14.3-20261008.1234`；
 * - 上游基线只升不降，仅同步上游时手改根 package.json 的 version；
 * - 日期段取 commit 的 committer date（UTC），commitCount 取 `git rev-list --count HEAD`：
 *   版本串是 commit 的纯函数，同一 commit 在任意时间、任意 CI job 派生结果一致。
 *   electron-builder beforePack 的 bundled-remote manifest 相等校验、desktop-release collect
 *   的产物名匹配、mock-cdn releases 目录名都依赖这一点；
 * - 单调性全部由破折号后的 prerelease 段承担；`+` build metadata 被 semver 优先级忽略，禁用；
 * - 浅克隆里 rev-list 只见 graft 出的少量 commit，count 不是全史序号，同一天不同 commit 会
 *   撞号；CI 必须 fetch-depth: 0，这里显式告警，不静默产出撞号版本。
 *
 * 本文件位于仓库根 scripts/，桌面、server、web 的构建配置都经此读取，不存在第二条版本来源。
 */

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceDir = resolve(scriptDir, "..");

const UPSTREAM_BASELINE_PATTERN = /^\d+\.\d+\.\d+$/;
const NUMERIC_PATTERN = /^\d+$/;

/** 滚动版本串：`<上游基线>-<YYYYMMDD>.<commitCount>`。 */
export function formatRollingAppVersion(baseline, buildDate, commitCount) {
  return `${baseline}-${buildDate}.${commitCount}`;
}

function normalizeVersion(version) {
  if (typeof version !== "string" || version.length === 0) {
    return "unknown";
  }

  const normalized = version.replace(/^[^\d]*/, "");
  return normalized || version;
}

function resolveUpstreamBaseline() {
  const rootPackageJson = JSON.parse(readFileSync(resolve(workspaceDir, "package.json"), "utf-8"));
  const normalized = normalizeVersion(rootPackageJson.version);
  // electron-updater 的 AppUpdater 构造函数同步解析 app.getVersion()，非法 semver 直接抛
  // ERR_UPDATER_INVALID_VERSION。基线不是 x.y.z 时退到 0.0.0，保证版本串永远 semver 合法。
  return UPSTREAM_BASELINE_PATTERN.test(normalized) ? normalized : "0.0.0";
}

function resolveUtcBuildDate(now = new Date()) {
  return now.toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * 日期段取 commit 的 committer date（UTC），不取构建时刻：同一 commit 在任意时间、任意 CI job
 * （remote-assets / build / collect）派生出的版本串必须一致；跨 UTC 日的两次构建也不能漂移。
 */
function resolveCommitBuildDate() {
  try {
    const commitDate = execSync("git log -1 --format=%cI", {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    const utcDate = new Date(commitDate).toISOString().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(utcDate)) {
      return utcDate.replace(/-/g, "");
    }
  } catch {
    // 非 git 检出（源码 tar 包等）时回退构建日
  }

  return resolveUtcBuildDate();
}

function isShallowRepository() {
  try {
    return (
      execSync("git rev-parse --is-shallow-repository", {
        cwd: workspaceDir,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim() === "true"
    );
  } catch {
    return false;
  }
}

function resolveCommitCount() {
  try {
    const output = execSync("git rev-list --count HEAD", {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (NUMERIC_PATTERN.test(output)) {
      if (isShallowRepository()) {
        // 浅克隆（actions/checkout 默认 depth=1）里 rev-list 只见 graft 出来的少量 commit，
        // count 不是全史序号：同一天不同 commit 会派生相同版本串，updater 漏推更新。
        // CI 必须 fetch-depth: 0；这里显式告警，避免静默产出撞号版本。
        console.warn(
          `[rolling-version] shallow checkout: commitCount=${output} is not the full history count; CI must use fetch-depth: 0`,
        );
      }
      return output;
    }
  } catch {
    // 非 git 检出（源码 tar 包等）时走环境变量回退
  }

  const fromEnv = process.env.ZCODE_COMMIT_COUNT?.trim();
  return fromEnv && NUMERIC_PATTERN.test(fromEnv) ? fromEnv : "0";
}

/** 桌面 / server / web 构建配置的统一入口：一次取出滚动版本串与上游基线。 */
export function collectRollingAppVersion() {
  const upstreamBaseline = resolveUpstreamBaseline();
  return {
    appVersion: formatRollingAppVersion(
      upstreamBaseline,
      resolveCommitBuildDate(),
      resolveCommitCount(),
    ),
    upstreamBaseline,
  };
}
