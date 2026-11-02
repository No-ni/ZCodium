import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const isWindows = process.platform === "win32";
const tempDirs: string[] = [];
const TEST_FILE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_FILE_DIR, "../../..");

// 沙箱验证必须能把写入范围收在项目内：给出 ZCODE_TEST_TMP_DIR 时优先使用它。
const tempRoot = process.env.ZCODE_TEST_TMP_DIR?.trim() || tmpdir();

function makeTempDir(prefix: string) {
  mkdirSync(tempRoot, { recursive: true });
  const dir = mkdtempSync(join(tempRoot, prefix));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(filePath: string, content: string) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o755 });
}

function writeFakeMachOExecutable(filePath: string) {
  mkdirSync(dirname(filePath), { recursive: true });
  const buffer = Buffer.alloc(32);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  writeFileSync(filePath, buffer, { mode: 0o755 });
}

function writeFakeTool(binDir: string, toolName: "codesign" | "spctl" | "xcrun", logPath: string) {
  writeExecutable(
    join(binDir, toolName),
    `#!/bin/bash
set -euo pipefail
printf '${toolName}' >> "${logPath}"
for arg in "$@"; do
  printf '\\t%s' "$arg" >> "${logPath}"
done
printf '\\n' >> "${logPath}"
if [[ "${toolName}" == "codesign" && "\${ZCODE_FAKE_CODESIGN_FAIL:-0}" == "1" ]]; then
  echo "fake codesign rejection" >&2
  exit 7
fi
if [[ "${toolName}" == "spctl" && "\${ZCODE_FAKE_SPTCL_FAIL:-0}" == "1" ]]; then
  echo "fake gatekeeper rejection" >&2
  exit 9
fi
if [[ "${toolName}" == "xcrun" && "\${ZCODE_FAKE_STAPLER_FAIL:-0}" == "1" ]]; then
  echo "fake stapler rejection" >&2
  exit 8
fi
`,
  );
}

function createReleaseApp(rootDir: string, productName = "ZCodium") {
  const appPath = join(rootDir, `${productName}.app`);

  writeFakeMachOExecutable(join(appPath, "Contents", "MacOS", productName));

  return { appPath };
}

function runDoctor(appPath: string, binDir: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return execFileSync("bash", ["scripts/doctor-macos-release-app.sh", appPath], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ZCODE_ENV: "production",
      ...extraEnv,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
    encoding: "utf-8",
    stdio: "pipe",
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(isWindows)("doctor-macos-release-app.sh", () => {
  it("Preview 身份自动按 bundle 名推导主可执行", () => {
    const workspaceDir = makeTempDir("zcodium-macos-preview-doctor-");
    const binDir = join(workspaceDir, "bin");
    const toolLog = join(workspaceDir, "tool.log");
    const { appPath } = createReleaseApp(workspaceDir, "ZCodium Preview");
    const zcodeHome = join(workspaceDir, ".zcodium");

    mkdirSync(binDir, { recursive: true });
    writeFakeTool(binDir, "codesign", toolLog);
    writeFakeTool(binDir, "spctl", toolLog);

    const output = runDoctor(appPath, binDir, {
      ZCODE_HOME: zcodeHome,
    });

    expect(output).toContain(`validating ZCodium Preview.app: ${appPath}`);
    const log = readFileSync(toolLog, "utf-8");
    expect(log).toContain(`codesign\t--verify\t--deep\t--strict\t${appPath}`);
    expect(log).toContain(`spctl\t-a\t-vv\t-t\texec\t${appPath}`);
  });

  it("默认只验收安装后的产品 app，不验收官方 Helper", () => {
    const workspaceDir = makeTempDir("zcodium-macos-release-doctor-");
    const binDir = join(workspaceDir, "bin");
    const toolLog = join(workspaceDir, "tool.log");
    const { appPath } = createReleaseApp(workspaceDir);
    const zcodeHome = join(workspaceDir, ".zcodium");

    mkdirSync(binDir, { recursive: true });
    writeFakeTool(binDir, "codesign", toolLog);
    writeFakeTool(binDir, "spctl", toolLog);

    const output = runDoctor(appPath, binDir, { ZCODE_HOME: zcodeHome });

    expect(output).toContain("[macos-release-doctor] done");
    expect(output).toContain(`product data root: ${zcodeHome}`);
    const log = readFileSync(toolLog, "utf-8");
    expect(log).toContain(`codesign\t--verify\t--deep\t--strict\t${appPath}`);
    expect(log).toContain(`spctl\t-a\t-vv\t-t\texec\t${appPath}`);
    // 本 fork 保留旧电脑操作后端：doctor 不能再拉起官方独立 Helper 验收，也不该为此要求 xcrun。
    expect(log).not.toContain("xcrun");
    expect(output).not.toMatch(/Computer Use Helper/);
  });

  it("显式开启票据验收时对最终 app 做本地 staple 检查", () => {
    const workspaceDir = makeTempDir("zcodium-macos-release-doctor-staple-");
    const binDir = join(workspaceDir, "bin");
    const toolLog = join(workspaceDir, "tool.log");
    const { appPath } = createReleaseApp(workspaceDir);
    const zcodeHome = join(workspaceDir, ".zcodium");

    mkdirSync(binDir, { recursive: true });
    writeFakeTool(binDir, "codesign", toolLog);
    writeFakeTool(binDir, "spctl", toolLog);
    writeFakeTool(binDir, "xcrun", toolLog);

    const output = runDoctor(appPath, binDir, {
      ZCODE_HOME: zcodeHome,
      ZCODE_MACOS_REQUIRE_STAPLE: "1",
    });

    expect(output).toContain("[macos-release-doctor] done");
    const log = readFileSync(toolLog, "utf-8");
    expect(log).toContain(`xcrun\tstapler\tvalidate\t${appPath}`);
  });

  it("staple 无效时应 fail-closed", () => {
    const workspaceDir = makeTempDir("zcodium-macos-release-doctor-stapler-fail-");
    const binDir = join(workspaceDir, "bin");
    const toolLog = join(workspaceDir, "tool.log");
    const { appPath } = createReleaseApp(workspaceDir);
    const zcodeHome = join(workspaceDir, ".zcodium");

    mkdirSync(binDir, { recursive: true });
    writeFakeTool(binDir, "codesign", toolLog);
    writeFakeTool(binDir, "spctl", toolLog);
    writeFakeTool(binDir, "xcrun", toolLog);

    expect(() =>
      runDoctor(appPath, binDir, {
        ZCODE_HOME: zcodeHome,
        ZCODE_MACOS_REQUIRE_STAPLE: "1",
        ZCODE_FAKE_STAPLER_FAIL: "1",
      }),
    ).toThrow(/fake stapler rejection/);
  });

  it("缺少安装后的 app 时应 fail-closed", () => {
    const workspaceDir = makeTempDir("zcodium-macos-release-doctor-missing-app-");
    const binDir = join(workspaceDir, "bin");
    const toolLog = join(workspaceDir, "tool.log");
    const zcodeHome = join(workspaceDir, ".zcodium");
    const appPath = join(workspaceDir, "ZCodium.app");

    mkdirSync(binDir, { recursive: true });
    writeFakeTool(binDir, "codesign", toolLog);
    writeFakeTool(binDir, "spctl", toolLog);

    expect(() => runDoctor(appPath, binDir, { ZCODE_HOME: zcodeHome })).toThrow(
      /ZCodium\.app missing/,
    );
  });

  it("没有 ZCODE_HOME/HOME 时应 fail-closed", () => {
    const workspaceDir = makeTempDir("zcodium-macos-release-doctor-no-home-");
    const binDir = join(workspaceDir, "bin");
    const toolLog = join(workspaceDir, "tool.log");
    const { appPath } = createReleaseApp(workspaceDir);

    mkdirSync(binDir, { recursive: true });
    writeFakeTool(binDir, "codesign", toolLog);
    writeFakeTool(binDir, "spctl", toolLog);

    expect(() =>
      runDoctor(appPath, binDir, {
        ZCODE_HOME: "",
        HOME: "",
      }),
    ).toThrow(/data root unresolved/);
  });

  it("数据根回落到官方 .zcode 目录时应 fail-closed", () => {
    const workspaceDir = makeTempDir("zcodium-macos-release-doctor-legacy-root-");
    const binDir = join(workspaceDir, "bin");
    const toolLog = join(workspaceDir, "tool.log");
    const { appPath } = createReleaseApp(workspaceDir);

    mkdirSync(binDir, { recursive: true });
    writeFakeTool(binDir, "codesign", toolLog);
    writeFakeTool(binDir, "spctl", toolLog);

    expect(() => runDoctor(appPath, binDir, { ZCODE_HOME: join(workspaceDir, ".zcode") })).toThrow(
      /not this fork's identity/,
    );
  });

  it("主可执行仍是 shell wrapper 时应 fail-closed", () => {
    const workspaceDir = makeTempDir("zcodium-macos-release-doctor-wrapper-");
    const binDir = join(workspaceDir, "bin");
    const toolLog = join(workspaceDir, "tool.log");
    const { appPath } = createReleaseApp(workspaceDir);
    const zcodeHome = join(workspaceDir, ".zcodium");
    writeExecutable(join(appPath, "Contents", "MacOS", "ZCodium"), "#!/bin/bash\n");

    mkdirSync(binDir, { recursive: true });
    writeFakeTool(binDir, "codesign", toolLog);
    writeFakeTool(binDir, "spctl", toolLog);

    expect(() => runDoctor(appPath, binDir, { ZCODE_HOME: zcodeHome })).toThrow(
      /not a Mach-O executable/,
    );
  });

  it("codesign 失败时不得继续跑 Gatekeeper 判定", () => {
    const workspaceDir = makeTempDir("zcodium-macos-release-doctor-codesign-fail-");
    const binDir = join(workspaceDir, "bin");
    const toolLog = join(workspaceDir, "tool.log");
    const { appPath } = createReleaseApp(workspaceDir);
    const zcodeHome = join(workspaceDir, ".zcodium");

    mkdirSync(binDir, { recursive: true });
    writeFakeTool(binDir, "codesign", toolLog);
    writeFakeTool(binDir, "spctl", toolLog);

    expect(() =>
      runDoctor(appPath, binDir, { ZCODE_HOME: zcodeHome, ZCODE_FAKE_CODESIGN_FAIL: "1" }),
    ).toThrow(/fake codesign rejection/);
    const log = readFileSync(toolLog, "utf-8");
    expect(log).toContain(`codesign\t--verify\t--deep\t--strict\t${appPath}`);
    expect(log).not.toContain("spctl");
  });

  it("Gatekeeper 判定失败时应 fail-closed", () => {
    const workspaceDir = makeTempDir("zcodium-macos-release-doctor-gatekeeper-fail-");
    const binDir = join(workspaceDir, "bin");
    const toolLog = join(workspaceDir, "tool.log");
    const { appPath } = createReleaseApp(workspaceDir);
    const zcodeHome = join(workspaceDir, ".zcodium");

    mkdirSync(binDir, { recursive: true });
    writeFakeTool(binDir, "codesign", toolLog);
    writeFakeTool(binDir, "spctl", toolLog);

    expect(() =>
      runDoctor(appPath, binDir, { ZCODE_HOME: zcodeHome, ZCODE_FAKE_SPTCL_FAIL: "1" }),
    ).toThrow(/fake gatekeeper rejection/);
    const log = readFileSync(toolLog, "utf-8");
    expect(log).toContain(`spctl\t-a\t-vv\t-t\texec\t${appPath}`);
  });
});
