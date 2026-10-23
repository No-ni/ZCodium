import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const directory = new URL("./", import.meta.url);
const property = (object, name) =>
  object.properties.find(
    (candidate) =>
      (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) &&
      (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) &&
      candidate.name.text === name,
  );

for (const filename of (await readdir(directory)).filter((name) =>
  name.endsWith("browser.test.mjs"),
)) {
  const source = await readFile(new URL(filename, directory), "utf8");
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const importsVite = parsed.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "vite",
  );
  if (!importsVite) continue;

  test(`${filename}: Vite dependency discovery and cache stay fixture-scoped`, () => {
    const configurations = [];
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "createServer"
      ) {
        assert.ok(ts.isObjectLiteralExpression(node.arguments[0]), "Vite options must be explicit");
        configurations.push(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    assert.ok(configurations.length > 0, "A browser regression must create its Vite fixture");
    assert.match(source, /await\s+mkdtemp\(/, "The fixture must own a temporary directory");

    if (filename === "performance-chat-code-browser.test.mjs") {
      assert.match(
        source,
        /noDiscovery:\s*true/,
        "HMR-free navigation must use stable dependencies",
      );
      assert.match(source, /["']@zcode\/ui > shiki["']/, "Keep the UI's nested Shiki version");
      assert.doesNotMatch(
        source,
        /["']shiki["']/,
        "A root Shiki entry would shadow the UI version",
      );
      assert.match(source, /include:\s*\[[\s\S]*?["']react-dom\/client["']/);
    }

    for (const configuration of configurations) {
      assert.ok(property(configuration, "cacheDir"), "The Vite cache must not use the repository");
      const optimization = property(configuration, "optimizeDeps");
      assert.ok(
        optimization &&
          ts.isPropertyAssignment(optimization) &&
          ts.isObjectLiteralExpression(optimization.initializer),
        "The fixture must declare its dependency discovery boundary",
      );
      const options = optimization.initializer;
      const noDiscovery = property(options, "noDiscovery");
      const entries = property(options, "entries");
      assert.ok(
        (noDiscovery &&
          ts.isPropertyAssignment(noDiscovery) &&
          noDiscovery.initializer.kind === ts.SyntaxKind.TrueKeyword) ||
          (entries &&
            ts.isPropertyAssignment(entries) &&
            ts.isArrayLiteralExpression(entries.initializer) &&
            entries.initializer.elements.length > 0),
        "Vite must scan explicit fixture entries or disable automatic discovery",
      );
    }
  });
}
