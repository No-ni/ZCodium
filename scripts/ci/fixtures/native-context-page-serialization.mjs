import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const tabs = [12, 102, 192, 282]
  .map((x) => `<button role="tab" data-box="${x} 44 90 44">tab</button>`)
  .join("");
const chart = `<svg><g class="native-context-series-after-own">
  <path class="recharts-line-curve" stroke="#after" d="M10,100L60,10M80,40L110,50" />
  </g><g class="native-context-series-actual-own">
  <path class="recharts-line-curve" stroke="#actual" d="M10,100L60,10" />
  </g><circle class="recharts-line-dot" stroke="#actual" cx="10" cy="100" />
  <circle class="recharts-line-dot" stroke="#actual" cx="60" cy="10" />
  <circle class="recharts-line-dot" stroke="#after" cx="80" cy="40" />
  <g class="recharts-xAxis-tick-labels"><text class="recharts-cartesian-axis-tick-value" x="10">0</text>
  <text class="recharts-cartesian-axis-tick-value" x="110">100</text></g>
  <g class="recharts-yAxis-tick-labels"><text class="recharts-cartesian-axis-tick-value" y="100">0</text>
  <text class="recharts-cartesian-axis-tick-value" y="10">1,000</text></g>
  <line class="recharts-reference-line-line" stroke-dasharray="1 4" x1="80" />
  <line class="recharts-reference-line-line" stroke-dasharray="4 4" x1="60" /></svg>`;

/** 只为源码传输提供确定 DOM 和几何端口，不声称浏览器排版或 SVG 测量通过。 */
export function createPageSerializationWindow() {
  const dom = new JSDOM(
    `<!doctype html><html><body>
    <div role="dialog" data-testid="native-context-details" data-box="4 8 382 824">
      <button data-slot="dialog-close" data-box="338 16 44 44">close</button>
      <div role="tablist" data-box="12 44 366 44">${tabs}</div>
      <div data-testid="native-context-detail-scroll" data-box="12 110 366 700">
        <div data-testid="native-context-input-chart" data-box="12 120 366 180"
          data-request-count="3" data-selected-observation-id="source-observation">${chart}</div>
        <div data-testid="native-context-cache-chart" data-box="12 320 366 160"></div>
        <div data-testid="native-context-image-chart" data-box="12 500 366 160"></div>
      </div><div data-testid="native-context-parameters-task">
        <div data-testid="native-context-parameter-scroll" style="overflow-y:auto" data-box="12 110 366 400">
          <button id="target" data-box="28 130 220 44">action</button>
        </div><div data-testid="native-context-parameter-footer" data-box="12 550 366 100"></div>
      </div>
    </div><div role="option" data-testid="source-zero" data-state="checked">known zero</div>
    <div role="option" data-testid="source-unknown">unknown</div></body></html>`,
    {
      url: "https://nctx-source-only.invalid",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const window = dom.window;
  window.innerWidth = 390;
  window.innerHeight = 844;
  window.Element.prototype.getBoundingClientRect = function () {
    const values = (this.getAttribute("data-box") ?? "0 0 0 0").split(" ").map(Number);
    return new window.DOMRect(...values);
  };
  window.Element.prototype.getAnimations = () => [];
  window.document.getAnimations = () => [];
  window.Element.prototype.scrollIntoView = () => {};
  window.matchMedia = () => ({ matches: false });
  for (const id of ["native-context-detail-scroll", "native-context-parameter-scroll"]) {
    const node = window.document.querySelector(`[data-testid="${id}"]`);
    Object.defineProperties(node, { clientWidth: { value: 366 }, scrollWidth: { value: 366 } });
  }
  window.document.elementFromPoint = () => window.document.getElementById("target");
  window.document.getElementById("target").focus();
  for (const path of window.document.querySelectorAll("path")) {
    path.getTotalLength = () => 150;
    path.getBBox = () => ({ x: 10, y: 10, width: 100, height: 90 });
  }
  assert.equal(window.__name, undefined, "Page realm must have no module helper");
  return dom;
}

const box = (x, y, width, height) => ({
  x,
  y,
  width,
  height,
  right: x + width,
  bottom: y + height,
});
const tabBoxes = [12, 102, 192, 282].map((x) => box(x, 44, 90, 44));
const settingsBox = ({ x, y, right, bottom, height }) => ({ x, y, right, bottom, height });

/** 数值来自受控 DOM 输入；不复制被测 reader 或放宽字段为任意数字。 */
export function assertPageSerializationResult(name, value) {
  if (name === "readTrendGeometry") {
    assert.deepEqual(JSON.parse(JSON.stringify(value)), {
      viewport: { width: 390, height: 844 },
      dialog: box(4, 8, 382, 824),
      close: box(338, 16, 44, 44),
      tabs: tabBoxes,
      charts: [
        { ...box(12, 120, 366, 180), ticks: 2 },
        { ...box(12, 320, 366, 160), ticks: 0 },
        { ...box(12, 500, 366, 160), ticks: 0 },
      ],
      scroll: { width: 366, content: 366 },
      animationPending: false,
    });
  } else if (name === "readParameterGeometry") {
    assert.deepEqual(JSON.parse(JSON.stringify(value)), {
      viewport: { width: 390, height: 844 },
      dialog: box(4, 8, 382, 824),
      body: { ...box(12, 110, 366, 400), contentWidth: 366 },
      footer: box(12, 550, 366, 100),
      siblings: true,
      activeInDialog: true,
      animationPending: false,
      element: {
        ...box(28, 130, 220, 44),
        disabled: false,
        open: null,
        focused: true,
        hit: true,
        inBody: true,
        scrollers: 1,
      },
    });
  } else if (name === "readSettingsUi") {
    assert.deepEqual({ width: value.width, height: value.height }, { width: 390, height: 844 });
    const { tablist, tabButtons, detailScroll, x, right, bottom, scrollWidth, clientWidth } =
      value.surface;
    assert.deepEqual(
      JSON.parse(
        JSON.stringify({
          tablist,
          tabButtons,
          detailScroll,
          x,
          right,
          bottom,
          scrollWidth,
          clientWidth,
        }),
      ),
      {
        tablist: settingsBox(box(12, 44, 366, 44)),
        tabButtons: tabBoxes.map(settingsBox),
        detailScroll: settingsBox(box(12, 110, 366, 700)),
        x: 4,
        right: 386,
        bottom: 832,
        scrollWidth: 366,
        clientWidth: 366,
      },
    );
  } else if (name === "readNativeContextLargeLedgerSvg") {
    assert.deepEqual(JSON.parse(JSON.stringify(value)), {
      chartId: "input-chart",
      requestCount: 3,
      selectedId: "source-observation",
      xAxis: [
        { position: 10, value: 0 },
        { position: 110, value: 100 },
      ],
      yAxis: [
        { position: 100, value: 0 },
        { position: 10, value: 1000 },
      ],
      segments: [
        [
          { x: 10, y: 100 },
          { x: 60, y: 10 },
        ],
        [
          { x: 80, y: 40 },
          { x: 110, y: 50 },
        ],
      ],
      length: 150,
      width: 100,
      actualDots: [
        { x: 10, y: 100 },
        { x: 60, y: 10 },
      ],
      eventXs: [80],
      selectedXs: [60],
    });
  } else if (name.endsWith("Settled")) assert.equal(value, true);
  else if (name === "readSettingsOptions") {
    assert.deepEqual(JSON.parse(JSON.stringify(value)), [
      { label: "known zero", testId: "source-zero", selected: true },
      { label: "unknown", testId: "source-unknown", selected: false },
    ]);
  } else throw new Error("UNREGISTERED_SERIALIZATION_PROBE");
}
