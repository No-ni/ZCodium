import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const documentation =
  "https://github.com/No-ni/ZCodium/blob/main/docs/specs/native-context-compression.md";
const sourceText = await readFile(
  new URL(
    "../../packages/ui/src/native-context-compression/ui/NativeContextAttribution.tsx",
    import.meta.url,
  ),
  "utf8",
);
const source = ts.createSourceFile(
  "attribution.tsx",
  sourceText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const declarations = source.statements
  .filter((node) => !ts.isImportDeclaration(node))
  .map((node) => node.getText(source))
  .join("\n");
const compiled = ts.transpileModule(declarations, {
  compilerOptions: {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;
const createComponent = new Function("exports", "require", "usePlatform", "useZCodeIntl", compiled);
const require = createRequire(import.meta.url);

function renderAttribution() {
  const opened = [];
  const exports = {};
  createComponent(
    exports,
    require,
    () => ({ openExternal: (url) => opened.push(url) }),
    () => ({ intl: { formatMessage: ({ id }) => id } }),
  );
  const anchors = [];
  function visit(element) {
    if (Array.isArray(element)) return element.forEach(visit);
    if (!element || typeof element !== "object") return;
    if (element.type === "a") anchors.push(element);
    visit(element.props?.children);
  }
  visit(exports.NativeContextAttribution());
  return { anchors, opened };
}

test("实际署名组件的三个入口指向本仓存在的产品文档章节", async () => {
  const { anchors } = renderAttribution();
  assert.deepEqual(
    anchors.map((anchor) => [anchor.props["data-testid"], anchor.props.href]),
    [
      ["native-context-feature-documentation", documentation],
      ["native-context-attribution-kernel", documentation + "#acp-kernel"],
      ["native-context-attribution-project", documentation + "#billion-context"],
    ],
  );
  const text = (
    await readFile(
      new URL("../../docs/specs/native-context-compression.md", import.meta.url),
      "utf8",
    )
  ).replace(/\r\n/g, "\n");
  for (const name of ["acp-kernel", "billion-context"]) {
    const chapter = text.split("### " + name + "\n")[1]?.split(/\n#{2,3} /)[0];
    assert.ok(chapter, "产品链接必须有对应署名章节");
    assert.ok(chapter.includes("ZCodium"));
    assert.ok(chapter.includes("使用"));
    assert.ok(chapter.includes("ranxianglei"));
    assert.ok(chapter.includes(`https://github.com/ranxianglei/${name}`));
  }
});

test("实际署名点击通过平台公开入口打开文档且保持项目名称", () => {
  const { anchors, opened } = renderAttribution();
  assert.deepEqual(
    anchors.slice(1).map((anchor) => anchor.props.children),
    ["acp-kernel", "billion-context"],
  );
  let prevented = 0;
  for (const anchor of anchors) anchor.props.onClick({ preventDefault: () => prevented++ });
  assert.equal(prevented, 3);
  assert.deepEqual(
    opened,
    anchors.map((anchor) => anchor.props.href),
  );
});
