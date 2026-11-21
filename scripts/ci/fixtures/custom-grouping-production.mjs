import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// 使用生产 memo 和消费表达式，测试设置更新后的实际失效，避免在夹具里复制传递逻辑。
export async function groupingProductionModule() {
  async function parse(path) {
    const text = await readFile(new URL(`../../../${path}`, import.meta.url), "utf8");
    return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  }
  function declarations(source) {
    const result = new Map();
    function visit(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const list = result.get(node.name.text) ?? [];
        list.push(node);
        result.set(node.name.text, list);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    return result;
  }
  const pane = await parse("packages/ui/src/v4/SessionPane.tsx");
  const group = await parse("packages/ui/src/v4/ConversationTurnGroup.tsx");
  const paneDeclarations = declarations(pane);
  const rowContext = paneDeclarations.get("rowContext");
  const items = declarations(group)
    .get("items")
    ?.filter((node) => node.initializer?.getText(group).startsWith("useMemo("));
  assert.equal(rowContext?.length, 1);
  assert.equal(items?.length, 1);
  const selected = [...paneDeclarations].filter(
    ([name]) =>
      name.startsWith("toolGrouping") ||
      ["messageStreamShowReasoning", "messageStreamShowTodos"].includes(name),
  );
  const locals = new Set(selected.map(([name]) => name));
  const dependencies = new Set();
  function visitDependency(node) {
    if (ts.isIdentifier(node)) dependencies.add(node.text);
    ts.forEachChild(node, visitDependency);
  }
  visitDependency(rowContext[0].initializer.arguments[1]);
  visitDependency(rowContext[0].initializer.arguments[0]);
  for (const name of ["undefined", "resolveWorkflowResumeHandler", "sharedSettings", ...locals])
    dependencies.delete(name);
  const code = `
    import { useMemo } from "react";
    import { buildAssistantWorkRenderItems, ENABLE_CUA_TOOL_CALL_GROUPING, ENABLE_EXPLORE_TOOL_CALL_GROUPING, ENABLE_TERMINAL_TOOL_CALL_GROUPING, ENABLE_CHANGES_TOOL_CALL_GROUPING } from "/packages/ui/src/v4/conversationAssistantWorkItems.ts";
    ${[...dependencies].map((name) => `const ${name} = undefined;`).join("\n")}
    const resolveWorkflowResumeHandler = () => undefined;
    export function useProductionGrouping(sharedSettings, rows) {
      ${selected.map(([, nodes]) => `const ${nodes[0].getText(pane)};`).join("\n")}
      const ${rowContext[0].getText(pane)};
      const context = rowContext;
      const showReasoning = context.messageStreamShowReasoning === true;
      const firstReasoningRowId = context.messageStreamFirstReasoningRowId;
      const stageTailIsRunning = false;
      const ${items[0].getText(group)};
      return { context, items };
    }`;
  return ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
}
