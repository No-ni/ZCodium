"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const repository = path.resolve(__dirname, "../../../..");
const root = path.join(repository, "docs/testing/qa-2026-11-06/runtime/qa-local-menu-static");
function safe(candidate) {
  const target = path.resolve(candidate);
  if (!target.startsWith(repository + path.sep)) throw new Error("Static probe path escapes worktree");
  for (let cursor = target; cursor; cursor = path.dirname(cursor)) {
    if (fs.existsSync(cursor) && (fs.lstatSync(cursor).isSymbolicLink() || fs.realpathSync.native(cursor).toLowerCase() !== cursor.toLowerCase())) throw new Error("Static probe refuses links");
    if (cursor === path.dirname(cursor)) break;
  }
  return target;
}
for (const [name, child] of Object.entries({ HOME: "home", USERPROFILE: "home", TEMP: "tmp", TMP: "tmp", TMPDIR: "tmp", APPDATA: "appdata", LOCALAPPDATA: "localappdata", TSX_CACHE_DIR: "tsx", NODE_COMPILE_CACHE: "node-cache", XDG_CACHE_HOME: "cache", XDG_CONFIG_HOME: "home", XDG_DATA_HOME: "home", ZCODE_E2E_HOME_DIR: "app-home", ZCODE_E2E_ARTIFACT_DIR: "artifacts" })) {
  process.env[name] = safe(path.join(root, child)); fs.mkdirSync(process.env[name], { recursive: true });
}
process.env.E2E_PROVIDER_HTTP_MODE = "replay";
const spec = path.join(repository, "docs/testing/qa-2026-11-06/manual-review/pending/qa-local-menu-actions-20261106.test.ts");
const ts = require("typescript");
const configPath = path.join(repository, "packages/desktop/tsconfig.e2e.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
const options = { ...parsed.options, rootDir: repository, composite: false, incremental: false, noEmit: true };
delete options.tsBuildInfoFile;
const program = ts.createProgram([spec], options);
const diagnostics = ts.getPreEmitDiagnostics(program);
const local = diagnostics.filter((item) => !item.file || path.resolve(item.file.fileName) === spec).map((item) => ({ code: item.code, line: item.file && item.start !== undefined ? item.file.getLineAndCharacterOfPosition(item.start).line + 1 : null, message: ts.flattenDiagnosticMessageText(item.messageText, "\n") }));
const cases = [];
globalThis.describe = (_title, callback) => callback();
globalThis.before = globalThis.after = () => undefined;
globalThis.it = (title, _callback) => cases.push(title);
(async () => {
  let importError;
  try {
    const { tsImport } = require("tsx/esm/api");
    await tsImport(pathToFileURL(spec).href, { parentURL: pathToFileURL(__filename).href, tsconfig: configPath });
  } catch (error) { importError = error.stack || error.message; }
  const evidence = { evidenceKind: "targeted TypeScript diagnostics plus actual local tsx import/12-case registration; no hooks/tests/UI executed", capturedAt: new Date().toISOString(), spec, localDiagnostics: local, dependencyDiagnosticsCount: diagnostics.length - local.length, importError, registeredCases: cases };
  fs.writeFileSync(path.join(__dirname, "e2e-preflight-local-menu-static.json"), JSON.stringify(evidence, null, 2) + "\n");
  process.stdout.write(JSON.stringify(evidence, null, 2) + "\n");
  if (local.length || importError || cases.length !== 12) process.exitCode = 1;
})();
