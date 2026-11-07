"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const repository = path.resolve(__dirname, "../../../..");
const desktop = path.join(repository, "packages/desktop");
const ts = require("typescript");
const baseSpecs = [
  "conversation-session/conversation-session-task-groups.test.ts",
  "conversation-session/conversation-session-v4-composer-toolbar.test.ts",
  "settings/settings-subagent-create-edit-persistence.test.ts",
  "ui-shell/general-coding-mode.test.ts",
  "settings/shortcut-settings-key-search.test.ts",
];
const extraSpecs = [
  "ui-shell/side-pane-full-view.test.ts",
  "conversation-session/conversation-session-ask-user-question-custom-enter-single-question.test.ts",
  "conversation-session/conversation-session-ask-user-question-keyboard-navigation.test.ts",
  "conversation-session/conversation-session-tool-detail-toggle-stability.test.ts",
  "conversation-session/conversation-session-tool-actions.test.ts",
];
const browserSpecs = ["browser-empty-state-deferred-guest.test.ts", "browser-tab-close-idempotent.test.ts", "browser-permission/browser-permission-site-settings.test.ts", "browser-human-viewport-preference.test.ts", "browser-tab-residency.test.ts"];
const baseGrep = "(?:GRP(?:02(?:/03/11)?|04/05/06|06/CR-01|11)：|SE-0[23]:|MODE-01 |SC-13:|模型选择器/思考深度/模式切换|合并模型/思考弹层与模式 picker 互斥|slider dots grow on hover|模型管理入口位于 Provider 子菜单|completed task 的 picker 不跨 scope|model tooltip describes the action|dismisses with one outside click|keeps the open model picker responsive)";
const extraGrep = "(?:SPFV-E2E-00[12] |只有一题时 custom input 按 Enter 应直接提交答案|自定义 Enter、Esc 返回、上下预选和空格/Enter 选中应符合多题问答键盘语义|连续两次 Read 聚合 Explore 的详情展开与收起高度连续归零|tool call block 不应提供 edit 或 fork 入口)";
const fullGrep = baseGrep + "|" + extraGrep;
function safe(target) {
  const absolute = path.resolve(target);
  if (!absolute.startsWith(repository + path.sep)) throw new Error("Next-batch target escapes worktree");
  return absolute;
}
const plannedRoots = ["qa-menu-20261106-filtered", "qa-menu-20261106-browser"].map((run) => path.join(repository, "docs/testing/qa-2026-11-06/runtime", run));
const targets = [...baseSpecs, ...extraSpecs, ...browserSpecs].map((spec) => path.join(desktop, "test/e2e", spec));
targets.push(...plannedRoots, path.join(desktop, ".e2e-artifacts"), path.join(repository, "docs/testing/qa-2026-11-06/logs"));
targets.forEach(safe);
const auditScript = "$ErrorActionPreference='Stop'; $paths=ConvertFrom-Json $env:QA_STATIC_AUDIT_PATHS; foreach($target in $paths) { $cursor=[IO.Path]::GetFullPath($target); while($cursor) { if(Test-Path -LiteralPath $cursor) { $item=Get-Item -LiteralPath $cursor -Force; if($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Static audit refuses ancestor reparse point' } }; $cursor=[IO.Path]::GetDirectoryName($cursor) }; if(Test-Path -LiteralPath $target -PathType Container) { $queue=[Collections.Generic.Queue[string]]::new(); $queue.Enqueue($target); while($queue.Count) { foreach($item in Get-ChildItem -LiteralPath $queue.Dequeue() -Force) { if($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Static audit refuses descendant reparse point' }; if($item.PSIsContainer) { $queue.Enqueue($item.FullName) } } } } }";
execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", auditScript], {env: {...process.env, QA_STATIC_AUDIT_PATHS: JSON.stringify(targets)}, windowsHide: true, stdio: "pipe", timeout: 30000});
function titles(spec, grep) {
  const filename = path.join(desktop, "test/e2e", spec);
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
  const all = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "it" && ts.isStringLiteralLike(node.arguments[0])) all.push({title: node.arguments[0].text, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1});
    ts.forEachChild(node, visit);
  }
  visit(source);
  return {spec: "./test/e2e/" + spec, selected: all.filter((item) => !grep || new RegExp(grep).test(item.title)), excluded: all.filter((item) => grep && !new RegExp(grep).test(item.title))};
}
const environment = {...process.env, NODE_OPTIONS: "", E2E_PROVIDER_HTTP_MODE: "replay"};
for (const key of ["HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "APPDATA", "LOCALAPPDATA", "TSX_CACHE_DIR", "NODE_COMPILE_CACHE", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "ZCODE_E2E_HOME_DIR", "ZCODE_E2E_ARTIFACT_DIR"]) environment[key] = path.join(plannedRoots[0], "static-not-created", key.toLowerCase());
const checker = path.join(desktop, "scripts/check-e2e-fixtures.mjs");
const fixtureChecks = [...baseSpecs, ...extraSpecs].filter((spec) => spec.startsWith("conversation-session/")).map((spec) => {
  const result = spawnSync(process.execPath, [checker, "--spec", "./test/e2e/" + spec], {cwd: desktop, env: environment, encoding: "utf8", windowsHide: true});
  return {spec, exitCode: result.status, stdout: result.stdout, stderr: result.stderr};
});
const evidence = {capturedAt: new Date().toISOString(), evidenceKind: "read-only AST selection, path/reparse audit and installed fixture checker; no build, server or UI launch", baseGrep, fullGrep, base: baseSpecs.map((spec) => titles(spec, baseGrep)), extended: [...baseSpecs, ...extraSpecs].map((spec) => titles(spec, fullGrep)), browser: browserSpecs.map((spec) => titles(spec)), auditedTargets: targets.map((target) => ({target, exists: fs.existsSync(target)})), fixtureChecks};
evidence.baseCount = evidence.base.reduce((sum, item) => sum + item.selected.length, 0);
evidence.extendedCount = evidence.extended.reduce((sum, item) => sum + item.selected.length, 0);
evidence.browserCount = evidence.browser.reduce((sum, item) => sum + item.selected.length, 0);
fs.writeFileSync(safe(path.join(__dirname, "e2e-preflight-next-batches.json")), JSON.stringify(evidence, null, 2) + "\n");
process.stdout.write(JSON.stringify({baseCount: evidence.baseCount, extendedCount: evidence.extendedCount, browserCount: evidence.browserCount, fixtureChecks: fixtureChecks.map((item) => ({spec: item.spec, exitCode: item.exitCode, warningLines: item.stdout.split("\n").filter((line) => /warning|WARN/u.test(line))})), pathsAudited: targets.length}, null, 2) + "\n");
if (evidence.baseCount !== 17 || evidence.extendedCount !== 23 || fixtureChecks.some((item) => item.exitCode !== 0)) process.exitCode = 1;
