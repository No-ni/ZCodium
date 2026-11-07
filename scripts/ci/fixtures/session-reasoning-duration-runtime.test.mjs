import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertProjectPath, projectRoot } from "../project-test-sandbox.mjs";

// 父入口绑定 HOME、缓存、数据与临时目录；真实 React/Radix 组件只访问合成 DOM。
const sandbox = await assertProjectPath(process.env.PROJECT_TEST_SANDBOX_ROOT ?? "");
const [{ JSDOM }, { build, stop }] = await Promise.all([import("jsdom"), import("esbuild")]);
const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: "http://reasoning-fixture.invalid/",
});
const globalKeys = [
  "window",
  "document",
  "navigator",
  "Element",
  "HTMLElement",
  "getComputedStyle",
  "IS_REACT_ACT_ENVIRONMENT",
];
const previousGlobals = new Map(
  globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const key of globalKeys) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value:
      key === "IS_REACT_ACT_ENVIRONMENT"
        ? true
        : key === "getComputedStyle"
          ? dom.window.getComputedStyle.bind(dom.window)
          : dom.window[key],
  });
}
const fixturePath = await assertProjectPath(join(sandbox, "reasoning-ui.mjs"));
const { outputFiles } = await build({
  stdin: {
    contents:
      'export { Reasoning, ReasoningTrigger } from "./packages/ui/src/components/ai-elements/reasoning.tsx";',
    resolveDir: projectRoot,
    loader: "tsx",
  },
  outfile: fixturePath,
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  packages: "external",
  alias: {
    "@": join(projectRoot, "packages/ui/src"),
    "@zcode/shared/test-ids": join(projectRoot, "packages/shared/src/test-ids.ts"),
  },
  external: ["react", "react/*", "react-dom", "react-dom/*"],
  plugins: [
    {
      name: "synthetic-reasoning-intl",
      setup(builder) {
        builder.onResolve({ filter: /^@\/i18n\/IntlProvider\.js$/ }, ({ path }) => ({
          path,
          namespace: "synthetic-intl",
        }));
        builder.onLoad({ filter: /.*/, namespace: "synthetic-intl" }, () => ({
          contents:
            'export const useZCodeIntl = () => ({ intl: { formatMessage: ({ id }, values) => values?.seconds === undefined ? id : `elapsed=${values.seconds}` }, locale: "en-US" });',
          loader: "js",
        }));
      },
    },
  ],
});
stop();
await writeFile(fixturePath, outputFiles[0].contents, { flag: "wx" });
const { Reasoning, ReasoningTrigger } = await import(pathToFileURL(fixturePath).href);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const actualNow = Date.now;
let clock = 100_000;
Date.now = () => clock;
let mountedRoot;
let bodyRenders = 0;

function BodyProbe() {
  bodyRenders++;
  return createElement("div", { "data-reasoning-body": "true" }, "Synthetic reasoning content");
}
async function render(props = {}) {
  mountedRoot ??= createRoot(document.getElementById("root"));
  await act(() =>
    mountedRoot.render(
      createElement(
        Reasoning,
        { isStreaming: true, startedAt: 40_000, open: true, ...props },
        createElement(ReasoningTrigger, {
          getThinkingMessage: (_streaming, duration) => `elapsed=${duration ?? "unknown"}`,
        }),
        createElement(BodyProbe),
      ),
    ),
  );
}
function label() {
  return document.querySelector("[data-reasoning-label]").textContent;
}
async function wake() {
  await act(() => window.dispatchEvent(new window.Event("focus")));
}
async function unmount() {
  if (mountedRoot) {
    await act(() => mountedRoot.unmount());
    mountedRoot = undefined;
  }
}
afterEach(async () => {
  await unmount();
  clock = 100_000;
  bodyRenders = 0;
});
after(() => {
  Date.now = actualNow;
  dom.window.close();
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

test("流式挂载与重挂载从同一 reasoning_start 起点补算", async () => {
  await render();
  assert.equal(label(), "elapsed=60");
  await unmount();
  clock = 125_000;
  await render();
  assert.equal(label(), "elapsed=85");
});
test("同一实例切换起点时首帧不串用上一会话时间", async () => {
  await render();
  await render({ startedAt: 95_000 });
  assert.equal(label(), "elapsed=5");
  await render({ startedAt: 110_000 });
  assert.equal(label(), "elapsed=1");
});
test("收起再展开继续累计；窗口唤醒立即追平", async () => {
  await render();
  await render({ open: false });
  clock = 160_000;
  await render({ open: true });
  assert.equal(label(), "elapsed=120");
  clock = 210_000;
  await wake();
  assert.equal(label(), "elapsed=170");
});
test("live→complete 使用固定事实，后续唤醒与冷挂载不增长", async () => {
  await render();
  await render({ isStreaming: false, duration: 17 });
  clock = 300_000;
  await wake();
  assert.equal(label(), "elapsed=17");
  await unmount();
  await render({ isStreaming: false, duration: 17 });
  assert.equal(label(), "elapsed=17");
});
test("无完成耗时事实时不把最后一次 UI 挂载时间写成历史耗时", async () => {
  await render();
  clock = 125_000;
  await render({ isStreaming: false });
  assert.equal(label(), "elapsed=unknown");
});
test("固定 duration 优先；秒级文案时钟不重新渲染 reasoning 内容", async () => {
  await render({ duration: 17 });
  assert.equal(label(), "elapsed=17");
  await render();
  const before = bodyRenders;
  clock = 110_000;
  await wake();
  assert.equal(label(), "elapsed=70");
  assert.equal(bodyRenders, before);
});
