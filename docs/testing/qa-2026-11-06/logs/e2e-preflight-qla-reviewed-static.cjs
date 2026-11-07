"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const vm = require("node:vm");
const repository = path.resolve(__dirname, "../../../..");
const runtime = path.join(repository, "docs/testing/qa-2026-11-06/runtime/qa-qla-reviewed-static");
const source = path.join(repository, "docs/testing/qa-2026-11-06/manual-review/pending/qa-local-menu-actions-20261106.test.ts");
const helper = path.join(repository, "docs/testing/qa-2026-11-06/qa-menu-dom.ts");
function safe(candidate) {
  const target = path.resolve(candidate);
  if (!target.startsWith(repository + path.sep)) throw new Error("QLA static path escapes worktree");
  for (let cursor = target; ; cursor = path.dirname(cursor)) {
    if (fs.existsSync(cursor) && (fs.lstatSync(cursor).isSymbolicLink() || fs.realpathSync.native(cursor).toLowerCase() !== cursor.toLowerCase())) throw new Error("QLA static refuses links or redirected ancestors");
    if (cursor === path.dirname(cursor)) break;
  }
  return target;
}
for (const name of ["HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "APPDATA", "LOCALAPPDATA", "COREPACK_HOME", "PNPM_HOME", "npm_config_cache", "npm_config_store_dir", "npm_config_userconfig", "TSX_CACHE_DIR", "NODE_COMPILE_CACHE", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "ZCODE_E2E_HOME_DIR", "ZCODE_E2E_ARTIFACT_DIR", "PSModuleAnalysisCachePath"]) {
  const target = safe(path.join(runtime, name.toLowerCase()));
  process.env[name] = target;
  if (name === "npm_config_userconfig") { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, ""); }
  else fs.mkdirSync(target, { recursive: true });
}
process.env.NODE_OPTIONS = "";
process.env.E2E_PROVIDER_HTTP_MODE = "replay";
process.env.ZCODE_E2E_MANUAL_REVIEW = "1";
const guard = safe(path.join(repository, "docs/testing/qa-2026-11-06/qa-reparse-children.ps1"));
const audit = fs.readFileSync(guard, "utf8") + "\n$ErrorActionPreference='Stop';$queue=[Collections.Generic.Queue[string]]::new();$queue.Enqueue($env:QLA_STATIC_ROOT);while($queue.Count){foreach($item in Get-QaAuditChildren $queue.Dequeue()){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'QLA static descendant reparse'};if($item.PSIsContainer){$queue.Enqueue($item.FullName)}}}";
execFileSync("C:\\Program Files\\PowerShell\\7\\pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", audit], { env: { ...process.env, QLA_STATIC_ROOT: runtime, QA_REPARSE_WORKTREE: repository }, windowsHide: true, stdio: "pipe", timeout: 30000 });
const ts = require("typescript");
const configPath = safe(path.join(repository, "docs/testing/qa-2026-11-06/tsconfig.qa.json"));
const config = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
const options = { ...parsed.options, rootDir: repository, composite: false, incremental: false, noEmit: true };
delete options.tsBuildInfoFile;
const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames, options)).map(item => ({ file: item.file?.fileName, code: item.code, line: item.file && item.start !== undefined ? item.file.getLineAndCharacterOfPosition(item.start).line + 1 : null, message: ts.flattenDiagnosticMessageText(item.messageText, "\n") }));
const esbuild = createRequire(require.resolve("tsx/esm/api"))("esbuild");
let ast, checkedCallbacks = 0, checkedRawScripts = 0;
const closureFindings = [], rawSyntaxErrors = [];
function visit(node) {
  if (ts.isCallExpression(node) && /^(browser\.execute|browser\.electron\.execute)$/u.test(node.expression.getText(ast))) {
    const callback = node.arguments[0];
    if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
      checkedCallbacks++;
      const context = { module: { exports: null } };
      vm.runInNewContext(esbuild.transformSync("module.exports=(" + callback.getText(ast) + ");", { loader: "ts", target: "es2022", keepNames: true }).code, context);
      if (/__name\d*\(/u.test(context.module.exports.toString())) closureFindings.push({ source: ast.fileName, line: ast.getLineAndCharacterOfPosition(callback.getStart(ast)).line + 1 });
    } else if (callback && (ts.isNoSubstitutionTemplateLiteral(callback) || ts.isStringLiteral(callback))) {
      checkedRawScripts++;
      try { new vm.Script("(function(){" + callback.text + "})"); }
      catch (error) { rawSyntaxErrors.push({ source: ast.fileName, error: error.message }); }
    }
  }
  ts.forEachChild(node, visit);
}
for (const file of [source, helper]) { ast = ts.createSourceFile(file, fs.readFileSync(safe(file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS); visit(ast); }
const qlaAst = ts.createSourceFile(source, fs.readFileSync(source, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const boundary = qlaAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "insideTree");
const boundaryContext = { module: { exports: null }, relative: path.relative, resolve: path.resolve, sep: path.sep, isAbsolute: path.isAbsolute };
vm.runInNewContext(esbuild.transformSync(boundary.getText(qlaAst) + "\nmodule.exports=insideTree;", { loader: "ts", target: "es2022" }).code, boundaryContext);
const staged = path.join(repository, "packages/desktop/.e2e-cache/qa-static-boundary");
const boundaryProbe = { allowedRunConfig: boundaryContext.module.exports(staged, path.resolve(staged, "app/main/../../config/default.json")), rejectedSharedConfig: !boundaryContext.module.exports(staged, path.resolve(staged, "app/../../config/default.json")), rejectedSiblingRun: !boundaryContext.module.exports(staged, staged + "-other/config/default.json"), rejectedProjectOutside: !boundaryContext.module.exports(staged, path.dirname(repository)) };
const cases = [];
globalThis.describe = (_title, callback) => callback();
globalThis.before = globalThis.after = globalThis.beforeEach = globalThis.afterEach = () => undefined;
globalThis.it = (title, _callback) => cases.push(title);
const evidence = { capturedAt: new Date().toISOString(), evidenceKind: "all external QA noEmit; actual QLA 12 registration; callback syntax and pure path boundary probes only; no hooks/cases/Main/Host/UI execution", sources: [source, helper, path.join(repository, "config/default.json")].map(file => ({ file, sha256: createHash("sha256").update(fs.readFileSync(safe(file))).digest("hex") })), diagnostics, checkedCallbacks, closureFindings, checkedRawScripts, rawSyntaxErrors, boundaryProbe, registeredCases: cases };
function save() { fs.writeFileSync(safe(path.join(__dirname, "e2e-preflight-qla-reviewed-static.json")), JSON.stringify(evidence, null, 2) + "\n"); process.stdout.write(JSON.stringify(evidence, null, 2) + "\n"); }
(async () => {
  const { tsImport } = require("tsx/esm/api");
  await tsImport(pathToFileURL(source).href, { parentURL: pathToFileURL(__filename).href, tsconfig: path.join(repository, "packages/desktop/tsconfig.e2e.json") });
  const lintEntry = path.join(path.dirname(require.resolve("oxlint/package.json")), "bin/oxlint");
  try { evidence.targetedLint = { exitCode: 0, output: execFileSync(process.execPath, [lintEntry, "--deny-warnings", "--no-ignore", source, helper], { cwd: repository, env: process.env, windowsHide: true, encoding: "utf8" }).trim() }; }
  catch (error) { evidence.targetedLint = { exitCode: error.status ?? 1, output: String(error.stdout ?? "") + String(error.stderr ?? "") }; process.exitCode = 1; }
  save();
  if (diagnostics.length || closureFindings.length || rawSyntaxErrors.length || cases.length !== 12 || Object.values(boundaryProbe).some(value => !value)) process.exitCode = 1;
})().catch(error => { evidence.importError = error.stack; save(); process.exitCode = 1; });
