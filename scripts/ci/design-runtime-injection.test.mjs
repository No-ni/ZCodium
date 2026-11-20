import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { JSDOM } from "jsdom";
import {
  assertProjectPath,
  createProjectTestSandbox,
  projectRoot,
} from "./project-test-sandbox.mjs";

// 和正式 tsc 相同的去类型产物，完整执行宿主生成的脚本，防止 .toString() 工厂遗漏注入。
const sandbox = await createProjectTestSandbox("design-runtime-injection");
const build = await assertProjectPath(join(sandbox.root, "compiled"));
await mkdir(build);
for (const name of [
  "contract",
  "elementInspector",
  "pageRuntime",
  "pageOverlay",
  "pageBackdrop",
  "pageElements",
  "pageSignals",
  "hostScripts",
]) {
  const source = await readFile(
    join(projectRoot, "packages/design-runtime/src", `${name}.ts`),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  await writeFile(join(build, `${name}.js`), compiled, { flag: "wx" });
}
const { buildDesignRuntimeInstallScript, buildDesignRuntimeCommandScript } = await import(
  pathToFileURL(join(build, "hostScripts.js")).href
);

function page(html) {
  // 不启用 resources，不访问外网；所有 DOM、消息及计时器均在内存里。
  const dom = new JSDOM(html, { url: "https://fixture.test/", runScripts: "outside-only" });
  const { window } = dom;
  const frames = new Map();
  const messages = [];
  const shadows = new WeakMap();
  const attachShadow = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (options) {
    const shadow = attachShadow.call(this, options);
    shadows.set(this, shadow);
    return shadow;
  };
  window.postMessage = (message) => messages.push(message);
  window.requestAnimationFrame = (callback) => {
    const id = frames.size + 1;
    frames.set(id, callback);
    return id;
  };
  window.cancelAnimationFrame = (id) => frames.delete(id);
  window.Element.prototype.getBoundingClientRect = function () {
    const [x = 0, y = 0, width = 100, height = 40] = (this.getAttribute("data-rect") ?? "")
      .split(",")
      .map(Number);
    return { x, y, left: x, top: y, width, height, right: x + width, bottom: y + height };
  };
  window.Element.prototype.getClientRects = function () {
    return [this.getBoundingClientRect()];
  };
  // JSDOM 未实现 innerText 和文本 Range 的布局；用本夹具的真实文字和内存几何补足浏览器读口。
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    configurable: true,
    get() {
      return this.textContent ?? "";
    },
  });
  window.Range.prototype.getBoundingClientRect = () => ({
    x: 10,
    y: 30,
    left: 10,
    top: 30,
    width: 120,
    height: 40,
    right: 130,
    bottom: 70,
  });
  const flushLayout = () => {
    const current = [...frames.values()];
    frames.clear();
    for (const callback of current) callback(0);
  };
  const run = (command) => window.eval(buildDesignRuntimeCommandScript(command));
  return { dom, window, document: window.document, messages, shadows, flushLayout, run };
}

test("serialized factories preserve selection, capture and original CSS with a single runtime", () => {
  const f = page(
    '<html style="--accent: red !important"><head></head><body><button id="first" data-rect="10,30,120,40">First</button><button id="second" data-rect="160,30,120,40">Second</button></body></html>',
  );
  try {
    assert.equal(f.window.eval(buildDesignRuntimeInstallScript("fixtureBridge")).ok, true);
    const host = f.document.querySelector("[data-zcode-design-runtime]");
    assert.ok(host);
    const handle = f.window.__zcodeDesignRuntime;
    assert.equal(f.window.eval(buildDesignRuntimeInstallScript("fixtureBridge")).ok, true);
    assert.equal(f.window.__zcodeDesignRuntime, handle);
    f.run({ type: "set-mode", mode: "select" });
    f.run({ type: "set-selection", selectors: ["#first", "#second"] });
    f.flushLayout();
    const selections = f.messages
      .flatMap((message) => (message.fixtureBridge ? message.events : []))
      .findLast((event) => event.type === "selection-changed").selections;
    assert.equal(selections.length, 2);
    assert.equal(selections[1].source.id, "second");
    assert.equal(selections[1].source.steps.at(-1).siblings, 2);
    assert.deepEqual(
      [...f.shadows.get(host).querySelectorAll(".badge")].map((badge) => badge.textContent),
      ["1", "2"],
    );
    f.document.querySelector("#first").scrollIntoView = () => {};
    assert.equal(f.run({ type: "locate-for-capture", selector: "#first" }).ok, true);
    assert.equal(host.style.display, "none");
    f.run({ type: "end-capture" });
    assert.equal(host.style.display, "");
    f.run({ type: "set-css-variables", values: { "--accent": "blue" } });
    assert.equal(f.document.documentElement.style.getPropertyValue("--accent"), "blue");
    assert.equal(f.document.documentElement.style.getPropertyPriority("--accent"), "important");
    f.run({ type: "dispose" });
    assert.equal(f.document.documentElement.style.getPropertyValue("--accent"), "red");
    assert.equal(f.document.documentElement.style.getPropertyPriority("--accent"), "important");
    assert.equal(f.document.querySelector("[data-zcode-design-runtime]"), null);
    assert.equal(f.window.__zcodeDesignRuntime, undefined);
  } finally {
    f.dom.window.close();
  }
});

test("stage backdrop recomputes from original styles and removes its projection on resize/dispose", () => {
  const f = page(
    '<html data-rect="0,0,1024,768"><head></head><body style="background: rgb(25,25,25); color: white" data-rect="0,0,1024,768"><main data-rect="0,0,1024,768"><div id="board" style="background: white; color: black" data-rect="100,100,240,400">Board</div></main></body></html>',
  );
  try {
    Object.defineProperty(f.document.documentElement, "scrollHeight", {
      configurable: true,
      value: 768,
    });
    assert.equal(
      f.window.eval(buildDesignRuntimeInstallScript("fixtureBridge")).result.stageBackdrop,
      true,
    );
    assert.equal(f.run({ type: "read-info" }).result.stageBackdrop, true);
    const style = f.document.querySelector("style[data-zcode-design-runtime]");
    assert.ok(style.textContent.includes("background:transparent!important"));
    Object.defineProperty(f.document.documentElement, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    f.window.dispatchEvent(new f.window.Event("resize"));
    assert.equal(f.run({ type: "read-info" }).result.stageBackdrop, false);
    assert.equal(style.isConnected, false);
    assert.ok(
      f.messages.some((message) =>
        message.events.some((event) => event.type === "stage-changed" && !event.stageBackdrop),
      ),
    );
    f.run({ type: "dispose" });
    assert.equal(f.document.body.style.background, "rgb(25, 25, 25)");
    assert.equal(f.document.querySelector("[data-zcode-design-runtime]"), null);
  } finally {
    f.dom.window.close();
  }
});
