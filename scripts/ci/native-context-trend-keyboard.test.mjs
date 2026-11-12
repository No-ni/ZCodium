import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { JSDOM } from "jsdom";

const helperText = await readFile(
  new URL(
    "../../packages/desktop/test/e2e/helpers/native-context-compression/trends.ts",
    import.meta.url,
  ),
  "utf8",
);
const helperSource = ts.createSourceFile("trends.ts", helperText, ts.ScriptTarget.Latest, true);
const interactions = helperSource.statements.find(
  (node) =>
    ts.isFunctionDeclaration(node) && node.name?.text === "assertNativeContextTrendInteractions",
);
assert.ok(interactions?.body, "The real trend interaction entrypoint must exist");
const statements = interactions.body.statements;
const first = statements.findIndex(
  (node) => node.getText(helperSource) === "await expectRealTrendLines(main);",
);
const last = statements.findIndex(
  (node) =>
    ts.isVariableStatement(node) &&
    node.declarationList.declarations.some(
      (declaration) =>
        ts.isIdentifier(declaration.name) && declaration.name.text === "beforeSeries",
    ),
);
assert.ok(first >= 0 && last > first, "Execute the actual keyboard block, not a duplicate");
const declarations = helperSource.statements
  .filter(
    (node) =>
      node !== interactions && !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node),
  )
  .map((node) => node.getText(helperSource))
  .join("\n");
const keyboardBlock = statements
  .slice(first + 1, last)
  .map((node) => node.getText(helperSource))
  .join("\n");
const compiled = ts.transpileModule(
  declarations +
    "\nreturn { expectSelectedRequest, focusTrendKeyboardGroup, runKeyboard: async () => {\n" +
    keyboardBlock +
    "\n} };",
  { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } },
).outputText;

const chartText = await readFile(
  new URL(
    "../../packages/ui/src/native-context-compression/ui/NativeContextTrendChart.tsx",
    import.meta.url,
  ),
  "utf8",
);
const chartSource = ts.createSourceFile(
  "chart.tsx",
  chartText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const handlers = [];
function visit(node) {
  if (ts.isJsxAttribute(node) && node.name.getText(chartSource) === "onKeyDown") {
    if (node.initializer && ts.isJsxExpression(node.initializer))
      handlers.push(node.initializer.expression);
  }
  ts.forEachChild(node, visit);
}
visit(chartSource);
assert.equal(handlers.length, 1, "Use the native chart keyboard owner");
const chartHandler = ts.transpileModule("return " + handlers[0].getText(chartSource) + ";", {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
}).outputText;
const makeChartHandler = new Function("points", "selectedIndex", "onSelect", chartHandler);
const chartIds = ["input-chart", "cache-chart", "image-chart"];
const main = [1, 2, 3].map((requestSeq) => ({
  id: "source-observation-" + requestSeq,
  requestSeq,
  model: { providerId: "fixture-provider", modelId: "fixture-model" },
}));

function fixture() {
  const dom = new JSDOM(
    '<div data-testid="native-context-details"><button data-testid="fixture-entry">entry</button>' +
      chartIds
        .map(
          (chart) =>
            `<section data-testid="native-context-${chart}" data-selected-observation-id="${main[1].id}">` +
            `<button data-testid="${chart}-series">series</button><div role="group" tabindex="0">` +
            '<svg role="application" tabindex="0"></svg></div></section>',
        )
        .join("") +
      `<article data-testid="native-context-request-details" data-observation-id="${main[1].id}">fixture-model</article>` +
      '<button data-testid="native-context-trend-request">request</button></div><button id="outside">outside</button>',
  );
  const document = dom.window.document;
  const trace = [];
  const reads = [];
  let selectedId = main[1].id;
  const element = (id) => document.querySelector(`[data-testid="native-context-${id}"]`);
  const setSelected = (id) => {
    selectedId = id;
    element("request-details")?.setAttribute("data-observation-id", id);
    for (const chart of chartIds) element(chart)?.setAttribute("data-selected-observation-id", id);
  };
  for (const chart of chartIds) {
    element(chart)
      .querySelector('[role="group"]')
      .addEventListener("keydown", (event) => {
        makeChartHandler(
          main.map((observation) => ({ observation })),
          main.findIndex((entry) => entry.id === selectedId),
          setSelected,
        )(event);
      });
  }
  document.querySelector('[data-testid="fixture-entry"]').focus();
  const wrapper = (node, chart) => ({
    $(selector) {
      return wrapper(node?.querySelector(selector), chart);
    },
    async click() {
      // 原因：实际 click 成功不保证焦点转移；模拟该合法前提，不能让测试凭 click 宣称键盘已送达。
      (chart === "input-chart"
        ? node
        : document.querySelector('[data-testid="fixture-entry"]')
      ).focus();
    },
    async getAttribute(name) {
      return node?.getAttribute(name) ?? null;
    },
    async getText() {
      return node?.textContent ?? "";
    },
  });
  const browser = {
    async execute(fn, ...args) {
      const result = fn(...args);
      reads.push(structuredClone(result));
      return result;
    },
    async keys(key) {
      const backwards = Array.isArray(key) && key[0] === "Shift";
      const name = Array.isArray(key) ? key.at(-1) : key;
      if (name === "Tab") {
        const stops = [
          ...document
            .querySelector('[data-testid="native-context-details"]')
            .querySelectorAll('button, [tabindex="0"]'),
        ];
        const index = stops.indexOf(document.activeElement);
        stops[(index + (backwards ? -1 : 1) + stops.length) % stops.length].focus();
        trace.push({ key: backwards ? "Shift+Tab" : "Tab" });
        return;
      }
      const group = document.activeElement?.closest('[role="group"]');
      trace.push({
        key: name,
        chart: group?.closest("section")?.getAttribute("data-testid") ?? null,
      });
      document.activeElement?.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }),
      );
    },
    async waitUntil(check, options) {
      for (let attempt = 0; attempt < 3; attempt++) if (await check()) return;
      throw new Error(options.timeoutMsg);
    },
  };
  const expect = (value) => ({ toContain: (part) => assert.ok(String(value).includes(part)) });
  const load = new Function(
    "document",
    "browser",
    "expect",
    "nativeContextElement",
    "main",
    "chooseNativeContextOption",
    compiled,
  );
  const source = load(
    document,
    browser,
    expect,
    (id) => wrapper(element(id), id),
    main,
    async () => {
      setSelected(main[1].id);
      element("trend-request").focus();
    },
  );
  return { dom, document, browser, source, reads, trace, element, setSelected };
}

test("actual helper acquires chart focus before Home/End and synchronizes the last owner observation", async (t) => {
  const f = fixture();
  t.after(() => f.dom.window.close());
  await f.source.runKeyboard();
  assert.ok(f.trace.some((entry) => entry.key === "Tab"));
  assert.ok(f.trace.some((entry) => entry.key === "Shift+Tab"));
  assert.ok(
    f.trace.some((entry) => entry.key === "End" && entry.chart === "native-context-cache-chart"),
  );
  assert.ok(f.reads.some((snapshot) => snapshot.ids.every((entry) => entry.id === main.at(-1).id)));
  assert.equal(f.element("request-details").getAttribute("data-observation-id"), main[1].id);
});

test("detail mismatch still captures all three chart IDs and activeElement in the same DOM read", async (t) => {
  const f = fixture();
  t.after(() => f.dom.window.close());
  for (const chart of chartIds)
    f.element(chart).setAttribute("data-selected-observation-id", main.at(-1).id);
  await assert.rejects(f.source.expectSelectedRequest(main.at(-1)), (error) => {
    assert.match(error.message, /source-observation-2/);
    assert.match(error.message, /source-observation-3/);
    for (const chart of chartIds) assert.ok(error.message.includes(chart));
    assert.match(error.message, /fixture-entry/);
    return true;
  });
  assert.equal(
    f.reads.length,
    3,
    "One execute call must capture every ID and focus per wait attempt",
  );
});

test("one divergent chart reports the complete selection rather than an early-return guess", async (t) => {
  const f = fixture();
  t.after(() => f.dom.window.close());
  f.setSelected(main.at(-1).id);
  f.element("cache-chart").setAttribute(
    "data-selected-observation-id",
    "different-cache-observation",
  );
  await assert.rejects(f.source.expectSelectedRequest(main.at(-1)), (error) => {
    assert.match(error.message, /different-cache-observation/);
    for (const chart of chartIds) assert.ok(error.message.includes(chart));
    assert.match(error.message, /fixture-entry/);
    return true;
  });
  assert.equal(f.reads.length, 3);
});

test("SVG descendant focus belongs to the native group and still executes the actual End handler", async (t) => {
  const f = fixture();
  t.after(() => f.dom.window.close());
  await f.source.focusTrendKeyboardGroup("input-chart");
  await f.browser.keys("Tab");
  assert.equal(f.document.activeElement.tagName.toLowerCase(), "svg");
  const traceBefore = f.trace.length;
  await f.source.focusTrendKeyboardGroup("input-chart");
  assert.equal(
    f.trace.length,
    traceBefore,
    "Containment accepts a focused SVG without stealing focus",
  );
  await f.browser.keys("End");
  await f.source.expectSelectedRequest(main.at(-1), "input-chart");
});

test("a retired chart target rejects before sending any navigation or selection key", async (t) => {
  const f = fixture();
  t.after(() => f.dom.window.close());
  f.element("cache-chart").querySelector('[role="group"]').remove();
  await assert.rejects(
    f.source.focusTrendKeyboardGroup("cache-chart"),
    /keyboard target is unavailable.*cache-chart/,
  );
  assert.deepEqual(f.trace, []);
  assert.equal(f.reads.length, 1);
});

test("focus outside the dialog fails rather than cycling through the rest of the product", async (t) => {
  const f = fixture();
  t.after(() => f.dom.window.close());
  f.document.getElementById("outside").focus();
  await assert.rejects(
    f.source.focusTrendKeyboardGroup("input-chart"),
    /keyboard target is unavailable/,
  );
  assert.equal(f.reads[0].activeElement.inDialog, false);
  assert.deepEqual(f.trace, []);
});

test("correct selected IDs do not hide loss of the keyboard target focus", async (t) => {
  const f = fixture();
  t.after(() => f.dom.window.close());
  f.setSelected(main.at(-1).id);
  await assert.rejects(f.source.expectSelectedRequest(main.at(-1), "cache-chart"), (error) => {
    assert.match(error.message, /inTargetGroup":false/);
    assert.match(error.message, /fixture-entry/);
    assert.match(error.message, /target=cache-chart/);
    return true;
  });
  assert.equal(f.reads.length, 3);
});

test("a missing detail keeps null and the three real chart IDs in the failure evidence", async (t) => {
  const f = fixture();
  t.after(() => f.dom.window.close());
  f.setSelected(main.at(-1).id);
  f.element("request-details").remove();
  await assert.rejects(f.source.expectSelectedRequest(main.at(-1)), (error) => {
    assert.match(error.message, /request-details","id":null/);
    for (const chart of chartIds) assert.ok(error.message.includes(chart));
    return true;
  });
  assert.equal(f.reads.length, 3);
});
