"use strict";
const fs = require("node:fs");
const path = require("node:path");
const base = path.resolve(__dirname, "..");
const file = path.join(base, "coverage-matrix.md");
const evidencePath = path.join(base, "runtime/qa-menu-20261106-menu-reviewed/evidence");
const records = fs
  .readFileSync(path.join(evidencePath, "test-results.ndjson"), "utf8")
  .trim()
  .split(/\r?\n/u)
  .map((line) => JSON.parse(line));
const summary = JSON.parse(fs.readFileSync(path.join(evidencePath, "summary.json"), "utf8"));
if (
  records.length !== 37 ||
  summary.tests.total !== 37 ||
  summary.tests.passed !== 18 ||
  summary.tests.failed !== 15 ||
  summary.tests.skipped !== 4 ||
  summary.exitCode !== 1
)
  throw new Error("MR final summary does not match actual 37 records");
let text = fs.readFileSync(file, "utf8");
if (text.includes("MR-final37"))
  throw new Error("Final update already applied; preserve later edits");
text = text.replace(
  /证据截点为 menu-reviewed 运行中前23条记录：[^，]+，依据/u,
  "证据截点为 menu-reviewed 完整结束：2026-11-07 02:38:45.834（北京时间；summary `completedAt=2026-11-06T18:38:45.834Z`、exit1），依据",
);
text = text.replaceAll("MR-running23", "MR-23（历史截点）");
const row =
  "| MR-final37 | menu-reviewed 5spec结束、37 actual记录18通过/15失败/4pending，exit1；RLM后10it未抵达，原planned47不当完成数 | [NDJSON](runtime/qa-menu-20261106-menu-reviewed/evidence/test-results.ndjson)、[summary](runtime/qa-menu-20261106-menu-reviewed/evidence/summary.json)、[日志](logs/e2e-qa-menu-20261106-menu-reviewed.log)、[SPFV真实归因](logs/validation-spfv-attribution.json) |";
text = text.replace(/(\| MR-23（历史截点）[^\r\n]+)(\r?\n)/u, `$1$2${row}$2`);
const notes =
  "MR-final37在18:38:45.834Z完整结束，实际37条18通过/15失败/4pending；QLA12为9/2/1，RLM仅前三条1/2/0且后10未执行，SLM15为7/5/3，SPFV2为1/1/0，ARM5为0/5/0。原生变更记录mock出口、开发工具开关、清空取消、项目键盘排序、Review路由/关闭、office保留已有Review及Whiteboard launcher隐藏有实际通过。QLA07仅memory开关/空catalog，SLM05/14 public readonly投影不能作runtime copy/Find，SLM07 Bot配置已有AstrBot1项未进入注册UI，4项均按pending。SLM09先完成合成file Add to chat，Save取消未抵达；SLM13在终端门禁JSON解析失败，未验echo/PTY；SLM15预览locator失败。SPFV001复跑通过；002空输入560px仍两行，真实DOM flag在外壳而CSS消费inner toolbar，root确认BUG-007 P2，与BUG-006的普通压缩测量副本缺骨架分开，见[归因](logs/validation-spfv-attribution.json)。ARM08/07旧开关位置/默认合同后留General，后3case缺archive groups/row/search，按QA页面污染保留FAIL，不据此认seed丢失；独立ARM3列表重跑与supplement17计划见[补测计划](test-plan-local-supplement.md)，未执行不计通过。\n\n";
text = text.replace(/MR-23（历史截点）仅是运行中截点：[^\n]+\n\n/u, notes);
text = text.replace(
  "三菜单40、SPFV2、归档5的menu-reviewed及residency仍等待结果，未获证据的计划不计通过。",
  "随后menu-reviewed已有MR-final37完整结果，residency仍待独立结果；候选/static READY不计UI通过。",
);
const patches = {
  "NAV-05": [
    "FL两GRP case三视图/偏好迁移/重载和分组创建改色改名通过；MR RLM03未读case driver execute超时，后续未完成；V-M identity/未读合同",
    "partial（视图/分组交互/合同）；FAIL（未读case driver超时）",
    "未读标记/同任务清除/返回不反弹尚无完成证据；GRP组内置顶后timeout后2it未执行。补空列表/排序/选中/大列表/真实冷重启",
  ],
  "NAV-08": [
    "FL MODE01设置/偏好共用refresh；MR QLA03模式/QLA04缩放保存恢复通过；SLM11 office隐藏新Review/Terminal、保留已有Review且可点击通过",
    "partial（模式/缩放菜单/已有Review交互）",
    "SLM13终端门禁JSON解析失败，尚未验office已有PTY保留；缩放边界/DPI/改绑/多窗仍缺",
  ],
  "TSK-01": [
    "V-M未读/重启锁；C-retry任务归档确认/改名同步通过；FL置顶后driver timeout；MR RLM03未读case execute timeout，未完成目标步骤",
    "partial（归档/改名交互/合同）；FAIL（driver超时）",
    "未读/置顶整条case不由标题认通过；ARM5因旧页位置/cascade未成功restore/delete。补running/offline、取消/双击重启/跨窗口与归档列表独立重跑",
  ],
  "CMD-03": [
    "MR SLM14 public readonly正文3marker存在，但未入runtime Find索引，pending；SLM15 preview-pane未显示，Find目标未抵达",
    "NOT-RUN（有效Find交互）；BLOCKED（runtime会话前置）",
    "RFC02有限本树replay运行时历史专项static READY但未执行；补计数/虚拟定位/四种导航/关闭回焦。当前file preview无局部Find，不伪造入口",
  ],
  "PANE-01": [
    "C-retry responsive/full-view多case、LC child身份隔离通过；MR SLM10 Review开/关、SLM11 office保留已有Review通过；SPFV001保留节点再PASS，002空输入560px实际两行，root确认BUG-007 P2",
    "partial（pane/child/Review/full-view交互）；FAIL（BUG-007浮窗布局；selection focus候选）",
    "[BUG007真实DOM/PNG归因](logs/validation-spfv-attribution.json)：外壳composerModelIcon=true，inner named toolbar dataset空、模型仍235.95px/浮窗81.33px，属于flag owner/CSS消费错位。独立于BUG006；补拖排/overview/context/Agent/terminal焦点及远端",
  ],
  "FILE-02": [
    "MR SLM08绝对路径菜单locator缺失失败；SLM09真实Add to chat合成文件引用保留不发送，随后Save as locator缺失，保存取消未抵达",
    "partial（文件引用交互）；FAIL（右键路径/另存QA locator待归因）",
    "absolute/relative mock复制、file/dir/deleted/Unicode/定位、保存取消/失败、remote仍缺；Short5仅QA修复static READY后补，不据locator缺失直接认产品丢菜单",
  ],
  "GIT-01": [
    "C-retry共享Git提交/分支菜单交互；MR SLM10真实Review route显示git-pane内容/空态并关闭，SLM11 office保留已有Review与会话id通过",
    "partial（Review路由/内容/关闭；共享Git菜单）",
    "没有diff范围/搜索/刷新或真实commit/push；补nonrepo/缺git、staged/unstaged/rename/delete/二进制与多root，入口内容不能代替diff验收",
  ],
  "TERM-01": [
    "C-retry TERM-TAB05关闭/重开新terminal session步骤通过；V-M owner合同；MR SLM13安全门禁JSON parse失败，echo/本树read/office PTY目标未抵达",
    "partial（tab生命周期/设置合同）；FAIL（QA终端门禁解析）",
    "Short13待reviewed static，实际shell/profile/cwd/echo/read/PTY保留仍需运行；IME/链接/resize/clipboard/断线复用和workspace隔离未验",
  ],
  "EXTRA-02": [
    "MR SLM12真实coding侧栏launcher显示Browser且不提供Whiteboard菜单通过；当前treemapping隐藏合同",
    "partial（Whiteboard launcher隐藏负测）",
    "没有canvas/stroke/erase/undo/clear/@引用执行。new handler解构为未使用_onOpenWhiteboard；不伪造launcher。需合法本树QA board前置，whiteboardStore仅内存不期待重启持久化",
  ],
  "SET-01": [
    "QSM01/Q-final中英18页；FL MODE01共用refresh；MR QLA01语言/QLA03模式保存恢复，SLM11 office隐藏新Review/Terminal并保留已有Review通过",
    "partial（语言/模式/已有Review交互/合同）",
    "终端PTY保留因SLM13门禁QA失败未验；系统变化/跨窗口广播/header/本机owner完整冷重启仍缺",
  ],
  "SET-26": [
    "QSM18父页/V-M owner/C-retry任务归档确认；MR QLA08开关未显示FAIL；ARM5全FAIL，08/07旧页位置/默认后留General，后3缺groups/alpha/search",
    "partial（入口/任务归档确认/合同）；FAIL（归档QA位置与页面污染）",
    "列表restore/delete/全删未成功；独立ARM01/05/06+02+03已static READY，QLA08另补General自动归档。未执行不计通过；真实确认删除仅本树synthetic，remote/running/crossroot仍缺",
  ],
};
const changed = [];
text = text
  .split(/\r?\n/u)
  .map((line) => {
    const id = line.match(/^\| <a id="[^"]+"><\/a>([A-Z]+-\d+)/u)?.[1];
    if (!id || !patches[id]) return line;
    const cells = line.split("|");
    if (cells.length !== 7) throw new Error(`Unexpected cells ${id}`);
    changed.push(id);
    const update = patches[id];
    return `| ${cells[1].trim()} | ${cells[2].trim()} | ${update[0]} | ${update[1]} | ${update[2]} |`;
  })
  .join("\n");
if (changed.length !== Object.keys(patches).length) throw new Error("Missing IDs");
const anchors = [...text.matchAll(/<a id="([^"]+)"><\/a>/gu)].map((item) => item[1]);
if (anchors.length !== 87 || new Set(anchors).size !== 87) throw new Error("87 anchors changed");
fs.writeFileSync(file, text);
process.stdout.write(
  JSON.stringify({
    completedAt: summary.completedAt,
    actual: records.length,
    passed: summary.tests.passed,
    failed: summary.tests.failed,
    pending: summary.tests.skipped,
    changed,
    anchors: anchors.length,
  }) + "\n",
);
