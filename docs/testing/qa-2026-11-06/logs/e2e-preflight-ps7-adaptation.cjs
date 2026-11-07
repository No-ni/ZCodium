"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const repository = path.resolve(__dirname, "../../../..");
const runtime = path.join(repository, "docs/testing/qa-2026-11-06/runtime/qa-ps7-static");
const powershell = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
function safe(candidate) {
  const target = path.resolve(candidate);
  if (!target.startsWith(repository + path.sep)) throw new Error("QA PS7 probe path escapes worktree");
  for (let cursor = target;; cursor = path.dirname(cursor)) {
    if (fs.existsSync(cursor) && (fs.lstatSync(cursor).isSymbolicLink() || fs.realpathSync.native(cursor).toLowerCase() !== cursor.toLowerCase())) throw new Error("QA PS7 probe refuses redirected ancestors");
    if (cursor === path.dirname(cursor)) break;
  }
  return target;
}
safe(runtime);
for (const name of ["HOME","USERPROFILE","TEMP","TMP","TMPDIR","APPDATA","LOCALAPPDATA","COREPACK_HOME","PNPM_HOME","npm_config_cache","npm_config_store_dir","npm_config_userconfig","TSX_CACHE_DIR","NODE_COMPILE_CACHE","XDG_CACHE_HOME","XDG_CONFIG_HOME","XDG_DATA_HOME","ZCODE_E2E_HOME_DIR","ZCODE_E2E_ARTIFACT_DIR"]) {
  process.env[name] = safe(path.join(runtime, name.toLowerCase()));
  if (name === "npm_config_userconfig") { fs.mkdirSync(path.dirname(process.env[name]), { recursive:true }); fs.writeFileSync(process.env[name], ""); }
  else fs.mkdirSync(process.env[name], { recursive:true });
}
process.env.NODE_OPTIONS = "";
const sources = [
  "docs/testing/qa-2026-11-06/qa-project-bootstrap.cjs",
  "docs/testing/qa-2026-11-06/manual-review/pending/qa-local-menu-actions-20261106.test.ts",
  "docs/testing/qa-2026-11-06/manual-review/pending/qa-residual-local-menus-20261106.test.ts",
];
const evidence = { capturedAt: new Date().toISOString(), evidenceKind: "PS7 executable-only QA adaptation; no UI, product build or desktop process started", powershell, sources: sources.map(name => ({path: name, sha256:createHash("sha256").update(fs.readFileSync(safe(path.join(repository,name)))).digest("hex")})), checks:[] };
function run(name, executable, arguments_) {
  try { const output = execFileSync(executable, arguments_, {env:process.env,cwd:repository,windowsHide:true,encoding:"utf8",timeout:60000}); evidence.checks.push({name,exitCode:0,output:output.trim()}); }
  catch(error) {evidence.checks.push({name,exitCode:error.status??1,output:String(error.stdout??"")+String(error.stderr??"")}); process.exitCode=1;}
}
const guard = fs.readFileSync(safe(path.join(repository,"docs/testing/qa-2026-11-06/qa-reparse-children.ps1")), "utf8");
process.env.QA_REPARSE_WORKTREE=repository;
process.env.QA_PS7_STATIC_ROOT=runtime;
run("PS7 shared guard readonly runtime descendant audit", powershell, ["-NoProfile","-NonInteractive","-Command",guard+"\n$ErrorActionPreference='Stop';$q=[Collections.Generic.Queue[string]]::new();$q.Enqueue($env:QA_PS7_STATIC_ROOT);while($q.Count){foreach($c in Get-QaAuditChildren $q.Dequeue()){if($c.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'QA static descendant reparse point'};if($c.PSIsContainer){$q.Enqueue($c.FullName)}}};$PSVersionTable.PSVersion.ToString()"]);
run("node syntax bootstrap", process.execPath, ["--check", path.join(repository,sources[0])]);
run("external QA TypeScript noEmit", process.execPath, [require.resolve("typescript/lib/tsc.js"), "-p", path.join(repository,"docs/testing/qa-2026-11-06/tsconfig.qa.json"), "--noEmit", "--incremental", "false"]);
const lintEntry=path.join(path.dirname(require.resolve("oxlint/package.json")), "bin/oxlint");
run("targeted hook/local/residual oxlint", process.execPath, [lintEntry,"--deny-warnings","--no-ignore",...sources]);
fs.writeFileSync(safe(path.join(__dirname,"e2e-preflight-ps7-adaptation.json")),JSON.stringify(evidence,null,2)+"\n");
process.stdout.write(JSON.stringify(evidence,null,2)+"\n");
