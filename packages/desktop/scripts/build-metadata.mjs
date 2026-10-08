import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const moduleDir = import.meta.dirname;

function findPackageDir(packageName, startDirs) {
  for (const startDir of startDirs) {
    let currentDir = resolve(startDir);

    while (true) {
      const packageJsonPath = resolve(currentDir, "package.json");
      if (existsSync(packageJsonPath)) {
        try {
          const packageJson = readJson(packageJsonPath);
          if (packageJson.name === packageName) {
            return currentDir;
          }
        } catch {
          // ignore invalid package.json and continue walking up
        }
      }

      const parentDir = resolve(currentDir, "..");
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }
  }

  throw new Error(`Unable to find package directory for ${packageName}`);
}

const desktopDir = findPackageDir("@zcode/desktop", [
  moduleDir,
  resolve(moduleDir, ".."),
  process.cwd(),
]);
const workspaceDir = resolve(desktopDir, "../..");
const metadataDir = resolve(desktopDir, "out/metadata");
const metadataPath = resolve(metadataDir, "build-meta.json");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function normalizeVersion(version) {
  if (typeof version !== "string" || version.length === 0) {
    return "unknown";
  }

  const normalized = version.replace(/^[^\d]*/, "");
  return normalized || version;
}

// 上游基线只承担"基于哪个上游版本"的信息位，只在同步上游发布时手改根 package.json 的 version。
const UPSTREAM_BASELINE_PATTERN = /^\d+\.\d+\.\d+$/;
const NUMERIC_PATTERN = /^\d+$/;

/**
 * 滚动版本串：`<上游基线>-<YYYYMMDD>.<commitCount>`，例 `3.14.3-20261008.1234`。
 *
 * 单调性全部由破折号后的 prerelease 段承担：日期段在前、commitCount 在后，semver 对点分的
 * 数字标识按数值逐段比较，跨天与同天多次构建都单调。日期与序号必须放在 `-` 之后的
 * prerelease 段：semver 优先级比较完全忽略 `+` build metadata，放那里 updater 看不见变化。
 */
export function formatRollingAppVersion(baseline, buildDate, commitCount) {
  return `${baseline}-${buildDate}.${commitCount}`;
}

function resolveUpstreamBaseline(version) {
  const normalized = normalizeVersion(version);
  // electron-updater 的 AppUpdater 构造函数同步解析 app.getVersion()，非法 semver 直接抛
  // ERR_UPDATER_INVALID_VERSION。基线不是 x.y.z 时退到 0.0.0，保证版本串永远 semver 合法。
  return UPSTREAM_BASELINE_PATTERN.test(normalized) ? normalized : "0.0.0";
}

function resolveUtcBuildDate(now = new Date()) {
  return now.toISOString().slice(0, 10).replace(/-/g, "");
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
      return output;
    }
  } catch {
    // 非 git 检出（源码 tar 包等）时走环境变量回退
  }

  const fromEnv = process.env.ZCODE_COMMIT_COUNT?.trim();
  return fromEnv && NUMERIC_PATTERN.test(fromEnv) ? fromEnv : "0";
}

/**
 * 发布序号只服务 About 展示（官方构建显示"构建 #N"），由 CI 注入。
 * 禁止进入版本串：它与 commitCount 不是同一套序列，混入会让自建构建（count 数千）
 * 永远判新于官方构建（序号数百），官方更新推不到自建用户手上。
 */
function resolveReleaseBuildNumber() {
  const raw = process.env.ZCODE_RELEASE_BUILD_NUMBER?.trim();
  if (!raw || !NUMERIC_PATTERN.test(raw)) {
    return null;
  }

  return Number(raw);
}

function resolveInstalledPackageVersion(packageName, fallbackVersion) {
  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`, { paths: [desktopDir] });
    return normalizeVersion(readJson(packageJsonPath).version);
  } catch {
    return normalizeVersion(fallbackVersion);
  }
}

function resolveCommitId() {
  try {
    return execSync("git rev-parse --short=8 HEAD", {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return process.env.ZCODE_COMMIT ?? "unknown";
  }
}

export function collectBuildMetadata() {
  const rootPackageJson = readJson(resolve(workspaceDir, "package.json"));
  const desktopPackageJson = readJson(resolve(desktopDir, "package.json"));
  const upstreamBaseline = resolveUpstreamBaseline(rootPackageJson.version);

  return {
    appVersion: formatRollingAppVersion(
      upstreamBaseline,
      resolveUtcBuildDate(),
      resolveCommitCount(),
    ),
    upstreamBaseline,
    buildCommitId: resolveCommitId(),
    buildTime: new Date().toISOString(),
    releaseBuildNumber: resolveReleaseBuildNumber(),
    electronBuilderVersion: resolveInstalledPackageVersion(
      "electron-builder",
      desktopPackageJson.devDependencies?.["electron-builder"],
    ),
  };
}

export function readBuildMetadata() {
  if (!existsSync(metadataPath)) {
    return null;
  }

  try {
    return readJson(metadataPath);
  } catch {
    return null;
  }
}

export function getBuildMetadata() {
  return readBuildMetadata() ?? collectBuildMetadata();
}

export function writeBuildMetadata() {
  // About 之前分别在 tsup、vite 里各算一份 commit 和时间。
  // 问题原因：两次构建是独立进程，时间点天然不一致；后面再打包时，最终安装包里展示的信息也不一定对应同一次产物。
  // 这里先统一落盘成 build-meta.json，再让构建和运行时都复用同一份数据，保证 about 可追溯。
  const metadata = collectBuildMetadata();
  mkdirSync(metadataDir, { recursive: true });
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");
  return metadata;
}

export function getBuildMetadataPath() {
  return metadataPath;
}

const entryFilePath = process.argv[1] ? resolve(process.argv[1]) : null;
const currentFilePath = fileURLToPath(import.meta.url);

if (entryFilePath === currentFilePath) {
  const metadata = writeBuildMetadata();
  process.stdout.write(`[build-meta] wrote ${metadataPath}\n`);
  process.stdout.write(
    `[build-meta] version=${metadata.appVersion} commit=${metadata.buildCommitId} time=${metadata.buildTime}\n`,
  );
}
