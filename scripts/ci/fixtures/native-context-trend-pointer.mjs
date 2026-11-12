import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { assertProjectPath, projectRoot } from "../project-test-sandbox.mjs";

const require = createRequire(import.meta.url);
const chartPath = join(
  projectRoot,
  "packages/ui/src/native-context-compression/ui/NativeContextTrendChart.tsx",
);
const chartIds = [
  "native-context-input-chart",
  "native-context-cache-chart",
  "native-context-image-chart",
];
const dimensions = { width: 390, height: 224 };

// 仅替换图表外的展示/服务端口；LineChart、轴、Tooltip 与事件分派都来自已安装的公开 Recharts。
const ports = {
  "@/components/ui/button.js": `import React from 'react';
export function Button({variant,size,...props}) {return React.createElement('button',props);}`,
  "@/components/ui/chart.js": `import React from 'react';
import {ResponsiveContainer,Tooltip} from 'recharts';
export {Tooltip as ChartTooltip};
export function ChartContainer({children}) {return React.createElement(ResponsiveContainer,{width:390,height:224},children);}
export function ChartTooltipContent({label,labelFormatter,payload,formatter}) {
 const heading=labelFormatter ? labelFormatter(label,payload) : label;
 return React.createElement('div',{'data-testid':'source-tooltip'},
  React.createElement('span',{'data-testid':'source-tooltip-label'},heading),
  ...payload.map((item,index)=>React.createElement('span',{key:index,'data-testid':'source-tooltip-value'},
   formatter ? formatter(item.value,item.name,item,index,payload) : String(item.value))));
}`,
  "@/i18n/IntlProvider.js": `const value={locale:'en-US',intl:{formatMessage:({id},values={})=>
 id==='nativeContext.requestNumber' ? 'Request '+values.request : id}};
export function useZCodeIntl(){return value;}`,
  "@/store/nativeContextCompressionDraftStore.js": `const state={trends:{},selectTrend(){}};
export function useNativeContextDraftStore(selector){return selector(state);}
useNativeContextDraftStore.getState=()=>state;`,
};

export async function loadNativeTrendPointerSource() {
  const sandbox = await assertProjectPath(process.env.PROJECT_TEST_SANDBOX_ROOT);
  await assertProjectPath(chartPath);
  const result = await build({
    stdin: {
      contents: `export {NativeContextTrendChart} from ${JSON.stringify(chartPath)};
export {buildNativeContextChartRows} from ${JSON.stringify(join(projectRoot, "packages/ui/src/native-context-compression/domain/chart.ts"))};`,
      resolveDir: projectRoot,
      sourcefile: "native-context-trend-pointer-source.tsx",
      loader: "tsx",
    },
    bundle: true,
    write: false,
    keepNames: true,
    metafile: true,
    jsx: "automatic",
    format: "cjs",
    platform: "node",
    external: ["react", "react/*", "recharts"],
    logLevel: "silent",
    plugins: [
      {
        name: "native-trend-external-ports",
        setup(builder) {
          builder.onResolve({ filter: /^@\// }, ({ path }) => {
            assert.ok(Object.hasOwn(ports, path), "Unexpected chart source dependency");
            return { path, namespace: "native-trend-port" };
          });
          builder.onLoad({ filter: /.*/, namespace: "native-trend-port" }, ({ path }) => ({
            contents: ports[path],
            loader: "jsx",
            resolveDir: projectRoot,
          }));
        },
      },
    ],
  });
  const sources = [];
  for (const path of Object.keys(result.metafile.inputs)) {
    if (path.startsWith("native-trend-port:") || path.includes("source.tsx")) continue;
    assert.ok(!path.includes("/dist/"), "Current source is required");
    const bytes = await readFile(await assertProjectPath(join(projectRoot, path)));
    sources.push({
      path: path.replaceAll("\\", "/"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  assert.ok(sources.some(({ path }) => path.endsWith("/ui/NativeContextTrendChart.tsx")));
  const compiled = result.outputFiles[0].text;
  await writeFile(await assertProjectPath(join(sandbox, "trend-pointer-source.cjs")), compiled);
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)(require, module, module.exports);
  return {
    ...module.exports,
    evidence: {
      node: process.version,
      rechartsVersion: require("recharts/package.json").version,
      sources,
      compiledSha256: createHash("sha256").update(compiled).digest("hex"),
      boundary:
        "Current TSX + React/Recharts DOM events; deterministic JSDOM dimensions/animation frames and external display/service ports; no browser or product process",
    },
  };
}

/** 几何和帧调度是 JSDOM 缺失的浏览器端口，不代替被测选中函数或 Recharts 事件实现。 */
export async function createNativeTrendPointerFixture({
  points,
  source,
  scale = 1,
  unit = "tokens",
}) {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", {
    url: "https://native-context-source.invalid/",
    pretendToBeVisual: true,
  });
  const window = dom.window;
  const descriptors = new Map();
  const frames = new Map();
  let nextFrame = 0;
  const raf = (callback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  };
  window.requestAnimationFrame = raf;
  window.cancelAnimationFrame = (id) => frames.delete(id);
  const bindings = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    SVGElement: window.SVGElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    TouchEvent: window.TouchEvent,
    KeyboardEvent: window.KeyboardEvent,
    DOMRect: window.DOMRect,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: raf,
    cancelAnimationFrame: window.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(bindings)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  Object.defineProperties(window.HTMLElement.prototype, {
    offsetWidth: {
      configurable: true,
      get() {
        return Number.parseFloat(this.style.width) || dimensions.width;
      },
    },
    offsetHeight: {
      configurable: true,
      get() {
        return Number.parseFloat(this.style.height) || dimensions.height;
      },
    },
  });
  function box(element) {
    const section = element.closest?.("section[data-testid]");
    const ordinal = chartIds.indexOf(section?.getAttribute("data-testid"));
    return new window.DOMRect(
      100.25,
      40.5 + Math.max(0, ordinal) * 300,
      dimensions.width * scale,
      dimensions.height * scale,
    );
  }
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return box(this);
  };
  window.SVGElement.prototype.getBoundingClientRect = function () {
    return box(this);
  };
  window.SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, ...dimensions });
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const loaded = source ?? (await loadNativeTrendPointerSource());
  const root = createRoot(window.document.getElementById("root"));
  const trace = [];
  const eventTrace = [];
  const original = JSON.stringify(points);
  function SharedSelection() {
    const [selected, setSelected] = React.useState(points.at(-1)?.observation.id ?? null);
    const onSelect = React.useCallback((id) => {
      trace.push(id);
      setSelected(id);
    }, []);
    return React.createElement(
      "div",
      null,
      React.createElement("output", {
        "data-testid": "request-detail",
        "data-observation-id": selected,
      }),
      ...chartIds.map((testId) =>
        React.createElement(loaded.NativeContextTrendChart, {
          key: testId,
          testId,
          scopeKey: testId,
          title: "Pointer chart",
          points,
          selectedId: selected,
          onSelect,
          unit,
          series: [
            { key: "before", label: "Before", color: "#888888" },
            { key: "after", label: "After", color: "#008800" },
            { key: "actual", label: "Actual", color: "#663399", kind: "point" },
          ],
        }),
      ),
    );
  }
  async function settle(action) {
    await React.act(async () => {
      action?.();
    });
    for (let batch = 0; frames.size && batch < 20; batch++) {
      const callbacks = [...frames.values()];
      frames.clear();
      await React.act(async () => {
        for (const callback of callbacks) callback(batch * 16);
      });
    }
    assert.equal(frames.size, 0, "Actual Recharts frame queue must settle");
  }
  await settle(() => root.render(React.createElement(SharedSelection)));
  function section(index = 0) {
    return window.document.querySelector(`[data-testid="${chartIds[index]}"]`);
  }
  function wrapper(index = 0) {
    return section(index).querySelector(".recharts-wrapper");
  }
  function snapshot() {
    return {
      detail: window.document
        .querySelector('[data-testid="request-detail"]')
        .getAttribute("data-observation-id"),
      charts: chartIds.map((_, index) =>
        section(index).getAttribute("data-selected-observation-id"),
      ),
    };
  }
  function coordinate(index, chart = 0) {
    const lines = Array.from(
      section(chart).querySelectorAll(".recharts-cartesian-grid-horizontal line"),
    );
    assert.ok(lines.length > 1, "Actual Recharts grid endpoints must render");
    const x = Math.min(...lines.map((line) => Number(line.getAttribute("x1"))));
    const right = Math.max(...lines.map((line) => Number(line.getAttribute("x2"))));
    const y = Math.min(...lines.map((line) => Number(line.getAttribute("y1"))));
    const bottom = Math.max(...lines.map((line) => Number(line.getAttribute("y1"))));
    const width = right - x;
    const height = bottom - y;
    assert.ok(width > 0 && height > 0, "Use actual Recharts plot dimensions");
    return { x: x + (width * index) / Math.max(1, points.length - 1), y: y + height / 2 };
  }
  function dot(index, chart = 0) {
    const { x } = coordinate(index, chart);
    const matches = Array.from(section(chart).querySelectorAll("circle.recharts-line-dot")).filter(
      (node) => Math.abs(Number(node.getAttribute("cx")) - x) < 1e-6,
    );
    assert.ok(matches.length, "The requested original X must have an actual rendered dot");
    return matches.at(-1);
  }
  async function dispatch(type, index, { chart = 0, useDot = false, outside = false } = {}) {
    const target = useDot ? dot(index, chart) : wrapper(chart);
    const position = coordinate(index, chart);
    const rect = wrapper(chart).getBoundingClientRect();
    const clientX = rect.left + (outside ? -1 : position.x) * scale;
    const clientY = rect.top + (useDot ? Number(target.getAttribute("cy")) : position.y) * scale;
    const touch = {
      identifier: 1,
      target,
      clientX,
      clientY,
      pageX: clientX,
      pageY: clientY,
      screenX: clientX,
      screenY: clientY,
    };
    const event = type.startsWith("touch")
      ? new window.TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: type === "touchend" ? [] : [touch],
          targetTouches: [],
          changedTouches: [touch],
        })
      : new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
    eventTrace.push({
      type,
      clientX: event.clientX ?? event.changedTouches[0].clientX,
      clientY: event.clientY ?? event.changedTouches[0].clientY,
      touches: event.touches?.length ?? null,
      changedTouches: event.changedTouches?.length ?? null,
      originalIndex: index,
    });
    await settle(() => target.dispatchEvent(event));
    return snapshot();
  }
  return {
    source: loaded,
    points,
    trace,
    eventTrace,
    snapshot,
    dispatch,
    section,
    coordinate,
    dot,
    tooltip() {
      const node = section().querySelector('[data-testid="source-tooltip-label"]');
      return node?.textContent ?? null;
    },
    async key(key, chart = 0) {
      await settle(() =>
        section(chart)
          .querySelector('[role="group"]')
          .dispatchEvent(
            new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
          ),
      );
      return snapshot();
    },
    assertUnchanged() {
      assert.equal(
        JSON.stringify(points),
        original,
        "Pointer selection must not fabricate or rewrite measurements",
      );
    },
    async close() {
      await settle(() => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}
