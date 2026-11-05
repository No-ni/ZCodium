import assert from "node:assert/strict";
import { after, test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertProjectPath,
  createProjectTestSandbox,
  projectRoot,
} from "../project-test-sandbox.mjs";

const sandbox = await createProjectTestSandbox("provider-model-catalog-dom");
const previousEnvironment = { ...process.env };
for (const key of Object.keys(process.env)) if (!(key in sandbox.env)) delete process.env[key];
Object.assign(process.env, sandbox.env, { NODE_ENV: "test" });
// 主测试保留 node:test 身份；sandbox.env 仍不把它传给夹具子进程，避免另起 reporter 漏计测试。
if (previousEnvironment.NODE_TEST_CONTEXT)
  process.env.NODE_TEST_CONTEXT = previousEnvironment.NODE_TEST_CONTEXT;
const [{ JSDOM }, { build, stop }] = await Promise.all([import("jsdom"), import("esbuild")]);
// DOM、存储和 Provider 都是项目内合成夹具；加载真实组件，不启动 Host/Agent 或模型网络请求。
const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: "http://catalog-fixture.invalid/",
  pretendToBeVisual: true,
});
const globalKeys = [
  "window",
  "document",
  "navigator",
  "location",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "Event",
  "MouseEvent",
  "CustomEvent",
  "MutationObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "IS_REACT_ACT_ENVIRONMENT",
];
const previousGlobals = new Map(
  globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const key of globalKeys) {
  const value =
    key === "IS_REACT_ACT_ENVIRONMENT"
      ? true
      : ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(key)
        ? dom.window[key].bind(dom.window)
        : dom.window[key];
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act } = await import("react");
const bundlePath = await assertProjectPath(join(sandbox.root, "catalog-fixture.mjs"));
const { outputFiles } = await build({
  entryPoints: [join(import.meta.dirname, "provider-model-catalog.jsx")],
  outfile: bundlePath,
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  alias: { "@": join(projectRoot, "packages/ui/src") },
  external: ["react", "react/*", "react-dom", "react-dom/*"],
  define: { "process.env.NODE_ENV": '"test"' },
  loader: { ".css": "empty", ".png": "dataurl", ".svg": "dataurl" },
});
stop();
await writeFile(bundlePath, outputFiles[0].contents, { flag: "wx" });

async function unmount() {
  if (window.catalogFixture?.unmount) {
    await act(async () => window.catalogFixture.unmount());
    // Radix 关闭后在下一轮 timer 恢复焦点；完成该清理事件后再撤销 DOM globals。
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  }
  delete window.catalogFixture;
}
after(async () => {
  await unmount();
  dom.window.close();
  stop();
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
  for (const key of Object.keys(process.env))
    if (!(key in previousEnvironment)) delete process.env[key];
  Object.assign(process.env, previousEnvironment);
});

async function mount(locale, mode = "partial") {
  await unmount();
  document.body.innerHTML = '<div id="root"></div>';
  dom.reconfigure({ url: "http://catalog-fixture.invalid/?locale=" + locale + "&mode=" + mode });
  await act(async () => {
    await import(pathToFileURL(bundlePath).href + "?locale=" + locale + "&mode=" + mode);
  });
}
async function click(element) {
  assert.ok(element, "交互目标必须存在于真实组件 DOM");
  await act(async () => {
    element.click();
  });
}
const fetchButton = () =>
  document.querySelector('[data-testid="model-provider-fetch-models-button"]');
const dialog = () => document.querySelector('[role="dialog"]');
const checkbox = (name) => dialog()?.querySelector('[role="checkbox"][aria-label="' + name + '"]');
const confirmButton = (locale) =>
  Array.from(dialog()?.querySelectorAll("button") ?? []).find((button) =>
    button.textContent.startsWith(locale === "zh-CN" ? "添加所选" : "Add selected"),
  );
const cancelButton = (locale) =>
  Array.from(dialog()?.querySelectorAll("button") ?? []).find(
    (button) => button.textContent === (locale === "zh-CN" ? "取消" : "Cancel"),
  );

for (const locale of ["en-US", "zh-CN"]) {
  test("PCAT01/02: " + locale + " 部分成功保留排除项，重试仅失败项，重新打开恢复默认", async () => {
    await mount(locale);
    await click(fetchButton());
    assert.equal(checkbox("catalog-c").getAttribute("aria-checked"), "true");
    await click(checkbox("catalog-c"));
    assert.equal(checkbox("catalog-c").getAttribute("aria-checked"), "false");
    await click(confirmButton(locale));
    assert.equal(
      dialog().querySelector('[role="alert"]').textContent,
      locale === "zh-CN" ? "已添加 1 个模型，1 个失败。" : "Added 1 models, 1 failed.",
    );
    assert.equal(checkbox("catalog-a").disabled, true);
    assert.equal(checkbox("catalog-b").getAttribute("aria-checked"), "true");
    assert.equal(
      checkbox("catalog-c").getAttribute("aria-checked"),
      "false",
      "部分成功不能重新勾选用户排除的模型",
    );
    assert.equal(
      confirmButton(locale).textContent,
      locale === "zh-CN" ? "添加所选（1）" : "Add selected (1)",
    );
    await click(confirmButton(locale));
    assert.equal(dialog(), null);
    assert.deepEqual(
      window.catalogFixture.writes.map((model) => model.modelId),
      ["catalog-a", "catalog-b", "catalog-b"],
    );
    await click(fetchButton());
    assert.equal(checkbox("catalog-a").disabled, true);
    assert.equal(checkbox("catalog-b").disabled, true);
    assert.equal(checkbox("catalog-c").getAttribute("aria-checked"), "true");
    await click(checkbox("catalog-c"));
    await click(cancelButton(locale));
    assert.equal(dialog(), null);
    await click(fetchButton());
    assert.equal(checkbox("catalog-c").getAttribute("aria-checked"), "true");
  });

  test("PCAT04: " + locale + " 真实弹窗不展示目录抛错原文", async () => {
    await mount(locale, "fetch-error");
    await click(fetchButton());
    assert.equal(
      dialog().querySelector('[role="alert"]').textContent,
      locale === "zh-CN"
        ? "获取模型列表失败：接口请求失败"
        : "Failed to fetch models: The endpoint request failed",
    );
    assert.equal(document.body.textContent.includes("SYNTHETIC_CATALOG_PRIVATE_MARKER"), false);
  });
}
