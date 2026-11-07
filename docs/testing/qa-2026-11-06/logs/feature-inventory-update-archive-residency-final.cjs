"use strict";
// 单次矩阵更新；以后批次不要重新执行覆盖更新后的行。
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../../../..");
const doc = path.join(root, "docs/testing/qa-2026-11-06/coverage-matrix.md");
for (const target of [doc, __dirname]) for (let cursor = target; ; cursor = path.dirname(cursor)) {
  if (fs.existsSync(cursor) && (fs.lstatSync(cursor).isSymbolicLink() || fs.realpathSync.native(cursor).toLowerCase() !== cursor.toLowerCase())) throw new Error("Matrix update reparse path");
  if (cursor.toLowerCase() === root.toLowerCase()) break;
}
const runs = ["qa-menu-20261106-grp-pin-repro-retry", "qa-menu-20261106-archive-list-retry", "qa-menu-20261106-residency-final"].map((runId) => {
  const directory = path.join(root, "docs/testing/qa-2026-11-06/runtime", runId, "evidence");
  const summary = JSON.parse(fs.readFileSync(path.join(directory, "summary.json"), "utf8"));
  const tests = fs.readFileSync(path.join(directory, "test-results.ndjson"), "utf8").trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  if (!summary.completedAt || typeof summary.exitCode !== "number") throw new Error("Matrix requires actual completed summary");
  return { runId, completedAt: summary.completedAt, exitCode: summary.exitCode, tests: tests.map(({ title, passed, error, capturedAt }) => ({ title, passed, error: error ?? null, capturedAt })) };
});
if (runs.map((run) => run.tests.length).join(",") !== "1,3,1") throw new Error("Unexpected actual case count");
if (runs[1].tests.map((test) => test.passed).join(",") !== "false,false,true" || runs[2].tests[0].passed !== true) throw new Error("Archive/residency identity changed");
let content = fs.readFileSync(doc, "utf8");
if (content.includes("| B-residency-final1")) throw new Error("One-off final matrix update already applied");
content = content.replace(/证据截点为 local-supplement 完整结束：[\s\S]*?，依据本轮已落盘的/u, "证据截点为 residency-final 完整结束：2026-11-07 03:26:45.394（北京时间；summary `completedAt=2026-11-06T19:26:45.394Z`、exit0），依据本轮已落盘的");
const lines = content.split(/\r?\n/u);
function row(id, replacement) {
  const index = lines.findIndex((line) => line.includes('<a id="' + id + '"></a>'));
  if (index < 0) throw new Error("Missing matrix anchor " + id);
  lines[index] = replacement;
}
row("brow-03", '| <a id="brow-03"></a>BROW-03 | tab生命周期、Agent/人工视图、截图录制 | B BTC01真实首关/重复IPC关闭通过；B-residency-final1 BTL04/BTL12通过：1个真实about:blank guest经IPC注册33逻辑tab、淘汰最老、同profile完整重启后tab/guest/suspended均0 | partial（关闭幂等/逻辑上限/完整重启清空） | 新run原guard通过，旧当刻拒绝证据保留；不是32真实guest压力测试。Agent/人工切换、hidden/跨workspace、capture/录制和输出范围仍缺；[真实reload观察](runtime/qa-menu-20261106-residency-final/evidence/qa-reload-observe-0-0-2-29932-1793993175977.json)含旧PID退出与一次read-error，不扩认未输出的身份字段 |');
row("set-26", '| <a id="set-26"></a>SET-26 | 归档管理：scope/搜索/恢复删除/全部删除/自动归档 | QSM18/V-M/C-retry任务归档确认；SUP QLA08 General自动归档30天/开关保存恢复通过；ARM-list-retry3第一条完成列表展开/搜索/sort/项目选择后旧布局helper失败，第二条收组污染缺alpha，第三条筛选只删1个与group-unarchive完整通过 | partial（列表筛选/sort/项目选择/筛选批删/group恢复/自动归档控件/合同）；FAIL（旧QA布局及折叠前置） | 行restore/删除取消与确认后重启未验，见[最小QAR2计划](test-plan-archive-actions-retry.md)，新pending未执行；不重复ARM03已PASS路径。remote/running/crossroot/调度触发仍缺 |');
const taskIndex = lines.findIndex((line) => line.includes('<a id="tsk-01"></a>'));
if (taskIndex < 0) throw new Error("Missing TSK01 anchor");
lines[taskIndex] = lines[taskIndex].replace('ARM5因旧页位置/cascade未成功restore/delete。', 'ARM-list-retry3筛选批删与group恢复通过；行恢复/单删取消确认待QAR2。').replace('FL置顶后driver timeout；', 'FL置顶后driver timeout，GRP独立retry缺grouped前置未pin；');
const evidenceIndex = lines.findIndex((line) => line.startsWith("| SUP-final19"));
if (evidenceIndex < 0) throw new Error("Missing SUP evidence row");
lines.splice(evidenceIndex + 1, 0,
  '| GRP-retry1 | 独立1case FAIL，19:09:58.714Z/exit1；task-group-add缺失，未首发/pin | [NDJSON](runtime/qa-menu-20261106-grp-pin-repro-retry/evidence/test-results.ndjson)、[summary](runtime/qa-menu-20261106-grp-pin-repro-retry/evidence/summary.json)、[第三真实前置计划](test-plan-grp-pin-targeted-repro.md) |',
  '| ARM-list-retry3 | 3actual=1PASS/2FAIL，19:19:55.085Z/exit1；真实身份ARM01/05/06与ARM02失败，ARM03通过 | [NDJSON](runtime/qa-menu-20261106-archive-list-retry/evidence/test-results.ndjson)、[summary](runtime/qa-menu-20261106-archive-list-retry/evidence/summary.json)、[最小补测计划](test-plan-archive-actions-retry.md) |',
  '| B-residency-final1 | 独立1actual PASS，19:26:45.394Z/exit0；BTL04/BTL12逻辑淘汰与完整重启清空 | [NDJSON](runtime/qa-menu-20261106-residency-final/evidence/test-results.ndjson)、[summary](runtime/qa-menu-20261106-residency-final/evidence/summary.json)、[reload JSON](runtime/qa-menu-20261106-residency-final/evidence/qa-reload-observe-0-0-2-29932-1793993175977.json) |');
content = lines.join("\n");
content += '\n\n本轮后续独立实证（截点19:26:45.394Z）：GRP第二轮只缺grouped前置，第三轮真实菜单hook已静态READY但本截点未执行；ARM-list-retry3实际第一/第二FAIL、第三PASS，已完成动作与失败以后未执行动作分开；residency逻辑33tab淘汰/同profile重启清空通过，原reparse拒绝历史保留。不使用上述静态或单case通过推广整组；新QAR2与HIST/RFC/FLG/RLM/可选preview补测继续pending。\n';
fs.writeFileSync(doc, content);
const snapshot = { capturedAt: new Date().toISOString(), evidenceKind: "Actual completed NDJSON+summary only; feature groups remain partial", runs, anchors: [...content.matchAll(/<a id="([a-z]+-\d+)"><\/a>/gu)].map((item) => item[1]) };
fs.writeFileSync(path.join(__dirname, "feature-inventory-archive-residency-final-matrix-snapshot.json"), JSON.stringify(snapshot, null, 2) + "\n");
process.stdout.write(JSON.stringify({ runs: runs.map(({ runId, completedAt, exitCode, tests }) => ({ runId, completedAt, exitCode, cases: tests.length })), anchors: snapshot.anchors.length }) + "\n");
