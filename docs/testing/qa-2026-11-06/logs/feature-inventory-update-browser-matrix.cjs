"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const base = path.resolve(__dirname, "..");
const matrixPath = path.join(base, "coverage-matrix.md");
async function records(run) {
  const root = path.join(base, "runtime", run, "evidence");
  const summary = JSON.parse(await fs.readFile(path.join(root, "summary.json"), "utf8"));
  const cases = (await fs.readFile(path.join(root, "test-results.ndjson"), "utf8"))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(JSON.parse);
  return { summary, cases };
}
(async () => {
  for (const candidate of [base, matrixPath]) {
    if (
      (await fs.lstat(candidate)).isSymbolicLink() ||
      (await fs.realpath(candidate)).toLowerCase() !== candidate.toLowerCase()
    )
      throw new Error("Redirected documentation target");
  }
  const browser = await records("qa-menu-20261106-browser");
  const menu = await records("qa-menu-20261106-menu-final");
  if (
    browser.cases.length !== 4 ||
    browser.cases.filter((item) => item.passed).length !== 2 ||
    menu.cases.length !== 1 ||
    menu.cases[0].passed
  )
    throw new Error("Run evidence changed; review required");
  let text = await fs.readFile(matrixPath, "utf8");
  text = text.replace(
    /证据截点为 filtered 完整结束：[^，]+（北京时间；summary `completedAt=[^`]+`）/u,
    "证据截点为 menu-final 完整结束：2026-11-07 01:49:19.440（北京时间；summary `completedAt=2026-11-06T17:49:19.440Z`）",
  );
  const row = (id, title, evidence, status, gaps) =>
    `| <a id="${id.toLowerCase()}"></a>${id} | ${title} | ${evidence} | ${status} | ${gaps} |`;
  const replaceRow = (id, replacement) => {
    const expression = new RegExp(
      '^\\| <a id="' + id.toLowerCase() + '"></a>' + id + "\\s+\\|[^\\r\\n]+",
      "m",
    );
    if (!expression.test(text)) throw new Error("Missing matrix row " + id);
    text = text.replace(expression, replacement);
  };
  replaceRow(
    "BROW-01",
    row(
      "BROW-01",
      "地址导航/历史/重载、responsive/选元素/外部打开/devtools",
      "B真实空tab/URL草稿0guest，Enter后单guest并loopback导航通过；viewport在重启后Open Tab/add入口缺失失败",
      "partial（地址/guest交互）；FAIL（重启入口，待归因）",
      "原F入口阻塞已不概括本组；重启后responsive偏好结果未验。补无效URL/cert/error/retry、历史/选择元素/外部打开/zoom；不以桌面尺寸模拟替代手机",
    ),
  );
  replaceRow(
    "BROW-02",
    row(
      "BROW-02",
      "站点权限/JS dialog/下载/新窗",
      "B与M-final各1实际case均在初始geolocation query断言失败：期待denied、实际granted；尚未点击滑杆、allow或reset",
      "FAIL（初始权限合同/运行时，待归因）",
      "两次失败保留，不能声称权限菜单/allow/reset执行。补origin隔离/撤销、询问/session/persistent、JS dialog、popup/teardown、下载；产物仅本树，真实设备权限另验",
    ),
  );
  replaceRow(
    "BROW-03",
    row(
      "BROW-03",
      "tab生命周期、Agent/人工视图、截图录制",
      "B BTC01真实首关与同tab重复IPC关闭通过；residency beforeAll重解析点guard拒绝，无case",
      "partial（关闭幂等交互）；BLOCKED（residency QA边界）",
      "guard当刻未输出绝对节点；随后两种不跟随扫描found0，不据此放宽guard或确认目标安全。补33逻辑tab/重启清空、跨workspace/hidden guest、capture/record及输出范围",
    ),
  );
  replaceRow(
    "NAV-13",
    row(
      "NAV-13",
      "原生帮助：变更记录/开发工具/清除全部数据",
      "没有本轮菜单动作执行；M-final SLM beforeAll stale element，0case",
      "NOT-RUN",
      "[当前命令/取消边界](logs/validation-native-help-attribution.md)仅只读定位；补真实MenuItem+受控外部打开、开发工具开关、清除dialog取消。取消只覆盖删除/重启前return；确认清空不执行",
    ),
  );
  text = text.replace(
    /SPT旧logo\/样式失败\s+\|/u,
    "SPT旧logo/样式失败；M-final SPFV被OpenSidePane QA前置中止0case |",
  );
  if (!/^\| B\s+\|/mu.test(text)) {
    const start = text.indexOf("| FL ");
    if (start < 0) throw new Error("Missing evidence table FL");
    const end = text.indexOf("\n", start);
    text =
      text.slice(0, end) +
      "\n| B | Browser 5spec完成、4 actual cases：2通过/2失败，exit1；residency beforeAll拒绝无case | [NDJSON](runtime/qa-menu-20261106-browser/evidence/test-results.ndjson)、[summary](runtime/qa-menu-20261106-browser/evidence/summary.json)、[日志](logs/e2e-qa-menu-20261106-browser.log)、[当前Node不跟随扫描](logs/feature-inventory-browser-reparse-node.json)、[PS7不跟随扫描](logs/feature-inventory-browser-reparse-powershell.json) |\n| M-final | 菜单/残余/short/SPFV/权限共5spec结束；仅权限1实际case失败，exit1；前三菜单及SPFV hook均0case | [NDJSON](runtime/qa-menu-20261106-menu-final/evidence/test-results.ndjson)、[summary](runtime/qa-menu-20261106-menu-final/evidence/summary.json)、[workers](runtime/qa-menu-20261106-menu-final/evidence/workers.ndjson)、[日志](logs/e2e-qa-menu-20261106-menu-final.log) |" +
      text.slice(end);
  }
  const paragraph =
    "B在2026-11-06T17:39:28.502Z完整结束：2通过为延迟guest导航与关闭幂等；2失败分别为初始geolocation实际granted及viewport重启后入口missing。residency被queue目录重解析点guard拒绝，无case。日志没有保存当刻queue绝对节点，之后Node扫描10687节点和PS7扫描524目录均found0/errors0；这些当前扫描不能恢复当刻节点/类型/目标，不证明guard误报或目标安全。M-final在17:49:19.440Z结束，唯一权限case仍初始granted失败；QLA/SLM beforeAll stale element、RLM导入任务未持久化/激活、SPFV root OpenSidePane失败均0case，不能登记未执行菜单功能为产品失败。";
  if (!text.includes("B在2026-11-06T17:39:28.502Z"))
    text = text.replace(
      "## 桌面窗口、主导航与帮助菜单",
      paragraph + "\n\n## 桌面窗口、主导航与帮助菜单",
    );
  const rows = text.split(/\r?\n/).filter((line) => /^\| <a id=/u.test(line));
  if (rows.length !== 87) throw new Error("87 group invariant failed");
  const status = (line) => line.split("|")[4];
  const notRun = rows.filter((line) => status(line).includes("NOT-RUN"));
  const blocked = rows.filter((line) => status(line).includes("BLOCKED"));
  const failed = rows.filter((line) => status(line).includes("FAIL"));
  const union = rows.filter((line) => /NOT-RUN|BLOCKED/u.test(status(line)));
  text = text.replace("## filtered截点的未执行与环境缺口", "## menu-final截点的未执行与环境缺口");
  text = text.replace(
    /以下是当前87行状态标签的去重统计，[^\r\n]+/u,
    "以下是当前87行状态标签的去重统计，依据已结束的filtered、Browser与menu-final实际case刷新。local-canonical待执行，不预先计入通过。**不是整组覆盖率**；其余partial行仍有未覆盖动作。",
  );
  text = text.replace(
    /- 含`NOT-RUN`的[^\r\n]+/u,
    `- 含\`NOT-RUN\`的${notRun.length}组；含\`BLOCKED\`的${blocked.length}组；两者交集为SET-13一组，合计${union.length}个唯一组。另有${failed.length}组含\`FAIL\`标签，需结合各行失败层级判断。`,
  );
  text = text.replace(
    /- 28组中，[^\r\n]+/u,
    `- ${union.length}组中，${union.length - 8}组仍有当前隔离Windows工作树可继续执行的本地动作缺口；其中BROW-03已有关闭幂等partial，但residency未抵达。不能把本地QA前置归因于没有mac、手机或远端。`,
  );
  text = text.replace(
    /\| 本地Browser\/pane \|[^\r\n]+/u,
    "| 本地Browser/pane | [BROW-03](#brow-03) | residency重解析点当刻证据未确认，重新guard通过才可跑；BROW-01已有导航局部交互、BROW-02已有初始断言失败，不再当无执行组，权限/viewport后续动作仍未验 | ",
  );
  await fs.writeFile(matrixPath, text);
  process.stdout.write(
    JSON.stringify({
      rows: rows.length,
      notRun: notRun.length,
      blocked: blocked.length,
      failed: failed.length,
      union: union.length,
      localUncoveredOrBlocked: union.length - 8,
      externalConditional: 8,
    }) + "\n",
  );
})().catch((error) => {
  process.stderr.write(error.stack + "\n");
  process.exitCode = 1;
});
