import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import ts from "typescript";

const require = createRequire(new URL("../../packages/ui/package.json", import.meta.url));
const React = require("react");
const { createRoot } = require("react-dom/client");
const text = await readFile(
  new URL("../../packages/ui/src/v4/ConversationTurnGroup.tsx", import.meta.url),
  "utf8",
);
const source = ts.createSourceFile(
  "ConversationTurnGroup.tsx",
  text,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const expressions = [];
function visit(node) {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(source) === "useMemo" &&
    node.getText(source).includes("buildAssistantWorkRenderItems(")
  )
    expressions.push(node.getText(source));
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(expressions.length, 1);
let rebuilds = 0;
const builder = (_rows, preferences) => {
  rebuilds++;
  return { showTodos: preferences.messageStreamShowTodos };
};
const harness = new Function(
  "React",
  "useMemo",
  "buildAssistantWorkRenderItems",
  `
const ENABLE_CUA_TOOL_CALL_GROUPING = true, ENABLE_EXPLORE_TOOL_CALL_GROUPING = true,
 ENABLE_TERMINAL_TOOL_CALL_GROUPING = true, ENABLE_CHANGES_TOOL_CALL_GROUPING = true;
return function PreferenceHarness({ context, rows }) {
 const showReasoning = context.messageStreamShowReasoning === true;
 const firstReasoningRowId = context.messageStreamFirstReasoningRowId;
 const stageTailIsRunning = false;
 const items = ${expressions[0]};
 return React.createElement('output', null, JSON.stringify(items));
};`,
)(React, React.useMemo, builder);

test("TODO preference invalidates the actual work-item memo while unrelated context stays stable", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const names = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = new Map(
    names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  for (const name of names)
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name],
    });
  const root = createRoot(dom.window.document.getElementById("root"));
  const rows = [];
  const context = { messageStreamShowTodos: false, messageStreamShowReasoning: false };
  try {
    await React.act(async () => root.render(React.createElement(harness, { context, rows })));
    assert.equal(
      JSON.parse(dom.window.document.querySelector("output").textContent).showTodos,
      false,
    );
    await React.act(async () =>
      root.render(
        React.createElement(harness, {
          context: { ...context, messageStreamShowTodos: true },
          rows,
        }),
      ),
    );
    assert.equal(
      JSON.parse(dom.window.document.querySelector("output").textContent).showTodos,
      true,
    );
    assert.equal(rebuilds, 2);
    await React.act(async () =>
      root.render(
        React.createElement(harness, {
          context: { ...context, messageStreamShowTodos: true, unrelatedPreference: true },
          rows,
        }),
      ),
    );
    assert.equal(rebuilds, 2);
  } finally {
    await React.act(async () => root.unmount());
    for (const name of names) {
      const descriptor = previous.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    dom.window.close();
  }
});
