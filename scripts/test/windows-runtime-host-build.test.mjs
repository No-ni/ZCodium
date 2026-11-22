import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRuntimeHostBuild, verifyRuntimeHostPe } from "../build-windows-runtime-host.mjs";
import { resolveNativeWindowsBuildConfig } from "../native-search-tools-windows.mjs";

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
