import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("../../packages/desktop/src/main/index.ts", import.meta.url), "utf8");

test("内置浏览器启动在窗口入口前等待唯一权限装配", async () => {
  const ready = source.slice(source.indexOf("app.whenReady().then(async () => {"));
  const start = ready.indexOf("const embeddedBrowserPermissionBridge =");
  assert.notEqual(start, -1, "Main 缺少既有权限 bridge 的启动装配");
  const end = ready.indexOf("await hydratePendingPostUpdateReleaseNotes", start);
  assert.ok(end > start);
  const setup = ready.slice(start, end);
  assert.equal((source.match(/await applyEmbeddedBrowserPermissionPolicy\(/g) ?? []).length, 1);
  assert.ok(start > ready.indexOf("await applyDesktopChromiumNetworkPolicies"));
  assert.ok(end < ready.indexOf('logger.info("[startup] 创建主窗口")'));
  assert.match(source, /canCreateWindow: \(reason\) => \{\s*if \(!embeddedBrowserPermissionPolicyReady\) return false;/);

  const calls = [];
  let loaded = false;
  let release;
  const load = new Promise((resolve) => { release = resolve; });
  const bridge = {
    registerResolveListener: () => calls.push("resolve-listener"),
    promptPermission: () => {}, devicePicker: () => {}, onDisplayMediaRequest: () => {},
  };
  const run = new (Object.getPrototypeOf(async function () {}).constructor)(
    "createEmbeddedBrowserPermissionUiBridge", "setActiveEmbeddedBrowserPermissionUiBridge",
    "applyEmbeddedBrowserPermissionPolicy", "createEmbeddedBrowserSitePermissionStore",
    "session", "EMBEDDED_BROWSER_PARTITION", "app", "join", "logger",
    `let embeddedBrowserPermissionPolicyReady = false;\n${setup}\nreturn embeddedBrowserPermissionPolicyReady;`,
  );
  const pending = run(
    () => bridge,
    (value) => { assert.equal(value, bridge); calls.push("active-bridge"); },
    async (partition, options) => {
      assert.equal(partition, "partition");
      assert.equal(options.prompt, bridge.promptPermission);
      assert.equal(options.devicePicker, bridge.devicePicker);
      assert.equal(options.onDisplayMediaRequest, bridge.onDisplayMediaRequest);
      assert.equal(options.store, "store");
      calls.push("policy-start");
      await load;
      loaded = true;
      calls.push("handlers-ready");
    },
    (path) => { assert.equal(path, "isolated-user-data/embedded-browser-site-permissions.json"); return "store"; },
    { fromPartition: (name) => { assert.equal(name, "persist:zcode-embedded-browser"); return "partition"; } },
    "persist:zcode-embedded-browser", { getPath: (name) => { assert.equal(name, "userData"); return "isolated-user-data"; } },
    (...parts) => parts.join("/"), { info() {}, warn() {} },
  );
  assert.equal(loaded, false);
  assert.deepEqual(calls, ["resolve-listener", "active-bridge", "policy-start"]);
  release();
  assert.equal(await pending, true);
  assert.deepEqual(calls, ["resolve-listener", "active-bridge", "policy-start", "handlers-ready"]);
});
