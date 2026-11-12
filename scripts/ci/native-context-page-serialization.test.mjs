import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { tsImport } from "tsx/esm/api";
import { assertProjectPath, projectRoot } from "./project-test-sandbox.mjs";

import {
  createPageSerializationWindow,
  assertPageSerializationResult,
} from "./fixtures/native-context-page-serialization.mjs";

assert.equal(process.version, "v24.14.0");
const sandbox = await assertProjectPath(process.env.PROJECT_TEST_SANDBOX_ROOT);
const e2eRoot = join(projectRoot, "packages/desktop/test/e2e");
const suite = join(
  e2eRoot,
  "conversation-session/manual-review/pending/conversation-session-native-context-compression.test.ts",
);
const hash = (data) => createHash("sha256").update(data).digest("hex");
const modules = new Map();
async function resolveImport(file, specifier) {
  const root = specifier.startsWith("#e2e/")
    ? join(e2eRoot, specifier.slice(5))
    : specifier.startsWith(".")
      ? resolve(dirname(file), specifier)
      : null;
  if (!root || (!root.startsWith(e2eRoot + "/") && !root.startsWith(e2eRoot + "\\"))) return null;
  const stem = root.replace(/\.[cm]?js$/u, "");
  for (const path of [root, `${stem}.ts`, `${stem}.tsx`, `${stem}.mjs`, join(root, "index.ts")]) {
    try {
      await access(await assertProjectPath(path));
      return path;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
  }
  return null;
}
async function visitModule(file) {
  if (modules.has(file)) return;
  const text = await readFile(await assertProjectPath(file), "utf8");
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const module = { file, text, ast, imports: new Map(), exports: [], definitions: new Map() };
  modules.set(file, module);
  const edges = [];
  for (const statement of ast.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body)
      module.definitions.set(statement.name.text, statement);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name) && declaration.initializer)
          module.definitions.set(declaration.name.text, declaration.initializer);
    }
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      !statement.isTypeOnly &&
      !statement.importClause?.isTypeOnly
    ) {
      const dependency = await resolveImport(file, statement.moduleSpecifier.text);
      if (!dependency) continue;
      edges.push(dependency);
      if (
        ts.isImportDeclaration(statement) &&
        statement.importClause?.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings)
      ) {
        for (const binding of statement.importClause.namedBindings.elements)
          if (!binding.isTypeOnly)
            module.imports.set(binding.name.text, {
              file: dependency,
              name: binding.propertyName?.text ?? binding.name.text,
            });
      }
      if (ts.isExportDeclaration(statement)) module.exports.push(dependency);
    }
  }
  for (const dependency of edges) await visitModule(dependency);
}
await visitModule(suite);
function resolveDefinition(module, name, seen = new Set()) {
  const key = `${module.file}:${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const node = module.definitions.get(name);
  if (
    node &&
    (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node))
  )
    return { module, node, name };
  const imported = module.imports.get(name);
  if (imported) return resolveDefinition(modules.get(imported.file), imported.name, seen);
  for (const path of module.exports) {
    const found = resolveDefinition(modules.get(path), name, seen);
    if (found) return found;
  }
  return null;
}
const transfers = [];
for (const module of modules.values()) {
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["evaluate", "waitForFunction"].includes(node.expression.name.text) &&
      node.arguments[0]
    ) {
      const argument = node.arguments[0];
      const definition = ts.isIdentifier(argument)
        ? resolveDefinition(module, argument.text)
        : ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)
          ? { module, node: argument, name: "inline" }
          : null;
      transfers.push({
        file: relative(projectRoot, module.file).replaceAll("\\", "/"),
        line: module.ast.getLineAndCharacterOfPosition(node.getStart(module.ast)).line + 1,
        method: node.expression.name.text,
        callback: ts.isIdentifier(argument)
          ? argument.text
          : definition
            ? "inline"
            : "non-function",
        definition,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(module.ast);
}
const unique = [];
for (const transfer of transfers) {
  if (!transfer.definition) continue;
  const { module, node } = transfer.definition;
  const key = `${module.file}:${node.getStart(module.ast)}`;
  let index = unique.findIndex((entry) => entry.key === key);
  if (index === -1) {
    index = unique.length;
    unique.push({ key, ...transfer.definition });
  }
  transfer.index = index;
}
const expressions = unique.map(({ module, node }) =>
  node.getText(module.ast).replace(/^export\s+/u, ""),
);
const payloadPath = await assertProjectPath(join(sandbox, "actual-callbacks.ts"));
await writeFile(
  payloadPath,
  expressions
    .map((expression, index) => `export const transfer_${index} = ${expression};`)
    .join("\n"),
);
// 使用实际 WDIO 依赖的 tsx/esbuild keepNames 转译；不以 tsc 无装饰转译来冒充页面传输。
const loaded = await tsImport(pathToFileURL(payloadPath).href, { parentURL: import.meta.url });
for (let index = 0; index < unique.length; index += 1) {
  const body = loaded[`transfer_${index}`].toString();
  unique[index].body = body;
  unique[index].moduleNameReferences = [...body.matchAll(/\b__name\s*\(/gu)].length;
  await writeFile(await assertProjectPath(join(sandbox, `callback-${index}.js`)), body);
}
const inventory = transfers.map(({ definition, index, ...entry }) => ({
  ...entry,
  resolved: Boolean(definition),
  definitionFile: definition
    ? relative(projectRoot, definition.module.file).replaceAll("\\", "/")
    : null,
  definitionLine: definition
    ? definition.module.ast.getLineAndCharacterOfPosition(
        definition.node.getStart(definition.module.ast),
      ).line + 1
    : null,
  moduleNameReferences: index === undefined ? null : unique[index].moduleNameReferences,
  functionSha256: index === undefined ? null : hash(unique[index].body),
}));
const tsxPackage = JSON.parse(
  await readFile(join(projectRoot, "node_modules/tsx/package.json"), "utf8"),
);
const keepNamesEvidence = [];
for (const file of await readdir(join(projectRoot, "node_modules/tsx/dist"))) {
  if (!file.startsWith("index-") || !file.endsWith(".mjs")) continue;
  const text = await readFile(join(projectRoot, "node_modules/tsx/dist", file), "utf8");
  const match = text.match(/keepNames\s*:\s*(?:true|!0)/u);
  if (match) keepNamesEvidence.push({ file, sha256: hash(text), setting: match[0] });
}
assert.ok(keepNamesEvidence.length > 0, "Actual tsx keepNames setting must be verified");
const report = {
  node: process.version,
  tsxVersion: tsxPackage.version,
  keepNamesEvidence,
  modules: [...modules.values()].map(({ file, text }) => ({
    file: relative(projectRoot, file).replaceAll("\\", "/"),
    sha256: hash(text),
  })),
  callSites: inventory,
  vulnerable: inventory.filter((entry) => entry.moduleNameReferences > 0),
  probes: [],
  boundary:
    "Source callback serialization into an isolated JSDOM realm; not Playwright/browser layout or product E2E evidence",
};
await writeFile(
  await assertProjectPath(join(sandbox, "audit.json")),
  JSON.stringify(report, null, 2),
);
const probeInputs = [
  ["readTrendGeometry", undefined],
  ["readParameterGeometry", { target: "task", selector: "#target" }],
  ["readSettingsUi", '[data-testid="native-context-details"]'],
  ["readNativeContextLargeLedgerSvg", { chartId: "input-chart", series: "after" }],
  ["settingsUiSettled", { width: 390, height: 844 }],
  ["readSettingsOptions", undefined],
  ["parameterLayoutSettled", { target: "task", width: 390, height: 844 }],
];
for (const [name, input] of probeInputs) {
  test(`Transferred actual tsx callback ${name} needs no module __name`, () => {
    const entry = unique.find((candidate) => candidate.name === name);
    assert.ok(entry, `Actual callback ${name} must be inventoried`);
    const dom = createPageSerializationWindow();
    const result = { name, moduleNameReferences: entry.moduleNameReferences, ok: false };
    try {
      const callable = dom.window.eval(`(${entry.body})`);
      const value = callable(input);
      assertPageSerializationResult(name, value);
      if (name === "readTrendGeometry")
        assert.equal(
          report.vulnerable.length,
          0,
          "All suite Page callbacks must be self-contained",
        );
      result.ok = true;
      result.valueKind = Array.isArray(value) ? "array" : typeof value;
    } catch (error) {
      result.type = error.name;
      result.code =
        error.name === "ReferenceError" && String(error.message).includes("__name")
          ? "module-name-unavailable"
          : "other-source-error";
    } finally {
      report.probes.push(result);
      dom.window.close();
    }
    assert.equal(result.ok, true, `${name}: ${result.code ?? "unknown"}/${result.type ?? "none"}`);
  });
}
test.after(async () => {
  await writeFile(
    await assertProjectPath(join(sandbox, "audit.json")),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      modules: modules.size,
      callSites: transfers.length,
      distinctCallbacks: unique.length,
      vulnerable: report.vulnerable.map(({ file, line, callback, definitionFile }) => ({
        file,
        line,
        callback,
        definitionFile,
      })),
      probes: report.probes,
      evidence: join(sandbox, "audit.json"),
    }),
  );
});
