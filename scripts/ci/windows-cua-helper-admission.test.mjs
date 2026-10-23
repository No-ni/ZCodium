import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { createDefaultCuaProductHelper, shouldEnableDefaultCuaProductHelper } = await tsImport(
  "../../packages/services/src/node.ts",
  import.meta.url,
);

for (const platform of ["win32", "darwin"]) {
  for (const env of [
    {},
    { ZCODE_CUA_PRODUCT_HELPER: "1" },
    { ZCODE_CUA_DEV_MODE: "1" },
    { ZCODE_CUA_DEV_ROOT: "" },
    { ZCODE_CUA_DEV_ROOT: " \t " },
  ]) {
    test(`${platform} 正常启动不解析已移除的旧 Helper ${JSON.stringify(env)}`, () => {
      assert.equal(shouldEnableDefaultCuaProductHelper({ platform, env }), false);
      const helper = createDefaultCuaProductHelper({
        platform,
        env,
        resolveWindowsRuntime: async () => assert.fail("正常启动不得解析旧 Helper runtime"),
        createWindowsHost: () => assert.fail("正常启动不得创建旧 Windows Helper"),
      });
      assert.equal(helper, undefined);
    });
  }
}

test("旧 Helper 仅接受 Windows 显式开发目录，并保留功能关闭边界", () => {
  const env = { ZCODE_CUA_DEV_ROOT: " C:\\fixture\\cua " };
  assert.equal(shouldEnableDefaultCuaProductHelper({ platform: "win32", env }), true);
  for (const platform of ["darwin", "linux"]) {
    assert.equal(shouldEnableDefaultCuaProductHelper({ platform, env }), false);
  }
  for (const disabled of ["0", "false", "off"]) {
    assert.equal(
      shouldEnableDefaultCuaProductHelper({
        platform: "win32",
        env: { ...env, ZCODE_CUA_PRODUCT_HELPER: disabled },
      }),
      false,
    );
  }
});

test("Windows 显式开发 Helper 保留懒解析、宿主复用和 dispose", async () => {
  const calls = [];
  const runtime = { root: "C:\\fixture\\cua" };
  const handle = { socketPath: "fixture-pipe", pluginAuthority: "fixture-authority" };
  const host = {
    async start() {
      calls.push("start");
      return handle;
    },
    async stop() {
      calls.push("stop");
    },
  };
  const helper = createDefaultCuaProductHelper({
    platform: "win32",
    env: { ZCODE_CUA_DEV_ROOT: runtime.root },
    resolveWindowsRuntime: async () => {
      calls.push("resolve");
      return runtime;
    },
    createWindowsHost: (resolved) => {
      assert.equal(resolved, runtime);
      calls.push("create");
      return host;
    },
  });
  assert.ok(helper);
  assert.deepEqual(calls, []);
  assert.equal(await helper.host.start(), handle);
  assert.equal(await helper.host.start(), handle);
  await helper.host.stop();
  assert.deepEqual(calls, ["resolve", "create", "start", "start", "stop"]);
});

test("无效开发目录仍透传原错误，且不回退创建安装包 Helper", async () => {
  let failure;
  const helper = createDefaultCuaProductHelper({
    platform: "win32",
    env: { ZCODE_CUA_DEV_ROOT: "relative-fixture" },
    resourcesPath: "C:/fixture/removed-packaged-helper",
    createWindowsHost: () => assert.fail("解析失败不得创建 Helper"),
  });
  assert.ok(helper);
  await assert.rejects(helper.host.start(), (error) => {
    failure = error;
    assert.equal(error.name, "WindowsCuaDevRuntimeResolutionError");
    assert.equal(error.reason, "development-root-not-absolute");
    return true;
  });
  await assert.rejects(helper.host.start(), (error) => error === failure);
  await helper.host.stop();
});
