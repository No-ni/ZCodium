"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const ts = require("typescript");
const root = path.resolve(__dirname, "../../../..");
const targetTitle = "GRP04/05/06：组内首发、三视图菜单、置顶/归档和恢复保持成员";
const grep = "(?:^| )" + targetTitle + "$";
const spec = path.join(root, "packages/desktop/test/e2e/conversation-session/conversation-session-task-groups.test.ts");
const hook = path.join(root, "docs/testing/qa-2026-11-06/qa-project-bootstrap.cjs");
const runner = path.join(root, "docs/testing/qa-2026-11-06/run-menu-tests.ps1");
const matcher = path.join(root, "packages/desktop/test/e2e/helpers/upstream-replay-server.ts");
const fixtures = ["common.json", "conversation-session/conversation-session-task-groups.json"].map((name) => path.join(root, "packages/desktop/test/e2e/fixtures/upstream", name));
const runtime = path.join(root, "docs/testing/qa-2026-11-06/runtime", "qa-grp-target-static-" + process.pid + "-" + Date.now());
const guard = path.join(root, "docs/testing/qa-2026-11-06/qa-reparse-children.ps1");
const output = path.join(__dirname, "feature-inventory-grp-target-preflight.json");
function assertPath(candidate) {
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)) throw new Error("GRP static path outside worktree");
  for (let cursor = resolved; ; cursor = path.dirname(cursor)) {
    if (fs.existsSync(cursor) && (fs.lstatSync(cursor).isSymbolicLink() || fs.realpathSync.native(cursor).toLowerCase() !== cursor.toLowerCase())) throw new Error("GRP static refuses reparse path");
    if (cursor.toLowerCase() === root.toLowerCase()) break;
  }
}
for (const file of [spec, hook, runner, matcher, ...fixtures, runtime, output, guard]) assertPath(file);
const audit = fs.readFileSync(guard, "utf8") + "\n$ErrorActionPreference='Stop';$target=$env:GRP_STATIC_TARGET;if(Test-Path -LiteralPath $target){$queue=[Collections.Generic.Queue[string]]::new();$queue.Enqueue($target);while($queue.Count){foreach($item in Get-QaAuditChildren $queue.Dequeue()){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'GRP static reparse descendant'};if($item.PSIsContainer){$queue.Enqueue($item.FullName)}}}}";
execFileSync("C:\\Program Files\\PowerShell\\7\\pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", audit], { env: { ...process.env, GRP_STATIC_TARGET: runtime, QA_REPARSE_WORKTREE: root }, windowsHide: true, timeout: 30_000, stdio: "pipe" });
fs.mkdirSync(runtime);
for (const name of ["HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "APPDATA", "LOCALAPPDATA", "COREPACK_HOME", "PNPM_HOME", "npm_config_cache", "npm_config_store_dir", "TSX_CACHE_DIR", "NODE_COMPILE_CACHE", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "ZCODE_E2E_HOME_DIR", "ZCODE_E2E_ARTIFACT_DIR", "ZCODE_E2E_NETWORK_CAPTURE_DIR"]) {
  const target = path.join(runtime, ["HOME", "USERPROFILE", "ZCODE_E2E_HOME_DIR"].includes(name) ? "home" : name.toLowerCase());
  assertPath(target); fs.mkdirSync(target, { recursive: true }); process.env[name] = target;
}
process.env.NODE_OPTIONS = "";
process.env.E2E_PROVIDER_HTTP_MODE = "replay";
process.env.E2E_PROVIDER_CAPTURE_MODE = "replay";
process.env.E2E_PROVIDER_API_KEY = "e2e-fixture-key";
process.env.E2E_PROVIDER_REPLAY_FIXTURE_PATH = fixtures.join(",");
process.env.ZCODE_E2E_MANUAL_REVIEW = "0";
function sourceFunction(file, name, kind = ts.ScriptKind.TS) {
  const source = fs.readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const node = ast.statements.find((item) => ts.isFunctionDeclaration(item) && item.name?.text === name);
  if (!node) throw new Error("GRP static required source function missing: " + name);
  return node.getText(ast);
}
const hookSource = fs.readFileSync(hook, "utf8");
new vm.Script(hookSource, { filename: hook });
const groupedFunction = sourceFunction(hook, "isGroupedTarget", ts.ScriptKind.JS);
const prepareFunction = sourceFunction(hook, "prepareGroupedTargetBeforeEach", ts.ScriptKind.JS);
const ctx = { process: { env: {} }, uiCalls: 0, globalThis: { browser: new Proxy({}, { get() { ctx.uiCalls++; throw new Error("GRP static UI forbidden"); } }) }, isolatedPaths() { throw new Error("GRP static target-only paths forbidden"); } };
vm.createContext(ctx);
vm.runInContext(groupedFunction + "\n" + prepareFunction + "\nthis.check=isGroupedTarget;this.prepare=prepareGroupedTargetBeforeEach;", ctx);
const target = { file: spec, title: targetTitle };
const targets = [
  ["exact Windows", target, true],
  ["exact slash", { ...target, file: spec.replaceAll("\\", "/") }, true],
  ["different title", { ...target, title: "GRP02：旧分组偏好迁移，新选择在重载后优先" }, false],
  ["prefix title", { ...target, title: "prefix " + targetTitle }, false],
  ["suffix title", { ...target, title: targetTitle + " suffix" }, false],
  ["other file", { ...target, file: spec.replace("task-groups", "chat-find-refocus") }, false],
  ["undefined", undefined, false],
  ["relative file", { ...target, file: "./test/e2e/conversation-session/conversation-session-task-groups.test.ts" }, false],
].map(([name, test, expected]) => ({ name, expected, actual: ctx.check(test) }));
const hookAst = ts.createSourceFile(hook, hookSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const browserCallbacks = [];
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(hookAst) === "globalThis.browser.execute" && node.pos >= hookSource.indexOf("async function prepareGroupedTargetBeforeEach")) {
    const callback = node.arguments[0]?.getText(hookAst);
    if (callback) {
      const transformed = require("esbuild").transformSync("globalThis.browser.execute(" + callback + ");", { loader: "js", keepNames: true, target: "esnext" }).code;
      new vm.Script(transformed);
      browserCallbacks.push({ keepNames: true, parse: true, injectedNameHelper: transformed.includes("__name"), callback });
    }
  }
  ts.forEachChild(node, visit);
}
visit(hookAst);
const pureSource = ["findFixtureIndex", "readLatestUserMessageText", "readMessageContentText", "captureContainsText"].map((name) => sourceFunction(matcher, name)).join("\n");
const pureJs = ts.transpileModule(pureSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const match = vm.runInNewContext(pureJs + "\nfindFixtureIndex;", {});
const fixtureList = fixtures.flatMap((file) => JSON.parse(fs.readFileSync(file, "utf8")).fixtures);
const req = (text, extra = {}) => ({ messages: [{ role: "user", content: text }], ...extra });
function matching(name, request, expected, counts = new Map(), method = "POST", endpoint = "/v1/messages") {
  const index = match(fixtureList, { method, path: endpoint }, JSON.stringify(request), request, counts);
  return { name, expected, actual: index < 0 ? null : fixtureList[index].id };
}
const mainRequest = req("E2E_GROUP_TASK 请回复 E2E_GROUP_READY。");
const fixtureProbes = [
  matching("canonical first send", mainRequest, "grp06-first-send"),
  matching("title sidecar", req("Generate a concise title for E2E_GROUP_TASK"), "conversation-session-task-groups-title-sidecar"),
  matching("title excludes main", req("E2E_GROUP_TASK Generate a concise title"), "conversation-session-task-groups-title-sidecar"),
  matching("main maxMatches exhausted", mainRequest, null, new Map([["grp06-first-send", 1]])),
  matching("unselected pending case only", req("E2E_GROUP_PENDING"), "grp06-pending-placement"),
  matching("wrong HTTP method", mainRequest, null, new Map(), "GET"),
  matching("unrelated marker", req("E2E_OTHER_NO_NETWORK"), null),
  matching("last user guards old marker", { messages: [{ role: "user", content: "E2E_GROUP_TASK" }, { role: "user", content: "no marker" }] }, null),
];
const evidence = {
  capturedAt: new Date().toISOString(), evidenceKind: "static source syntax/target/fullTitle registration/synthetic pure matcher; no UI/hooks/Host/Provider server/build", runtime,
  sources: [spec, hook, runner, matcher, ...fixtures].map((file) => ({ file, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") })),
  grep, targetProbes: targets, fixtureProbes, browserCallbacks, registered: [], excluded: [], earlyReturns: [],
};
const runnerSource = fs.readFileSync(runner, "utf8");
const runnerPrefix = runnerSource.slice(runnerSource.indexOf("$ErrorActionPreference"), runnerSource.indexOf("function Assert-QaPath"));
const runnerExact = { RunId: "qa-menu-20261106-grp-pin-grouped", Specs: "./test/e2e/conversation-session/conversation-session-task-groups.test.ts", Grep: grep, Bootstrap: true, GroupedTarget: true, SafeGit: false, Existing: false };
const runnerProbeInputs = [
  ["exact target fresh", runnerExact, true],
  ["old run", { ...runnerExact, RunId: "qa-menu-20261106-grp-pin-repro-retry" }, false],
  ["extra spec", { ...runnerExact, Specs: runnerExact.Specs + ",./test/e2e/smoke.test.ts" }, false],
  ["wrong grep", { ...runnerExact, Grep: "GRP04" }, false],
  ["runtime exists", { ...runnerExact, Existing: true }, false],
  ["Bootstrap absent", { ...runnerExact, Bootstrap: false }, false],
  ["default off", { ...runnerExact, GroupedTarget: false, RunId: "qa-other-static", Specs: "./test/e2e/smoke.test.ts", Grep: "", Existing: true }, true],
];
const psStatic = "$ErrorActionPreference='Stop';$tokens=$null;$parseErrors=$null;[Management.Automation.Language.Parser]::ParseFile($env:GRP_STATIC_RUNNER,[ref]$tokens,[ref]$parseErrors)|Out-Null;if($parseErrors.Count){throw 'Runner syntax error'};$cases=ConvertFrom-Json $env:GRP_STATIC_CASES;$results=@();foreach($case in $cases){$RunId=$case.input.RunId;$Specs=$case.input.Specs;$Grep=$case.input.Grep;$Bootstrap=[bool]$case.input.Bootstrap;$GroupedTarget=[bool]$case.input.GroupedTarget;$SafeGit=[bool]$case.input.SafeGit;$existing=[bool]$case.input.Existing;function Test-Path{param($LiteralPath) return $existing};$accepted=$true;$reason=$null;try{&([ScriptBlock]::Create($env:GRP_STATIC_PREFIX))}catch{$accepted=$false;$reason=$_.Exception.Message};$results+=@{name=$case.name;expected=[bool]$case.expected;actual=$accepted;reason=$reason}};ConvertTo-Json -Depth 8 -Compress -InputObject @{syntaxErrors=$parseErrors.Count;probes=$results}";
evidence.runnerStatic = JSON.parse(execFileSync("C:\\Program Files\\PowerShell\\7\\pwsh.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(psStatic, "utf16le").toString("base64")], { env: { ...process.env, GRP_STATIC_RUNNER: runner, GRP_STATIC_PREFIX: runnerPrefix, GRP_STATIC_CASES: JSON.stringify(runnerProbeInputs.map(([name, input, expected]) => ({ name, input, expected }))) }, windowsHide: true, timeout: 30_000, stdio: "pipe", encoding: "utf8" }));
(async () => {
  await ctx.prepare.call({ currentTest: target }); evidence.earlyReturns.push({ name: "default disabled target", uiCalls: ctx.uiCalls });
  ctx.process.env.QA_BOOTSTRAP_GROUPED_TARGET = "1"; ctx.process.env.ZCODE_E2E_RUN_ID = "qa-menu-20261106-grp-pin-grouped";
  for (const test of [{ ...target, title: "unselected" }, { ...target, file: "C:/unselected.test.ts" }, undefined]) {
    await ctx.prepare.call({ currentTest: test }); evidence.earlyReturns.push({ name: test?.title ?? "undefined", uiCalls: ctx.uiCalls });
  }
  ctx.process.env.ZCODE_E2E_RUN_ID = "qa-menu-20261106-grp-pin-repro-retry";
  try { await ctx.prepare.call({ currentTest: target }); throw new Error("GRP wrong run accepted"); } catch (error) { if (!error.message.includes("unreviewed run")) throw error; evidence.earlyReturns.push({ name: "wrong run refused", uiCalls: ctx.uiCalls }); }
  const suites = []; const hooks = [];
  globalThis.describe = (title, callback) => { suites.push(title); try { callback(); } finally { suites.pop(); } };
  globalThis.it = (title) => evidence.registered.push({ title, suites: [...suites], fullTitle: [...suites, title].join(" ") });
  for (const kind of ["before", "after", "beforeEach", "afterEach"]) globalThis[kind] = () => hooks.push(kind);
  globalThis.browser = new Proxy({}, { get() { throw new Error("GRP registration UI forbidden"); } });
  const { tsImport } = require("tsx/esm/api");
  await tsImport(pathToFileURL(spec).href, { parentURL: pathToFileURL(__filename).href, tsconfig: path.join(root, "packages/desktop/tsconfig.e2e.json") });
  const filter = new RegExp(grep, "u"); evidence.selected = evidence.registered.filter((item) => filter.test(item.fullTitle)); evidence.excluded = evidence.registered.filter((item) => !filter.test(item.fullTitle)); evidence.hooksRegisteredNotRun = hooks;
  evidence.accepted = evidence.selected.length === 1 && evidence.selected[0].title === targetTitle && targets.every((item) => item.actual === item.expected) && fixtureProbes.every((item) => item.actual === item.expected) && browserCallbacks.length === 1 && browserCallbacks.every((item) => item.parse && !item.injectedNameHelper) && ctx.uiCalls === 0 && evidence.runnerStatic.syntaxErrors === 0 && evidence.runnerStatic.probes.every((item) => item.actual === item.expected);
  fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ output, accepted: evidence.accepted, selected: evidence.selected, excluded: evidence.excluded.length, targetProbes: targets.length, fixtureProbes: fixtureProbes.length, uiCalls: ctx.uiCalls }) + "\n");
  if (!evidence.accepted) process.exitCode = 1;
})().catch((error) => { evidence.accepted = false; evidence.error = error.stack; fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n"); process.stderr.write(error.stack + "\n"); process.exitCode = 1; });
