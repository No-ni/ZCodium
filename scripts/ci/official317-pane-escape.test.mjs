import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function sourceFile(path) {
  const text = await readFile(new URL("../../" + path, import.meta.url), "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.deepEqual(source.parseDiagnostics, [], path + " must parse");
  return source;
}

function findNodes(root, predicate) {
  const matches = [];
  function visit(node) {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return matches;
}

function only(nodes, label) {
  assert.equal(nodes.length, 1, label);
  return nodes[0];
}

function declaration(source, name) {
  return only(
    findNodes(
      source,
      (node) =>
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name,
    ),
    "one production declaration: " + name,
  );
}

function jsxAttribute(tag, name) {
  return tag.attributes.properties.find(
    (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText() === name,
  );
}

const pane = await sourceFile("packages/ui/src/v4/SessionPane.tsx");
const timeline = await sourceFile("packages/ui/src/v4/ConversationTimeline.tsx");
const escapePolicy = await sourceFile("packages/ui/src/v4/composer/escapeStop.ts");

// 抽取注册 Esc 的真实 effect；执行后截获其中注册的 event callback，避免镜像 handler。
const escapeEffect = only(
  findNodes(
    pane,
    (node) =>
      ts.isCallExpression(node) &&
      node.expression.getText(pane) === "useEffect" &&
      node.arguments[0] &&
      findNodes(
        node.arguments[0],
        (child) =>
          ts.isCallExpression(child) &&
          child.expression.getText(pane) === "handleStop" &&
          child.arguments[0]?.getText(pane) === '"escape"',
      ).length === 1,
  ),
  "one production Escape effect",
).arguments[0];
assert.ok(ts.isArrowFunction(escapeEffect));
const effectCode = ts.transpileModule("const effect = " + escapeEffect.getText(pane) + ";", {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
}).outputText;
const policyCode = ts.transpileModule(escapePolicy.text, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
}).outputText;
const shouldIgnoreEscapeForStopGeneration = new Function(
  "exports",
  policyCode + "\nreturn exports.shouldIgnoreEscapeForStopGeneration;",
)({});

function fixture(overrides = {}) {
  const paneElement = {};
  const input = {};
  const timelineElement = {};
  const outside = {};
  const stops = [];
  const listeners = new Map();
  const registrations = [];
  const removals = [];
  const dependencies = {
    focused: true,
    readOnly: false,
    sessionId: "fixture-session",
    snapshot: { control: { canStop: true } },
    allowEscapeStopOutsidePane: false,
    conversationLayoutContainerRef: { current: paneElement },
    shouldIgnoreEscapeForStopGeneration,
    handleStop: (source) => stops.push(source),
    ...overrides,
    window: {
      addEventListener(type, callback) {
        assert.equal(type, "keydown");
        assert.equal(listeners.size, 0);
        registrations.push(callback);
        listeners.set(type, callback);
      },
      removeEventListener(type, callback) {
        assert.equal(listeners.get(type), callback);
        removals.push(callback);
        listeners.delete(type);
      },
    },
  };
  const effect = new Function(...Object.keys(dependencies), effectCode + "\nreturn effect;")(
    ...Object.values(dependencies),
  );
  const cleanup = effect();
  return {
    paneElement,
    input,
    timelineElement,
    outside,
    stops,
    listeners,
    registrations,
    removals,
    cleanup,
    dispatch(path, { key = "Escape", defaultPrevented = false } = {}) {
      const event = {
        key,
        defaultPrevented,
        preventDefaultCalls: 0,
        composedPath: () => path,
        preventDefault() {
          this.preventDefaultCalls++;
          this.defaultPrevented = true;
        },
      };
      listeners.get("keydown")?.(event);
      return event;
    },
  };
}

test("the mounted layout ref contains the timeline and its inline composer dock", () => {
  const ref = declaration(pane, "conversationLayoutContainerRef");
  assert.equal(ref.initializer.expression.getText(pane), "useRef");
  const container = only(
    findNodes(
      pane,
      (node) =>
        ts.isJsxElement(node) &&
        node.openingElement.tagName.getText(pane) === "div" &&
        jsxAttribute(node.openingElement, "ref")?.initializer?.getText(pane) ===
          "{conversationLayoutContainerRef}",
    ),
    "one mounted conversation layout",
  );
  const timelineTag = only(
    findNodes(
      container,
      (node) =>
        ts.isJsxSelfClosingElement(node) && node.tagName.getText(pane) === "ConversationTimeline",
    ),
    "timeline inside layout",
  );
  assert.equal(
    jsxAttribute(timelineTag, "bottomDock").initializer.getText(pane),
    "{conversationBottomDock}",
  );
  assert.match(declaration(pane, "composerNode").getText(pane), /<ConversationComposer\b/);
  assert.match(
    declaration(pane, "conversationBottomDockContent").getText(pane),
    /\{composerNode\}/,
  );
  assert.match(
    declaration(pane, "conversationBottomDock").getText(pane),
    /\{conversationBottomDockContent\}/,
  );
  only(
    findNodes(
      timeline,
      (node) => ts.isJsxExpression(node) && node.expression?.getText(timeline) === "bottomDock",
    ),
    "composer dock rendered inline in timeline",
  );
});

for (const [name, target, overrides, shouldStop] of [
  ["input inside Pane stops", "input", {}, true],
  ["timeline inside Pane stops", "timelineElement", {}, true],
  ["outside Pane does not stop by default", "outside", {}, false],
  ["explicit opt-in accepts outside Pane", "outside", { allowEscapeStopOutsidePane: true }, true],
  ["explicit opt-in also accepts inside Pane", "input", { allowEscapeStopOutsidePane: true }, true],
  [
    "unmounted ref does not stop",
    "input",
    { conversationLayoutContainerRef: { current: null } },
    false,
  ],
  [
    "unmounted ref with opt-in does not stop",
    "outside",
    { conversationLayoutContainerRef: { current: null }, allowEscapeStopOutsidePane: true },
    false,
  ],
]) {
  test(name, () => {
    const f = fixture(overrides);
    const path = target === "outside" ? [f.outside] : [f[target], f.paneElement];
    const event = f.dispatch(path);
    assert.deepEqual(f.stops, shouldStop ? ["escape"] : []);
    assert.equal(event.preventDefaultCalls, shouldStop ? 1 : 0);
  });
}

for (const [name, overrides] of [
  ["unfocused", { focused: false }],
  ["unfocused with outside opt-in", { focused: false, allowEscapeStopOutsidePane: true }],
  ["readonly", { readOnly: true }],
  ["readonly with outside opt-in", { readOnly: true, allowEscapeStopOutsidePane: true }],
  ["cannot stop", { snapshot: { control: { canStop: false } } }],
  ["no session", { sessionId: null }],
  ["no snapshot", { snapshot: null }],
]) {
  test(name + " does not register Escape", () => {
    const f = fixture(overrides);
    assert.equal(f.registrations.length, 0);
    assert.equal(f.cleanup, undefined);
    assert.equal(f.dispatch([f.input, f.paneElement]).preventDefaultCalls, 0);
    assert.deepEqual(f.stops, []);
  });
}

for (const [name, extraPath, eventOptions] of [
  ["defaultPrevented", [], { defaultPrevented: true }],
  ["Radix dialog", [{ dataset: { slot: "dialog-content" } }], {}],
  ["role dialog", [{ getAttribute: (name) => (name === "role" ? "dialog" : null) }], {}],
]) {
  for (const allowEscapeStopOutsidePane of [false, true]) {
    test(
      name + " yields " + (allowEscapeStopOutsidePane ? "outside with opt-in" : "inside Pane"),
      () => {
        const f = fixture({ allowEscapeStopOutsidePane });
        const path = allowEscapeStopOutsidePane
          ? [f.outside, ...extraPath]
          : [f.input, ...extraPath, f.paneElement];
        const event = f.dispatch(path, eventOptions);
        assert.deepEqual(f.stops, []);
        assert.equal(event.preventDefaultCalls, 0);
      },
    );
  }
}

test("other keys do not stop and cleanup removes the exact production callback", () => {
  const f = fixture();
  const event = f.dispatch([f.input, f.paneElement], { key: "Enter" });
  assert.deepEqual(f.stops, []);
  assert.equal(event.preventDefaultCalls, 0);
  assert.equal(f.registrations.length, 1);
  f.cleanup();
  assert.deepEqual(f.removals, f.registrations);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.dispatch([f.input, f.paneElement]).preventDefaultCalls, 0);
  assert.deepEqual(f.stops, []);
});
