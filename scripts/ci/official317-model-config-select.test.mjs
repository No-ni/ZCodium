// 官方 3.17.1 合并后 ModelConfigSelect.tsx 留下两类失效引用：
// 1) 触发器内联 JSX 被改名为 triggerContents 却漏带定义，渲染即 ReferenceError；
// 2) 展示冻结块读写 composerOptions.providerMenu，本 fork 的 ComposerModelOptions 没有该字段
//    （官方账号刷新入口，本 fork 按审计边界剥离）。
// 本回归锁死修复契约：不得出现 providerMenu/highspeed 引用，triggerContents 必须定义且被渲染；
// 并抽取组件内的生产函数与真实触发器内容执行，覆盖 legacy/composer/pending/开态四条路径。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const componentUrl = new URL("../../packages/ui/src/ModelConfigSelect.tsx", import.meta.url);
const menuUrl = new URL(
  "../../packages/ui/src/chat-input-toolbar/ComposerModelMenu.tsx",
  import.meta.url,
);

async function loadComponentSource() {
  const text = await readFile(componentUrl, "utf8");
  return ts.createSourceFile(
    "ModelConfigSelect.tsx",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function lineOf(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

// 官方账号/购买入口在本 fork 一律剥离：providerMenu（供应商云菜单）与 highspeed（高速模型）均不存在。
test("the repaired component keeps no official providerMenu or highspeed references", async () => {
  const source = await loadComponentSource();
  const banned = new Set(["providerMenu", "highspeed", "isGlmHighspeedModel"]);
  const found = [];
  const visit = (node) => {
    // JSX 子节点可能为空节点；TS6 的 isIdentifier 对 undefined 直接抛错，先拦掉。
    if (!node) return;
    if (ts.isIdentifier(node) && banned.has(node.text))
      found.push(`line ${lineOf(source, node)}: ${node.text}`);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.deepEqual(found, []);
});

// 合并只留下渲染处的 triggerContents 引用；定义必须唯一且是 JSX，开/关两个分支都要渲染它。
test("triggerContents is declared once as JSX and rendered in both trigger branches", async () => {
  const source = await loadComponentSource();
  let declarations = 0;
  let declarationLine = 0;
  let jsxInitializer = false;
  const references = [];
  const visit = (node) => {
    if (!node) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "triggerContents"
    ) {
      declarations += 1;
      declarationLine = lineOf(source, node);
      jsxInitializer = isJsxInitializer(node.initializer);
    }
    // 渲染处引用有两种形态：JSX 表达式 {triggerContents} 与三元分支的裸标识符；按非声明名计数。
    if (
      ts.isIdentifier(node) &&
      node.text === "triggerContents" &&
      !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)
    )
      references.push(lineOf(source, node));
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(declarations, 1, "triggerContents must be declared exactly once");
  assert.ok(jsxInitializer, "triggerContents must be declared with a JSX initializer");
  assert.deepEqual(references.length, 2, "both trigger branches must render triggerContents");
  assert.ok(
    references.every((line) => line > declarationLine),
    "triggerContents must be rendered after its declaration",
  );
});

// 触发器内容按开/关态二选一；两个分支都必须是 JSX，避免退化成字符串或第二份展示逻辑。
function isJsxInitializer(node) {
  const value = unwrapParens(node);
  if (ts.isJsxElement(value) || ts.isJsxFragment(value)) return true;
  return (
    ts.isConditionalExpression(value) &&
    isJsxInitializer(value.whenTrue) &&
    isJsxInitializer(value.whenFalse)
  );
}

function unwrapParens(node) {
  let current = node;
  while (current && ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

// 抽取生产触发器内容并用真实 React 静态渲染：调用方绑定按组件闭包变量注入。
async function loadTriggerContents(bindings) {
  const source = await loadComponentSource();
  let initializer = null;
  const visit = (node) => {
    if (!node) return;
    if (
      !initializer &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "triggerContents"
    )
      initializer = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(initializer, "triggerContents must be declared in the component");
  assert.ok(isJsxInitializer(initializer), "triggerContents must hold JSX");
  const { outputText } = ts.transpileModule(
    `const triggerContents = ${initializer.getText(source)};`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.React,
      },
    },
  );
  return new Function("React", ...Object.keys(bindings), `${outputText}\nreturn triggerContents;`)(
    React,
    ...Object.values(bindings),
  );
}

const cn = (...parts) => parts.filter(Boolean).join(" ");
const captured = { indicator: undefined, rolling: undefined };
const composerOptions = {
  selectModelLabel: "选择模型",
  levels: [
    { value: "off", label: "Off" },
    { value: "high", label: "High" },
  ],
  value: "high",
  onValueChange: () => {},
};

function stubs() {
  return {
    PackageIcon: () => React.createElement("svg", { "data-icon": "package" }),
    LoaderIcon: () => React.createElement("svg", { "data-icon": "loader" }),
    ChevronDownIcon: () => React.createElement("svg", { "data-icon": "chevron" }),
    RollingToolbarLabel: (props) => {
      captured.rolling = props;
      return React.createElement("span", { "data-rolling-label": "" }, props.label);
    },
    ComposerThoughtIndicator: (props) => {
      captured.indicator = props;
      const current = props.options?.levels?.find((level) => level.value === props.options?.value);
      return React.createElement("span", {
        "data-composer-thought-label": current?.label ?? "—",
      });
    },
  };
}

function triggerBindings(overrides = {}) {
  return {
    ...stubs(),
    cn,
    showSelectionLabel: false,
    composerOptions,
    hasSelectedModel: true,
    currentTriggerLabel: "model-b",
    currentTriggerTitle: "model-b",
    triggerLabelClassName: "trigger-label",
    triggerIconClassName: "icon-only-hidden",
    indicatorClassName: "indicator",
    pending: false,
    triggerLabelPrefix: "fixture-api",
    triggerLabelPrefixClassName: "prefix",
    triggerLabelValue: "model-b",
    triggerBadge: null,
    triggerIcon: undefined,
    ...overrides,
  };
}

test("the closed composer trigger keeps the model label and the fork effort indicator", async () => {
  captured.indicator = undefined;
  captured.rolling = undefined;
  const markup = renderToStaticMarkup(await loadTriggerContents(triggerBindings()));
  assert.match(markup, /data-rolling-label/);
  assert.match(markup, />model-b</);
  assert.match(markup, /data-composer-thought-label="High"/);
  // 开态「选择模型」文案只在展开时替换模型名。
  assert.doesNotMatch(markup, /选择模型/);
  // 本 fork 的 ComposerThoughtIndicator 只收 options；官方 highspeed 购买态不得回流。
  assert.deepEqual(Object.keys(captured.indicator ?? {}), ["options"]);
  assert.equal(captured.rolling?.label, "model-b");
  assert.equal(captured.rolling?.prefix, "fixture-api");
  assert.equal(captured.rolling?.value, "model-b");
});

test("the legacy non-composer trigger keeps icon, label and chevron without an effort row", async () => {
  const markup = renderToStaticMarkup(
    await loadTriggerContents(triggerBindings({ composerOptions: undefined })),
  );
  assert.match(markup, /data-icon="package"/);
  assert.match(markup, /data-rolling-label/);
  assert.match(markup, /data-icon="chevron"/);
  assert.doesNotMatch(markup, /data-composer-thought-label/);
});

test("a pending catalog shows the loader and drops the rolling prefix and value", async () => {
  const markup = renderToStaticMarkup(
    await loadTriggerContents(triggerBindings({ pending: true, currentTriggerLabel: "加载中" })),
  );
  assert.match(markup, /data-icon="loader"/);
  assert.doesNotMatch(markup, /data-icon="chevron"/);
  assert.equal(captured.rolling?.label, "加载中");
  assert.equal(captured.rolling?.prefix, undefined);
  assert.equal(captured.rolling?.value, undefined);
});

test("the open trigger swaps the model name for the select-model label", async () => {
  const markup = renderToStaticMarkup(
    await loadTriggerContents(triggerBindings({ showSelectionLabel: true })),
  );
  assert.match(markup, /data-composer-open-label/);
  assert.match(markup, />选择模型</);
  assert.doesNotMatch(markup, /data-rolling-label/);
  assert.match(markup, /data-composer-open-thought/);
  assert.match(markup, /data-icon="package"/);
});

// 目录未解析或模型无档位时不制造「—」伪档位：空态既不显示绿条也不显示横线。
test("an empty level catalog does not manufacture a dash effort row", async () => {
  const emptyLevels = { ...composerOptions, levels: [], value: "" };
  const openMarkup = renderToStaticMarkup(
    await loadTriggerContents(
      triggerBindings({ showSelectionLabel: true, composerOptions: emptyLevels }),
    ),
  );
  assert.match(openMarkup, /data-composer-open-label/);
  assert.doesNotMatch(openMarkup, /data-composer-open-thought/);
  const closedMarkup = renderToStaticMarkup(
    await loadTriggerContents(triggerBindings({ composerOptions: emptyLevels })),
  );
  assert.doesNotMatch(closedMarkup, /data-composer-thought-label/);
});

test("a trigger badge stays after the effort indicator", async () => {
  const badge = React.createElement("span", { "data-trigger-badge": "" }, "会话模型");
  const markup = renderToStaticMarkup(
    await loadTriggerContents(triggerBindings({ triggerBadge: badge })),
  );
  assert.match(markup, /data-trigger-badge/);
  assert.ok(
    markup.indexOf("data-composer-thought-label") < markup.indexOf("data-trigger-badge"),
    "badge must follow the effort indicator",
  );
});

// 分组分隔与选中判定驱动合并菜单的 family 连接组布局，抽取消息类生产函数直接执行。
async function loadPureFunctions() {
  const source = await loadComponentSource();
  const wanted = [
    "isFamilyConnectionGroup",
    "shouldRenderModelGroupSeparator",
    "isModelSelectGroupSelected",
    "shouldShowModelProviderLevel",
    "getModelTriggerLabelClassName",
  ];
  const chunks = [];
  for (const statement of source.statements) {
    const name = ts.isFunctionDeclaration(statement) ? statement.name?.getText(source) : undefined;
    if (name && wanted.includes(name))
      chunks.push(statement.getText(source).replace(/^export\s+/, ""));
  }
  assert.equal(chunks.length, wanted.length, `expected ${wanted.length} pure functions`);
  const { outputText } = ts.transpileModule(chunks.join("\n\n"), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  });
  return new Function("cn", `${outputText}\nreturn { ${wanted.join(", ")} };`)(cn);
}

test("group separator and selection helpers keep the merged family-connection semantics", async () => {
  const fns = await loadPureFunctions();
  assert.equal(fns.shouldShowModelProviderLevel([]), false);
  assert.equal(fns.shouldShowModelProviderLevel([{ key: "p", label: "P", items: [] }]), true);
  // 首段之前不画线；两个普通 provider 之间也不画。
  assert.equal(fns.shouldRenderModelGroupSeparator(undefined, { key: "p", label: "P" }), false);
  assert.equal(
    fns.shouldRenderModelGroupSeparator({ key: "p", label: "P" }, { key: "q", label: "Q" }),
    false,
  );
  // family 连接组出现在任一侧都要分隔。
  assert.equal(
    fns.shouldRenderModelGroupSeparator({ key: "family:a", label: "A" }, { key: "p", label: "P" }),
    true,
  );
  assert.equal(
    fns.shouldRenderModelGroupSeparator({ key: "p", label: "P" }, { key: "family:b", label: "B" }),
    true,
  );
  assert.equal(
    fns.shouldRenderModelGroupSeparator(
      { key: "p", label: "P", labelBadge: "API" },
      { key: "q", label: "Q" },
    ),
    true,
  );
  assert.equal(
    fns.shouldRenderModelGroupSeparator(
      { key: "p", label: "P" },
      { key: "q", label: "Q", connectionOptions: [] },
    ),
    false,
  );
  assert.equal(
    fns.shouldRenderModelGroupSeparator(
      { key: "p", label: "P" },
      { key: "q", label: "Q", connectionOptions: [{ key: "oauth" }] },
    ),
    true,
  );
  assert.equal(fns.isModelSelectGroupSelected({ items: [{ value: "a" }] }, "a"), true);
  assert.equal(fns.isModelSelectGroupSelected({ items: [{ value: "a" }] }, "b"), false);
  assert.equal(
    fns.getModelTriggerLabelClassName({
      labelVisibilityClassName: "hidden",
      triggerLabelClassName: "custom",
    }),
    "custom",
  );
  assert.equal(
    fns.getModelTriggerLabelClassName({ labelVisibilityClassName: "hidden" }),
    "min-w-0 text-left hidden",
  );
});

// 修复依据：本 fork 合同用 pending 表达「目录未解析」，没有 providerMenu；冻结旧选择属于官方账号刷新语义。
test("the fork composer model contract exposes pending instead of providerMenu", async () => {
  const text = await readFile(menuUrl, "utf8");
  const source = ts.createSourceFile(
    "ComposerModelMenu.tsx",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const declaration = source.statements.find(
    (node) => ts.isInterfaceDeclaration(node) && node.name.text === "ComposerModelOptions",
  );
  assert.ok(declaration, "ComposerModelOptions must exist");
  const members = declaration.members.map((member) => member.name?.getText(source));
  assert.ok(!members.includes("providerMenu"), "本 fork 不保留官方 providerMenu 云入口");
  assert.ok(members.includes("pending"), "目录未解析用 pending 表达，不冻结旧选择");
});
