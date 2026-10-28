import { readFile } from "node:fs/promises";
import ts from "typescript";

const DECLARATIONS = new Set([
  "shareRows",
  "shareRenderUnits",
  "shareItems",
  "eligibleShareItems",
  "eligibleShareRowIds",
  "eligibleShareProductTurnIds",
]);

/** 读取当前组件的实际声明；删除门禁后预算必须变红，不能只测试独立复制的优化。 */
export async function readShareDerivationBody(): Promise<string> {
  const source = await readFile(new URL("../src/v4/SessionPane.tsx", import.meta.url), "utf8");
  const file = ts.createSourceFile(
    "SessionPane.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const statements: string[] = [];
  const found = new Set<string>();
  function visit(node: ts.Node): void {
    if (ts.isVariableStatement(node)) {
      const declarations = node.declarationList.declarations;
      const name =
        declarations.length === 1 && ts.isIdentifier(declarations[0]!.name)
          ? declarations[0]!.name.text
          : null;
      if (name && DECLARATIONS.has(name)) {
        found.add(name);
        statements.push(node.getText(file));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  for (const name of DECLARATIONS) {
    if (name !== "shareRows" && !found.has(name))
      throw new Error(`Missing share declaration: ${name}`);
  }
  return ts.transpileModule(
    `${statements.join("\n")}\nreturn { shareRenderUnits, shareItems, eligibleShareItems, eligibleShareRowIds, eligibleShareProductTurnIds };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
  ).outputText;
}
