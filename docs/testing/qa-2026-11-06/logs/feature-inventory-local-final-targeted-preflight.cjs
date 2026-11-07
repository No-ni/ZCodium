"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "../../../..");
const runtime = path.join(root, `docs/testing/qa-2026-11-06/runtime/qa-final-targeted-static-${process.pid}-${Date.now()}`);
const output = path.join(__dirname, "feature-inventory-local-final-targeted-preflight.json");
const sourceNames = ["qa-runtime-copy-find-20261106.test.ts", "qa-historical-trajectory-20261106.test.ts", "qa-residual-local-menus-20261106.test.ts", "qa-final-local-gaps-20261106.test.ts"];
const sources = sourceNames.map(name => path.join(root, "docs/testing/qa-2026-11-06/manual-review/pending", name));
const helpers = ["qa-menu-dom.ts", "qa-preview-dom.ts", "qa-local-rpc-probe.ts"].map(name => path.join(root, "docs/testing/qa-2026-11-06", name));
const fixtures = [path.join(root, "packages/desktop/test/e2e/fixtures/upstream/common.json"), path.join(root, "packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-chat-find-refocus.json"), path.join(root, "docs/testing/qa-2026-11-06/fixtures/qa-runtime-copy-find-title.json")];
const approvedFixtureHashes = ["60f4898eb393afc84f86d9d492af910928658a954b1a777d7d5d5cb537033210", "923ba7e0bd67592b79ee3b5c2eca589f81ba6fa578d6c3598ab9cd01b417e50b", "742c1eb7c965f428eb95709ec7ec8e3619bc2dc37b2be5b00ea6390c62c75631"];
const guard = path.join(root, "docs/testing/qa-2026-11-06/qa-reparse-children.ps1");
function safe(file) {
  const absolute = path.resolve(file);
  if (!absolute.startsWith(root + path.sep)) throw new Error("Static path escapes worktree");
  for (let current = absolute; ; current = path.dirname(current)) {
    if (fs.existsSync(current) && (fs.lstatSync(current).isSymbolicLink() || fs.realpathSync.native(current).toLowerCase() !== current.toLowerCase())) throw new Error("Static redirected ancestor");
    if (current.toLowerCase() === root.toLowerCase()) break;
  }
  return absolute;
}
for (const file of [runtime, output, guard, ...sources, ...helpers, ...fixtures]) safe(file);
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
fixtures.forEach((file, index) => { if (hash(file) !== approvedFixtureHashes[index]) throw new Error("Finite fixture changed"); });
const audit = fs.readFileSync(guard, "utf8") + "\n$ErrorActionPreference='Stop';$target=$env:QA_FINAL_STATIC_TARGET;if(Test-Path -LiteralPath $target){$queue=[Collections.Generic.Queue[string]]::new();$queue.Enqueue($target);while($queue.Count){foreach($item in Get-QaAuditChildren $queue.Dequeue()){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Static reparse descendant'};if($item.PSIsContainer){$queue.Enqueue($item.FullName)}}}}";
execFileSync("C:\\Program Files\\PowerShell\\7\\pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", audit], { env: { ...process.env, QA_FINAL_STATIC_TARGET: runtime, QA_REPARSE_WORKTREE: root }, windowsHide: true, stdio: "pipe", timeout: 30000 });
fs.mkdirSync(runtime);
const home = path.join(runtime, ".e2e-home-static");
for (const name of ["HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "APPDATA", "LOCALAPPDATA", "COREPACK_HOME", "PNPM_HOME", "npm_config_cache", "npm_config_store_dir", "npm_config_userconfig", "TSX_CACHE_DIR", "NODE_COMPILE_CACHE", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "ZCODE_E2E_HOME_DIR", "ZCODE_E2E_ARTIFACT_DIR"]) {
  const target = safe(["HOME", "USERPROFILE", "ZCODE_E2E_HOME_DIR"].includes(name) ? home : path.join(runtime, name.toLowerCase()));
  process.env[name] = target;
  if (name === "npm_config_userconfig") fs.writeFileSync(target, "", { flag: "wx" }); else fs.mkdirSync(target, { recursive: true });
}
process.env.NODE_OPTIONS = "";
process.env.E2E_PROVIDER_HTTP_MODE = "replay";
process.env.ZCODE_E2E_MANUAL_REVIEW = "1";
const ts = require("typescript");
const configPath = path.join(root, "docs/testing/qa-2026-11-06/tsconfig.qa.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
const options = { ...parsed.options, rootDir: root, noEmit: true, composite: false, incremental: false };
delete options.tsBuildInfoFile;
const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames, options)).map(item => ({ file: item.file?.fileName ?? null, code: item.code, message: ts.flattenDiagnosticMessageText(item.messageText, "\n") }));
const esbuild = createRequire(require.resolve("tsx/esm/api"))("esbuild");
const rawErrors = [], closureErrors = [], callbacks = [], scripts = [];
for (const file of [...sources, ...helpers]) {
  const ast = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "browser.execute" && node.arguments[0]) {
      const argument = node.arguments[0];
      if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
        scripts.push({ file, line: ast.getLineAndCharacterOfPosition(argument.getStart(ast)).line + 1 });
        try { new vm.Script("(function(){" + argument.text + "})"); } catch (error) { rawErrors.push({ file, message: error.message }); }
      } else if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
        callbacks.push({ file, line: ast.getLineAndCharacterOfPosition(argument.getStart(ast)).line + 1 });
        const compiled = esbuild.transformSync("module.exports=(" + argument.getText(ast) + ");", { loader: "ts", target: "es2022", keepNames: true }).code;
        const context = { module: { exports: null } };
        vm.runInNewContext(compiled, context);
        if (/__name\d*\(/u.test(context.module.exports.toString())) closureErrors.push({ file });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
}
const registered = [], hooks = [], stack = [];
let currentFile;
globalThis.describe = (title, callback) => { stack.push(title); try { callback(); } finally { stack.pop(); } };
globalThis.it = title => registered.push({ file: currentFile, title, fullTitle: [...stack, title].join(" ") });
for (const kind of ["before", "after", "beforeEach", "afterEach"]) globalThis[kind] = () => hooks.push({ file: currentFile, kind });
globalThis.browser = new Proxy({}, { get() { throw new Error("Static registration forbids UI"); } });
const grep = "(?:^| )(?:RFC01:|HIST0[12]:|RLM-05:|FLG0[45]:)";
const result = { capturedAt: new Date().toISOString(), evidenceKind: "QA noEmit/rawJS/keepNames/lint and real Mocha fullTitle registration only; no UI/hooks/Host/Provider/build/task/history", diagnostics, sources: [...sources, ...helpers, guard].map(file => ({ file, sha256: hash(file) })), fixtures: fixtures.map(file => ({ file, sha256: hash(file) })), callbacks, scripts, rawErrors, closureErrors, registered, hooks, grep };
(async () => {
  const { tsImport } = require("tsx/esm/api");
  for (const file of sources) { currentFile = file; await tsImport(pathToFileURL(file).href, { parentURL: pathToFileURL(__filename).href, tsconfig: path.join(root, "packages/desktop/tsconfig.e2e.json") }); }
  const filter = new RegExp(grep, "u");
  result.selected = registered.filter(item => filter.test(item.fullTitle));
  result.excluded = registered.filter(item => !filter.test(item.fullTitle));
  result.sourceCounts = sources.map((file, index) => ({ file, expected: [1, 2, 1, 2][index], actual: result.selected.filter(item => item.file === file).length }));
  const lintCommand = [path.join(path.dirname(require.resolve("oxlint/package.json")), "bin/oxlint"), "--deny-warnings", "--no-ignore", ...sources, ...helpers];
  try { result.lint = { exitCode: 0, output: execFileSync(process.execPath, lintCommand, { cwd: root, env: process.env, windowsHide: true, encoding: "utf8" }).trim() }; }
  catch (error) { result.lint = { exitCode: error.status ?? 1, output: String(error.stdout ?? "") + String(error.stderr ?? "") }; }
  result.accepted = !diagnostics.length && !rawErrors.length && !closureErrors.length && result.lint.exitCode === 0 && result.selected.length === 6 && result.sourceCounts.every(item => item.actual === item.expected);
  if (result.accepted) {
    const relative = file => path.relative(path.join(root, "packages/desktop"), file).split(path.sep).join("/");
    const parameters = { RunId: "qa-menu-20261106-local-final-targeted", Specs: sources.map(relative), Grep: grep, ReplayFixtures: fixtures.map(relative).join(","), Bootstrap: true, OpenSidePane: false, SafeTerminal: false, SafeGit: false, selected: 6, sourceEvidence: output };
    result.parameters = path.join(__dirname, "feature-inventory-local-final-targeted-parameters.json");
    fs.writeFileSync(safe(result.parameters), JSON.stringify(parameters, null, 2) + "\n");
  }
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ output, accepted: result.accepted, diagnostics: diagnostics.length, selected: result.selected, excluded: result.excluded.length, callbacks: callbacks.length, scripts: scripts.length, rawErrors: rawErrors.length, closureErrors: closureErrors.length, lint: result.lint }));
  if (!result.accepted) process.exitCode = 1;
})().catch(error => { result.accepted = false; result.error = error.stack; fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n"); console.error(error.stack); process.exitCode = 1; });
