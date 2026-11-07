import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const root = resolve(import.meta.dirname, "../..");
const paths = {
  adapter: "packages/desktop/src/renderer/src/desktopBrowserPlatformBridge.ts",
  preload: "packages/desktop/src/preload/index.ts",
  channels: "packages/shared/src/channels.ts",
};
const parsed = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([name, path]) => [
  name,
  ts.createSourceFile(path, await readFile(resolve(root, path), "utf8"), ts.ScriptTarget.Latest, true),
])));

function variableInitializer(source, name) {
  const declarations = source.statements.filter(ts.isVariableStatement)
    .flatMap((statement) => Array.from(statement.declarationList.declarations))
    .filter((declaration) => declaration.name.getText(source) === name);
  assert.equal(declarations.length, 1, `实际源码必须只有一个 ${name} 定义`);
  assert.ok(declarations[0].initializer);
  return declarations[0].initializer;
}

function evaluate(expression, context) {
  const compiled = ts.transpileModule(`const actual = ${expression}; actual;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return runInNewContext(compiled, context, { timeout: 1000 });
}

function createAdapter(zcode) {
  // 执行现有对象本身；仅替换平台副作用，不能复制委托逻辑掩盖缺能力。
  return evaluate(variableInitializer(parsed.adapter, "desktopBrowserPlatformBridge").getText(parsed.adapter), {
    window: { zcode },
    Promise,
  });
}

function createPreloadMethod(name, ipcRenderer) {
  const objects = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(parsed.preload) === "contextBridge.exposeInMainWorld"
      && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "zcode"
      && ts.isObjectLiteralExpression(node.arguments[1])) objects.push(node.arguments[1]);
    ts.forEachChild(node, visit);
  }
  visit(parsed.preload);
  assert.equal(objects.length, 1, "宿主 preload 必须沿用唯一 zcode 平台桥");
  const methods = objects[0].properties.filter((property) => property.name?.getText(parsed.preload) === name);
  assert.equal(methods.length, 1, `实际宿主 preload 缺少唯一权限方法 ${name}`);
  const PlatformChannels = evaluate(variableInitializer(parsed.channels, "PlatformChannels").getText(parsed.channels), {});
  return evaluate(`{ ${methods[0].getText(parsed.preload)} }`, { ipcRenderer, PlatformChannels });
}

function wire(name, ipcRenderer) {
  const preload = createPreloadMethod(name, ipcRenderer);
  const adapter = createAdapter(preload);
  assert.equal(typeof adapter[name], "function", `实际 desktop adapter 必须暴露 ${name}`);
  return adapter[name];
}

const origin = "http://127.0.0.1:43123";
const snapshot = Object.freeze({ [origin]: Object.freeze({ geolocation: "allow" }) });
const dataOperations = [
  ["getEmbeddedBrowserSitePermissions", "zcode:get-embedded-browser-site-permissions", []],
  ["setEmbeddedBrowserSitePermission", "zcode:set-embedded-browser-site-permission", [
    Object.freeze({ origin, permission: "geolocation", state: "allow" }),
  ]],
  ["clearEmbeddedBrowserSitePermissions", "zcode:clear-embedded-browser-site-permissions", []],
  ["resetEmbeddedBrowserSitePermission", "zcode:reset-embedded-browser-site-permission", [Object.freeze({ origin })]],
];

for (const [name, channel, args] of dataOperations) {
  test(`${name} 实际 adapter/preload 委托唯一 channel，保留快照及 Promise 拒绝`, async () => {
    const calls = [];
    const result = Promise.resolve(snapshot);
    const execute = wire(name, {
      invoke: (...input) => { calls.push(input); return result; },
    });
    const returned = execute(...args);
    assert.equal(returned, result, "adapter 与 preload 不得缓存或重建授权 Promise");
    assert.equal(await returned, snapshot);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], channel);
    assert.equal(calls[0].length, args.length + 1);
    for (let index = 0; index < args.length; index++) assert.equal(calls[0][index + 1], args[index]);

    const failure = new Error("synthetic permission IPC rejection");
    const reject = wire(name, { invoke: () => Promise.reject(failure) });
    await assert.rejects(() => reject(...args), (error) => error === failure);
  });
}

test("权限 prompt 从实际 preload 进入 adapter 订阅，并注销同一 listener", () => {
  const calls = [];
  const removals = [];
  const subscribe = wire("onEmbeddedBrowserPermissionPrompt", {
    on: (channel, listener) => calls.push({ channel, listener }),
    removeListener: (channel, listener) => removals.push({ channel, listener }),
  });
  const events = [];
  const dispose = subscribe((event) => events.push(event));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, "zcode:embedded-browser-permission-prompt");
  const event = Object.freeze({ requestId: "synthetic-request", kind: "permission", origin, permission: "notifications", guestWebContentsId: 42 });
  calls[0].listener(Object.freeze({ sender: "synthetic-main" }), event);
  assert.deepEqual(events, [event], "只转交权限载荷，不暴露 Electron event");
  assert.equal(typeof dispose, "function");
  dispose();
  assert.equal(removals.length, 1);
  assert.equal(removals[0].channel, calls[0].channel);
  assert.equal(removals[0].listener, calls[0].listener);
});

test("权限 resolve 沿实际 adapter/preload send 回传原请求，不改成 invoke", () => {
  const calls = [];
  const execute = wire("resolveEmbeddedBrowserPermissionPrompt", {
    send: (...args) => calls.push(args),
    invoke: () => assert.fail("Main resolve 使用 listener，不能调用 invoke"),
  });
  const request = Object.freeze({ requestId: "synthetic-request", resolution: Object.freeze({ action: "dismiss" }) });
  execute(request);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "zcode:embedded-browser-permission-resolve");
  assert.equal(calls[0].length, 2);
  assert.equal(calls[0][1], request);
});

const names = [...dataOperations.map(([name]) => name), "onEmbeddedBrowserPermissionPrompt", "resolveEmbeddedBrowserPermissionPrompt"];

test("旧 preload 缺六能力时实际 adapter 保持 undefined，不伪造支持或成功", () => {
  const adapter = createAdapter({});
  for (const name of names) assert.equal(adapter[name], undefined, name);
});

test("旧 preload 只提供读取时能力逐项保留，设置与气泡不能被兜底启用", async () => {
  const result = Promise.resolve(snapshot);
  const adapter = createAdapter({ getEmbeddedBrowserSitePermissions: () => result });
  assert.equal(typeof adapter.getEmbeddedBrowserSitePermissions, "function");
  assert.equal(adapter.getEmbeddedBrowserSitePermissions(), result);
  assert.equal(await adapter.getEmbeddedBrowserSitePermissions(), snapshot);
  for (const name of names.filter((name) => name !== "getEmbeddedBrowserSitePermissions")) {
    assert.equal(adapter[name], undefined, name);
  }
});
