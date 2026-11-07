"use strict";
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../../../..");
const qa = path.join(root, "docs/testing/qa-2026-11-06");
const matrix = path.join(qa, "coverage-matrix.md");
const run = path.join(qa, "runtime/qa-menu-20261106-local-supplement/evidence");
for (const target of [matrix, run]) {
  const rel = path.relative(root, target);
  if (path.isAbsolute(rel) || rel.startsWith("..")) throw new Error("matrix outside tree");
  for (let cursor = target; ; cursor = path.dirname(cursor)) {
    if (
      fs.lstatSync(cursor).isSymbolicLink() ||
      fs.realpathSync.native(cursor).toLowerCase() !== cursor.toLowerCase()
    )
      throw new Error("matrix redirected path");
    if (cursor.toLowerCase() === root.toLowerCase()) break;
  }
}
const records = fs
  .readFileSync(path.join(run, "test-results.ndjson"), "utf8")
  .trim()
  .split(/\r?\n/u)
  .map(JSON.parse);
const summary = JSON.parse(fs.readFileSync(path.join(run, "summary.json"), "utf8"));
if (
  records.length !== 19 ||
  summary.tests.total !== 19 ||
  summary.tests.passed !== 11 ||
  summary.tests.failed !== 7 ||
  summary.tests.skipped !== 1 ||
  summary.exitCode !== 1
)
  throw new Error("SUP final evidence differs");
let text = fs.readFileSync(matrix, "utf8");
if (text.includes("SUP-final19"))
  throw new Error("SUP final already applied; do not overwrite newer matrix");
text = text.replace(
  "证据截点为 menu-reviewed 完整结束：2026-11-07 02:38:45.834（北京时间；summary `completedAt=2026-11-06T18:38:45.834Z`、exit1）",
  "证据截点为 local-supplement 完整结束：2026-11-07 03:05:28.964（北京时间；summary `completedAt=2026-11-06T19:05:28.964Z`、exit1）",
);
const lines = text.split(/\r?\n/u);
const index = lines.findIndex((line) => line.startsWith("| MR-final37"));
if (index < 0) throw new Error("MR index missing");
lines.splice(
  index + 1,
  0,
  "| SUP-final19 | local-supplement 5spec结束，planned22、actual19=11通过/7失败/1pending，exit1；RFC3 beforeAll未生成case | [NDJSON](runtime/qa-menu-20261106-local-supplement/evidence/test-results.ndjson)、[summary](runtime/qa-menu-20261106-local-supplement/evidence/summary.json)、[日志](logs/e2e-qa-menu-20261106-local-supplement.log)、[BUG008归因](logs/validation-command-center-selected-attribution.json)、[HIST真实codec](logs/feature-inventory-historical-codec-31596-1793991760745.json) |",
);
const updates = {
  "NAV-01": [
    "S/Q-final新任务与C-retry首发/第二轮；MR真实公开3row只读导入；SUP RLM08–10取消/busy单飞、有效Host导入/重复task复用/草稿保留、空/nonZIP/version/hash错误与逐次恢复全部通过",
    "partial（新任务/公开导入/取消/重复/错误恢复交互）",
    "只用合成有效/损坏archive及HTML input适配，不验原生picker；附件snapshot/超限/断开事务与完整导出仍缺，不上传内容",
  ],
  "NAV-10": [
    "V-M/V-L帮助/反馈合同；MR QLA05第2出口失败已保留；SUP QLA05当前四fork帮助链接真实菜单mock openExternal全部通过",
    "partial（四帮助菜单mock出口/合同）",
    "mock不代表外部网站可用；补禁用/失败重试与语言，未创建issue/发送消息",
  ],
  "CMD-01": [
    "F弹层视觉边线旧断言；SUP RLM04–07四scope查询已到达但四case失败；RLM04/07当前设置双选中，root确认BUG-008 P2",
    "partial（scope/查询入口）；FAIL（BUG-008；近期任务/预览目标待归因）",
    "[双选中源链/实际JSON+PNG](logs/validation-command-center-selected-attribution.json)；两distinct command.id映相同cmdk value。ArrowDown/Up/Enter在长度断言之后未执行，不扩认键盘/重复动作；history恢复/清空和任务近期/文件正文仍缺",
  ],
  "CMD-02": [
    "V-M命令装配/已删除官方动作合同；SUP RLM04/07设置候选实际双选中后断言失败，尚未执行设置命令",
    "partial（合同/候选显示）；FAIL（BUG-008双选中）",
    "[BUG008](bug-report.md#bug-008)；每条真实执行到目标仍待，不能把候选出现称动作通过；设置Enter/其它命令未抵达",
  ],
  "CMD-03": [
    "MR SLM14只读正文3marker不属runtime Find而pending；SUP SLM15预览页已显示但正文等待失败，Find/scroll/shortcut目标未达；RFC3 beforeAll第二loopback请求500、0case",
    "NOT-RUN（有效Find交互）；BLOCKED（runtime会话前置）",
    "RFC需先精确查明第二请求/finite fixture而非忽略500；补计数/虚拟定位/四导航/关闭回焦。当前未执行file-local Find负测，不伪造入口；[下一框架](test-plan-local-supplement-retry.md)候选未计通过",
  ],
  "CHAT-01": [
    "C-retry首发/第二轮、stop-queue5、queue4、编辑branch cut通过；SUP RLM09真实公开重复导入保留同task composer草稿通过",
    "partial（发送/停止/队列/编辑/导入草稿交互）",
    "仅受控loopback/replay与public import语义；补IME/Shift+Enter、guide、计划批准拒绝、stale run及真实Provider流，不推广手机恢复",
  ],
  "CHAT-05": [
    "LC选区引用/child复用多开关闭active路由通过，Terminal后清选区失败；MR readonly投影无runtime copy而pending；SUP RFC beforeAll第二请求500无case",
    "partial（消息选区/child交互）；FAIL（focus/选区待归因）；BLOCKED（runtime复制前置）",
    "[selection时序](logs/feature-inventory-local-canonical-attribution.md)；focus目标未识别，/side /btw/child发送未达。RFC须有限fixture真实runtime，不能以readonly投影或首响应作复制通过",
  ],
  "CHAT-09": [
    "V-M/V-L官方上传删除审计；SUP RLM08–10真实公开只读导入取消/单飞、重复复用与草稿保留、损坏版本/hash错误映射恢复通过",
    "partial（只读导入/重复/取消/错误恢复/审计合同）",
    "导入仅HTML input适配和本树synthetic；导出selection/整轮确认取消、保存取消错误、附件snapshot、敏感内容仍未执行；没有官方publish",
  ],
  "TSK-03": [
    "V-M Provider配置菜单/V-L反馈合同；SUP HIST01公共archive编码被拒、HIST02依赖失败，尚未点轨迹菜单",
    "partial（合同）；BLOCKED（历史viewer QA前置）",
    "[HIST原因/修正](test-plan-historical-trajectory.md)：旧hist-* ID非公开投影，新source真实codec roundtrip静态通过但未重跑viewer；不恢复writer。Provider文件目标/禁用/反馈错误仍缺",
  ],
  "FILE-02": [
    "MR旧右键路径/Save locator失败保留；SUP SLM08实际绝对/相对copy只写mock通过，SLM09真实Add to chat及SaveDialog取消保留源SHA/任务通过",
    "partial（路径copy/文件引用/另存取消交互）",
    "仅本树中文空格合成file/clipboard与SaveDialog适配；directory/deleted/定位、保存失败、原生picker/remote仍缺，历史QA locator失败不登记当前菜单丢失",
  ],
  "FILE-03": [
    "LC Java搜索后真实源码预览通过；MPS Windows CSS path未转义；SUP RLM06/SLM15预览入口已到达、等待合成正文超时，scroll/Find范围未抵达",
    "partial（源码预览入口）；FAIL（正文等待/Markdown QA selector）",
    "[MPS证明](logs/feature-inventory-mps-selector-probe.json)只归因；RLM06/SLM15需核虚拟正文/QA读取合同，不先判产品丢文件。Markdown选区/SVG/损坏二进制/动态刷新与外观仍缺",
  ],
  "TERM-01": [
    "C-retry TERM-TAB05关闭重开新terminal步骤通过；V-M设置owner合同；MR门禁parse失败；SUP SLM13真实门禁报profile probe unknown keys而pending，未启动PTY/echo/read",
    "partial（tab生命周期/设置合同）；BLOCKED（QA profile分类前置）",
    "[SLM13状态](runtime/qa-menu-20261106-local-supplement/evidence/qa-short-local-menus-0-4-31192-1793991767933/019-SLM13.json)；不得放宽外树profile边界，修QA类型合同后核shell/cwd/echo/read/office PTY。IME/resize/断线/隔离仍缺",
  ],
  "EXTRA-03": [
    "LC TRJ旧自动writer前置失败；SUP HIST01 encode invalid_archive、HIST02依赖失败，viewer/80历史/33MiB尾读均未抵达",
    "FAIL（旧writer与本轮archive QA前置）；BLOCKED（历史viewer执行）",
    "[HIST公开ID修正/真实codec](test-plan-historical-trajectory.md)，新44857be6源noEmit/lint/fullTitle/实际roundtrip通过但UI待重跑；不恢复writer，不把两个前置FAIL当history产品bug",
  ],
  "SET-08": [
    "V-L本树引导偏好/损坏恢复合同；MR旧入口locator失败；SUP SLM06设置侧栏与General两真实引导入口进入/退出全部通过；数据目录未操作",
    "partial（引导合同/两入口进入退出）；NOT-RUN（数据目录动作）",
    "侧栏Rocket不属18section；引导完成/持久化仍缺。下一FLG只补本树browse取消/原值不变，不迁移或清理真实数据",
  ],
  "SET-21": [
    "QSM09入口/空态；SUP RLM11真实新建填name/command后Cancel，相关本树配置SHA不变通过",
    "partial（入口/新建填写取消）",
    "未保存或启动MCP服务器；stdio/SSE/HTTP/env/protocol/timeout/工具状态、scope及OAuth受控测试仍缺，不恢复官方凭据",
  ],
  "SET-22": [
    "QSM10/11技能/命令入口与V-M装配合同；SUP RLM12真实Commands名称/prompt取消无文件新增、RLM13 Skills进入skill-creator草稿不发送通过",
    "partial（入口/命令草稿取消/技能creator草稿/合同）",
    "两个路线不代表CRUD完成；frontmatter/managed只读/冲突/scope/import/启用/写失败与slash刷新仍缺，creator未发模型请求",
  ],
  "SET-26": [
    "QSM18父页/V-M owner/C-retry任务归档确认；MR ARM5旧页位置/污染全FAIL；SUP QLA08 General自动归档关闭可设30天、开关即时保存恢复全部通过",
    "partial（入口/任务归档确认/自动归档控件/合同）；FAIL（归档QA页面污染）",
    "列表restore/delete/全删未成功；独立ARM3列表已静态READY尚未运行，真实删除只本树synthetic。remote/running/crossroot/调度触发仍缺",
  ],
};
for (const [id, values] of Object.entries(updates)) {
  const row = lines.findIndex(
    (line) => line.startsWith("| <a id=") && line.includes(`></a>${id} `),
  );
  if (row < 0) throw new Error("matrix row missing " + id);
  const cells = lines[row].split("|").map((item) => item.trim());
  if (cells.length !== 7) throw new Error("matrix unexpected cells " + id);
  [cells[3], cells[4], cells[5]] = values;
  lines[row] = "| " + cells.slice(1, -1).join(" | ") + " |";
}
const tableRows = lines.filter((line) => line.startsWith("| <a id="));
if (tableRows.length !== 87) throw new Error("expected87");
const notRun = tableRows
  .filter((line) => line.split("|")[4].includes("NOT-RUN"))
  .map((line) => line.match(/><\/a>([A-Z]+-\d+)/u)[1]);
const blocked = tableRows
  .filter((line) => line.split("|")[4].includes("BLOCKED"))
  .map((line) => line.match(/><\/a>([A-Z]+-\d+)/u)[1]);
const failed = tableRows
  .filter((line) => line.split("|")[4].includes("FAIL"))
  .map((line) => line.match(/><\/a>([A-Z]+-\d+)/u)[1]);
const union = [...new Set([...notRun, ...blocked])];
const external = ["NAV-12", "SET-15", "SET-12", "SET-13", "REM-01", "REM-02", "REM-03", "BOT-02"];
const local = union.filter((id) => !external.includes(id));
const p = lines.findIndex((line) => line.startsWith("## menu-reviewed截点的"));
if (p < 0) throw new Error("historical gap index missing");
lines.splice(
  p,
  0,
  "## local-supplement最终截点与当前动作缺口",
  "",
  `SUP-final19在${summary.completedAt}完整结束、exit1：19 actual=11PASS/7FAIL/1SKIP，planned22不是完成数；RFC3 beforeAll第二loopback请求500无case，HIST2是编码/依赖前置FAIL，RLM10为6PASS/4FAIL，SLM5为3PASS/1FAIL/1SKIP，QLA2均PASS。SLM13的NDJSON passed=false且无error，summary/独占JSON均标pending，不能按普通第8失败或产品PTY失败计。`,
  "",
  "实际完成帮助四出口、自动归档控件保存恢复、导入取消/单飞/重复草稿/错误恢复、MCP和Commands取消、Skillscreator草稿、两处引导进入退出、文件路径copy与Save取消。未执行外部网站/原生picker/模型真API/完整CRUD。RLM04/07双选中由独立源链与JSON/PNG确认BUG-008 P2；Enter/Arrow在失败之后未执行，RLM05近期列表/06正文目标仍待QA归因。HIST新public-ID/真实codec静态修正仅准入，viewer仍未验。",
  "",
  `当前87行含NOT-RUN ${notRun.length}组、BLOCKED ${blocked.length}组、union ${union.length}唯一组，FAIL标签${failed.length}组不是产品bug数；已确认BUG共8=6产品+2门禁。union中本地${local.length}组（${local.join("、")}）、外部条件8组。新的TERM-01只是profile分类前置pending，已有tab生命周期partial，不等于整组未触及。其余partial行的未测动作仍逐行保留。`,
  "",
  "后续GRP/ARM3/residency及[HIST/RFC/新本地补测框架](test-plan-local-supplement-retry.md)继续串行；当前未READY/未执行不计结果。下面menu-reviewed旧9/8统计保留为历史快照，不替代本节及87行最新状态。",
  "",
  "",
);
const oldPending = lines.findIndex((line) => line.startsWith("supplement22正在独占运行"));
if (oldPending >= 0)
  lines[oldPending] =
    "该menu-reviewed历史截点时supplement尚未结束，当前完整结果与新限制已在上节及87行回填；原候选状态不能代替真实完成数。Provider/MCP/Skills/Commands/Hooks完整保存与CRUD、文件预览/终端/Git/导出/调度仍保留行内缺口。";
fs.writeFileSync(matrix, lines.join("\n"));
const snapshot = path.join(qa, "logs/feature-inventory-supplement-final-matrix-snapshot.json");
fs.writeFileSync(
  snapshot,
  JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      runCompletedAt: summary.completedAt,
      actual: 19,
      passed: 11,
      failed: 7,
      skipped: 1,
      records: records.map((item) => ({
        title: item.title,
        passed: item.passed,
        error: item.error ?? null,
        capturedAt: item.capturedAt,
      })),
      notRun,
      blocked,
      failedGroups: failed,
      local,
      external,
      groups: 87,
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
process.stdout.write(
  JSON.stringify({
    matrix,
    snapshot,
    groups: 87,
    notRun,
    blocked,
    failed: failed.length,
    local,
    external,
  }) + "\n",
);
