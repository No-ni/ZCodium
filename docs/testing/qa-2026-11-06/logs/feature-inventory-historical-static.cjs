"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "../../../..");
const runtime = path.join(root, "docs/testing/qa-2026-11-06/runtime/qa-historical-static");
const source = path.join(
  root,
  "docs/testing/qa-2026-11-06/manual-review/pending/qa-historical-trajectory-20261106.test.ts",
);
const helper = path.join(root, "docs/testing/qa-2026-11-06/qa-menu-dom.ts");
const guard = path.join(root, "docs/testing/qa-2026-11-06/qa-reparse-children.ps1");
const output = path.join(__dirname, "feature-inventory-historical-static.json");
for (const target of [runtime, source, helper, guard, output]) {
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel))
    throw new Error("HIST static outside worktree");
  for (let cursor = target; ; cursor = path.dirname(cursor)) {
    if (
      fs.existsSync(cursor) &&
      (fs.lstatSync(cursor).isSymbolicLink() ||
        fs.realpathSync.native(cursor).toLowerCase() !== cursor.toLowerCase())
    )
      throw new Error("HIST static redirected path");
    if (cursor.toLowerCase() === root.toLowerCase()) break;
  }
}
const script =
  fs.readFileSync(guard, "utf8") +
  "\n$ErrorActionPreference='Stop';$target=$env:HIST_STATIC_TARGET;if(Test-Path -LiteralPath $target){$queue=[Collections.Generic.Queue[string]]::new();$queue.Enqueue($target);while($queue.Count){foreach($item in Get-QaAuditChildren $queue.Dequeue()){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'HIST static reparse descendant'};if($item.PSIsContainer){$queue.Enqueue($item.FullName)}}}}";
execFileSync(
  "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  ["-NoProfile", "-NonInteractive", "-Command", script],
  {
    env: {
      ...process.env,
      HIST_STATIC_TARGET: runtime,
      QA_REPARSE_WORKTREE: root,
    },
    windowsHide: true,
    stdio: "pipe",
    timeout: 30_000,
  },
);
const home = path.join(runtime, ".e2e-home-static");
for (const key of [
  "HOME",
  "USERPROFILE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "COREPACK_HOME",
  "PNPM_HOME",
  "npm_config_cache",
  "npm_config_store_dir",
  "npm_config_userconfig",
  "TSX_CACHE_DIR",
  "NODE_COMPILE_CACHE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "ZCODE_E2E_HOME_DIR",
  "ZCODE_E2E_ARTIFACT_DIR",
]) {
  process.env[key] = ["HOME", "USERPROFILE", "ZCODE_E2E_HOME_DIR"].includes(key)
    ? home
    : path.join(runtime, key.toLowerCase());
  if (key === "npm_config_userconfig") {
    fs.mkdirSync(path.dirname(process.env[key]), { recursive: true });
    fs.writeFileSync(process.env[key], "");
  } else fs.mkdirSync(process.env[key], { recursive: true });
}
process.env.E2E_PROVIDER_HTTP_MODE = "replay";
process.env.ZCODE_E2E_MANUAL_REVIEW = "1";
process.env.NODE_OPTIONS = "";
const ts = require("typescript");
const configPath = path.join(root, "docs/testing/qa-2026-11-06/tsconfig.qa.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
const options = {
  ...parsed.options,
  rootDir: root,
  composite: false,
  incremental: false,
  noEmit: true,
};
delete options.tsBuildInfoFile;
const diagnostics = ts
  .getPreEmitDiagnostics(ts.createProgram(parsed.fileNames, options))
  .map((item) => ({
    file: item.file?.fileName ?? null,
    code: item.code,
    line:
      item.file && item.start !== undefined
        ? item.file.getLineAndCharacterOfPosition(item.start).line + 1
        : null,
    message: ts.flattenDiagnosticMessageText(item.messageText, "\n"),
  }));
const esbuild = createRequire(require.resolve("tsx/esm/api"))("esbuild");
const cases = [];
const describeStack = [];
const fullTitles = [];
const hooks = [];
let ast;
let rawScripts = 0;
let callbacks = 0;
const closureErrors = [];
const rawErrors = [];
const imports = [];
function visit(node) {
  if (ts.isImportDeclaration(node)) imports.push(node.moduleSpecifier.text);
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(ast) === "browser.execute" &&
    node.arguments[0]
  ) {
    const argument = node.arguments[0];
    let scriptText;
    if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
      scriptText = argument.text;
    if (
      ts.isTaggedTemplateExpression(argument) &&
      argument.tag.getText(ast) === "String.raw" &&
      ts.isNoSubstitutionTemplateLiteral(argument.template)
    )
      scriptText = argument.template.rawText ?? argument.template.text;
    if (scriptText !== undefined) {
      rawScripts++;
      try {
        new vm.Script("(function(){" + scriptText + "})");
      } catch (error) {
        rawErrors.push({
          file: ast.fileName,
          line: ast.getLineAndCharacterOfPosition(argument.getStart(ast)).line + 1,
          message: error.message,
        });
      }
    }
    if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
      callbacks++;
      const compiled = esbuild.transformSync("module.exports=(" + argument.getText(ast) + ");", {
        loader: "ts",
        target: "es2022",
        keepNames: true,
      }).code;
      const context = { module: { exports: null } };
      vm.runInNewContext(compiled, context);
      if (/__name\d*\(/u.test(context.module.exports.toString()))
        closureErrors.push({
          file: ast.fileName,
          line: ast.getLineAndCharacterOfPosition(argument.getStart(ast)).line + 1,
        });
    }
  }
  ts.forEachChild(node, visit);
}
for (const file of [source, helper]) {
  ast = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  visit(ast);
}
globalThis.describe = (title, callback) => {
  describeStack.push(title);
  try {
    callback();
  } finally {
    describeStack.pop();
  }
};
globalThis.it = (title) => {
  cases.push(title);
  fullTitles.push([...describeStack, title].join(" "));
};
for (const kind of ["before", "after", "beforeEach", "afterEach"])
  globalThis[kind] = () => hooks.push(kind);
globalThis.browser = new Proxy(
  {},
  {
    get() {
      throw new Error("HIST static must not execute browser");
    },
  },
);
const evidence = {
  capturedAt: new Date().toISOString(),
  evidenceKind:
    "NoEmit/static parser plus actual module registration; no UI/Host/provider/build or synthetic historical data writing",
  sources: [source, helper, guard].map((file) => ({
    file,
    sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
  })),
  diagnostics,
  imports,
  cases,
  fullTitles,
  hooks,
  rawScripts,
  rawErrors,
  callbacks,
  closureErrors,
};
(async () => {
  const { tsImport } = require("tsx/esm/api");
  try {
    await tsImport(pathToFileURL(source).href, {
      parentURL: pathToFileURL(__filename).href,
      tsconfig: path.join(root, "packages/desktop/tsconfig.e2e.json"),
    });
  } catch (error) {
    evidence.importError = error.stack;
    process.exitCode = 1;
  }
  try {
    evidence.lint = {
      exitCode: 0,
      output: execFileSync(
        process.execPath,
        [
          path.join(path.dirname(require.resolve("oxlint/package.json")), "bin/oxlint"),
          "--deny-warnings",
          "--no-ignore",
          source,
          helper,
        ],
        { cwd: root, env: process.env, windowsHide: true, encoding: "utf8" },
      ).trim(),
    };
  } catch (error) {
    evidence.lint = {
      exitCode: error.status ?? 1,
      output: String(error.stdout ?? "") + String(error.stderr ?? ""),
    };
    process.exitCode = 1;
  }
  const sourceText = fs.readFileSync(source, "utf8");
  evidence.accepted =
    cases.length === 2 &&
    cases[0].startsWith("HIST01:") &&
    cases[1].startsWith("HIST02:") &&
    fullTitles.filter((title) => /(?:^| )HIST0[12]:/u.test(title)).length === 2 &&
    !imports.some((name) => name.endsWith(".test.js") || name.endsWith(".test.ts")) &&
    !/\bsendV4Prompt|\btruncate\([^3]|\brm\(/u.test(sourceText) &&
    diagnostics.length === 0 &&
    rawErrors.length === 0 &&
    closureErrors.length === 0 &&
    evidence.lint.exitCode === 0 &&
    !evidence.importError;
  fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n");
  process.stdout.write(
    JSON.stringify({
      output,
      accepted: evidence.accepted,
      diagnostics: diagnostics.length,
      cases,
      rawScripts,
      rawErrors,
      callbacks,
      closureErrors,
      lint: evidence.lint,
    }) + "\n",
  );
  if (!evidence.accepted) process.exitCode = 1;
})().catch((error) => {
  process.stderr.write(error.stack + "\n");
  process.exitCode = 1;
});
