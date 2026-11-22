import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRuntimeHostBuild, verifyRuntimeHostPe } from "../build-windows-runtime-host.mjs";
import { resolveNativeWindowsBuildConfig } from "../native-search-tools-windows.mjs";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import {
  createProjectTestSandbox,
  assertProjectPath,
  projectRoot,
} from "../ci/project-test-sandbox.mjs";
import { extractPrebuiltBinary, extractPrebuiltArchive } from "../prebuilt-binary-extract.mjs";

test("Windows builds both supported architectures with the matching MSVC target", () => {
  assert.deepEqual(resolveRuntimeHostBuild("x64", "win32").configureArgs, ["-A", "x64"]);
  assert.deepEqual(resolveRuntimeHostBuild("arm64", "win32").configureArgs, ["-A", "ARM64"]);
  assert.throws(() => resolveRuntimeHostBuild("ia32", "win32"), /architecture/);
});

test("Windows search producer uses the installed generator and preserves explicit VS selections", () => {
  for (const arch of ["x64", "arm64"]) {
    const base = { platform: "win32", hostPlatform: "win32", hostArch: "x64", arch };
    const automatic = resolveNativeWindowsBuildConfig({ ...base, env: {} });
    assert.equal(automatic.generator, undefined);
    assert.equal(automatic.generatorArchitecture, arch === "arm64" ? "ARM64" : "x64");
    for (const generator of ["Visual Studio 17 2022", "Visual Studio 18 2026"]) {
      const explicit = resolveNativeWindowsBuildConfig({
        ...base,
        env: { CMAKE_GENERATOR: generator },
      });
      assert.equal(explicit.generator, generator);
      assert.equal(explicit.generatorArchitecture, automatic.generatorArchitecture);
    }
    assert.equal(
      resolveNativeWindowsBuildConfig({ ...base, env: { CMAKE_GENERATOR: "  " } }).generator,
      undefined,
    );
  }
});

test("显式 Ninja 使用调用方 MSVC 环境，不传入 VS 架构参数且读取单配置输出", () => {
  for (const arch of ["x64", "arm64"]) {
    const plan = resolveRuntimeHostBuild(arch, "win32", undefined, "Ninja");
    assert.deepEqual(plan.configureArgs, ["-G", "Ninja"]);
    assert.equal(plan.outputSubdirectory, "");
    assert.equal(
      resolveRuntimeHostBuild(arch, "win32", undefined, "Visual Studio 18 2026").outputSubdirectory,
      "Release",
    );
    const config = resolveNativeWindowsBuildConfig({
      platform: "win32",
      arch,
      hostPlatform: "win32",
      hostArch: "x64",
      env: { CMAKE_GENERATOR: "Ninja" },
    });
    assert.deepEqual(config.generatorArchitectureArgs, []);
    assert.equal(config.generatorArchitecture, arch === "arm64" ? "ARM64" : "x64");
    const automatic = resolveNativeWindowsBuildConfig({
      platform: "win32",
      arch,
      hostPlatform: "win32",
      hostArch: "x64",
      env: {},
    });
    assert.deepEqual(automatic.generatorArchitectureArgs, ["-A", automatic.generatorArchitecture]);
  }
});
test("cross builds explicitly select a Windows compiler", () => {
  assert.ok(
    resolveRuntimeHostBuild("x64", "linux").configureArgs.includes("-DCMAKE_SYSTEM_NAME=Windows"),
  );
  assert.ok(
    resolveRuntimeHostBuild("arm64", "linux", "example-clang++").configureArgs.includes(
      "-DCMAKE_CXX_COMPILER=example-clang++",
    ),
  );
});
test("packaging rejects wrong-architecture and corrupt PE binaries", () => {
  const bytes = Buffer.alloc(128);
  bytes.write("MZ");
  bytes.writeUInt32LE(64, 60);
  bytes.write("PE\0\0", 64);
  bytes.writeUInt16LE(0x8664, 68);
  verifyRuntimeHostPe(bytes, "x64");
  assert.throws(() => verifyRuntimeHostPe(bytes, "arm64"), /architecture/);
  assert.throws(() => verifyRuntimeHostPe(Buffer.from("bad"), "x64"), /PE/);
});

test("Windows 安装辅助配置首次创建、重复覆盖与架构隔离，缺失程序时拒绝写入", async () => {
  const sandbox = await createProjectTestSandbox("windows-installer-define");
  const source = await readFile(
    join(projectRoot, "packages/desktop/electron-builder.config.js"),
    "utf8",
  );
  const parsed = ts.createSourceFile(
    "builder.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  // 提取真实函数及其原始内置导入，避免顶层打包副作用；漏导入仍会在实际写文件时失败。
  const declarations = parsed.statements.filter(
    (node) =>
      (ts.isImportDeclaration(node) &&
        ["node:fs", "node:fs/promises", "node:path"].includes(node.moduleSpecifier.text)) ||
      (ts.isFunctionDeclaration(node) &&
        ["installerProcessHelperDefineLine", "writeInstallerProcessHelperDefine"].includes(
          node.name?.text,
        )),
  );
  const modulePath = await assertProjectPath(join(sandbox.root, "builder-functions.mjs"));
  await writeFile(
    modulePath,
    declarations.map((node) => node.getText(parsed)).join("\n") +
      `\nconst desktopPackageRoot = ${JSON.stringify(sandbox.root)};\nexport { writeInstallerProcessHelperDefine };\n`,
  );
  const { writeInstallerProcessHelperDefine, installerProcessHelperDefineLine } = await import(
    pathToFileURL(modulePath).href
  );
  for (const arch of ["x64", "arm64"]) {
    const appOutDir = await assertProjectPath(join(sandbox.root, `app $ with space-${arch}`));
    const helperDir = await assertProjectPath(join(appOutDir, "resources/tools/runtime-host"));
    await mkdir(helperDir, { recursive: true });
    await writeFile(join(helperDir, "zcode-installer-process-helper.exe"), "fixture helper");
    await writeInstallerProcessHelperDefine({ appOutDir }, arch);
    const definePath = await assertProjectPath(
      join(sandbox.root, "build/generated", `zcode-process-helper-${arch}.nsh`),
    );
    assert.equal(await readFile(definePath, "utf8"), installerProcessHelperDefineLine(appOutDir));
    await writeFile(definePath, "stale configuration");
    await writeInstallerProcessHelperDefine({ appOutDir }, arch);
    assert.equal(await readFile(definePath, "utf8"), installerProcessHelperDefineLine(appOutDir));
  }
  await assert.rejects(
    writeInstallerProcessHelperDefine({ appOutDir: join(sandbox.root, "missing") }, "missing"),
    /Installer process helper missing/,
  );
  await assert.rejects(
    readFile(join(sandbox.root, "build/generated/zcode-process-helper-missing.nsh")),
    { code: "ENOENT" },
  );
});

test(
  "Windows ZIP 兼容本机 .NET，保留覆盖、带引号路径与目标验证顺序",
  { skip: process.platform !== "win32" },
  async () => {
    const sandbox = await createProjectTestSandbox("windows-zip-regression");
    const archive = await assertProjectPath(join(sandbox.root, "archive ' with space.zip"));
    const output = await assertProjectPath(join(sandbox.root, "binary.exe"));
    const bytes = Buffer.from("fixture binary content");
    const zip = new yazl.ZipFile();
    zip.addBuffer(bytes, "nested/binary.exe");
    zip.end();
    await pipeline(zip.outputStream, createWriteStream(archive, { flags: "wx" }));
    await writeFile(output, "original binary");
    const archiveSha256 = createHash("sha256")
      .update(await readFile(archive))
      .digest("hex");
    await extractPrebuiltBinary({
      archiveExt: "zip",
      archivePath: archive,
      archiveSha256,
      binaryName: "binary.exe",
      binaryPath: output,
      targetPlatform: "win32",
      validateBinary: async (path) => {
        assert.equal(await readFile(output, "utf8"), "original binary");
        assert.deepEqual(await readFile(path), bytes);
      },
    });
    assert.deepEqual(await readFile(output), bytes);
    await assert.rejects(
      extractPrebuiltBinary({
        archiveExt: "zip",
        archivePath: archive,
        archiveSha256,
        binaryName: "binary.exe",
        binaryPath: output,
        targetPlatform: "win32",
        validateBinary: async () => {
          throw new Error("fixture invalid binary");
        },
      }),
      /fixture invalid binary/,
    );
    assert.deepEqual(await readFile(output), bytes);
    const extractDir = await assertProjectPath(join(sandbox.root, "extract"));
    extractPrebuiltArchive({ archiveExt: "zip", archivePath: archive, extractDir });
    await writeFile(join(extractDir, "nested/binary.exe"), "stale extraction");
    extractPrebuiltArchive({ archiveExt: "zip", archivePath: archive, extractDir });
    assert.deepEqual(await readFile(join(extractDir, "nested/binary.exe")), bytes);
    // 恶意 entry 的落点仍在本测试沙箱内，验证边界不会写入项目外目录。
    const traversalArchive = await assertProjectPath(join(sandbox.root, "traversal.zip"));
    const traversalZip = new yazl.ZipFile();
    traversalZip.addBuffer(bytes, "00/binary.exe");
    traversalZip.end();
    const chunks = [];
    for await (const chunk of traversalZip.outputStream) chunks.push(chunk);
    const traversalBytes = Buffer.from(
      Buffer.concat(chunks).toString("latin1").replaceAll("00/binary.exe", "../binary.exe"),
      "latin1",
    );
    await writeFile(traversalArchive, traversalBytes);
    assert.throws(
      () =>
        extractPrebuiltArchive({ archiveExt: "zip", archivePath: traversalArchive, extractDir }),
      /failed with code/,
    );
    assert.deepEqual(await readFile(output), bytes);
  },
);
