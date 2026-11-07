"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");

(async () => {
  const qa = path.resolve(__dirname, "..");
  const target = path.join(qa, "coverage-matrix.md");
  const summaryPath = path.join(
    qa,
    "runtime/qa-menu-20261106-local-canonical/evidence/summary.json",
  );
  for (const candidate of [target, summaryPath]) {
    for (let cursor = candidate; ; cursor = path.dirname(cursor)) {
      const stat = await fs.lstat(cursor);
      if (
        stat.isSymbolicLink() ||
        (await fs.realpath(cursor)).toLowerCase() !== cursor.toLowerCase()
      )
        throw new Error("Redirected matrix input");
      if (cursor.toLowerCase() === qa.toLowerCase()) break;
    }
  }
  const summary = JSON.parse(await fs.readFile(summaryPath, "utf8"));
  if (
    summary.completedAt !== "2026-11-06T18:11:09.378Z" ||
    summary.tests.total !== 13 ||
    summary.tests.passed !== 8 ||
    summary.tests.failed !== 5 ||
    summary.exitCode !== 1
  )
    throw new Error("Unexpected actual canonical summary");
  let text = await fs.readFile(target, "utf8");
  const rows = {
    "TSK-05": [
      "LC TSL08真实冷重启后draft已显示，但活动path仍等于已移动项目；76行失败，尚未输入或刷新",
      "partial（冷启动draft入口）；FAIL（活动路径断言，待归因）",
      "先核reload/seed/启动owner与路径事实；输入、刷新、切项目草稿/附件绑定、离线禁止冒写及恢复发送未抵达",
    ],
    "CHAT-02": [
      "FL模型/推理/模式投影、usage、tooltip、slider/outside click通过；LC responsive独立失败，真实240px两帧无compact flag且overflow，与测量副本缺骨架吻合",
      "partial（模型/推理菜单交互）；FAIL（QA旧合同/布局实证）",
      "[布局归因](logs/feature-inventory-local-canonical-attribution.md)与[原函数probe](logs/feature-inventory-fit-probe.json)；不修旧badge/highspeed/group helper。管理进入、排序搜索/删除禁用、长名真实窄窗、菜单节点/焦点保持及运行中切换未验",
    ],
    "CHAT-05": [
      "LC SSC32–140主草稿加引用保留文字、child复用/多开/关闭隔离/active路由真实通过；145切Terminal后选区清空失败",
      "partial（消息选区/侧边问答交互）；FAIL（focus/选区待归因）",
      "[selection时序归因](logs/feature-inventory-local-canonical-attribution.md)：mouseup已有完整marker，8ms后focusin清空但target未识别；后续/side、/btw、child发送未达。补消息复制/格式、失败clipboard、单条限制与移动端",
    ],
    "FILE-01": [
      "C-retry文件树rename刷新/新文件watcher1case；LC FTS两case深层Java未展开搜索预览、目录搜索返回树态逐级展开定位通过",
      "partial（watcher/rename/搜索定位交互）",
      "补删除/手动刷新、sticky/Git标记、ignore、大目录、多root与远端失联；MPS未转义Windows selector不证明点目录隐藏或row丢失",
    ],
    "FILE-03": [
      "LC FTS深层Java真实打开预览通过；MPS37–38的Windows路径CSS selector未转义，未到Markdown选择",
      "partial（源码预览交互）；FAIL（Markdown QA selector）",
      "[静态selector证明](logs/feature-inventory-mps-selector-probe.json)仅归因，不计UI通过；补Markdown真实读取/选择、SVG、损坏/二进制、动态刷新和外观设置",
    ],
    "FILE-04": [
      "LC PIA01各格式/Latin1 SVG另存原字节及取消、PIA02追加文件引用保留空/非空草稿和附件且不发送，两case通过",
      "partial（图片保存/取消/引用交互）",
      "PNG/APNG/BMP/ICO/SVG均本树合成；SaveDialog仅适配本树出口，未验真实picker/系统clipboard。缩放、拖拽、编辑、裁剪/旋转、损坏图与原生保存失败仍缺",
    ],
    "FILE-05": [
      "LC OPS01 PPTX tooltip字面HTML文本及本树PDF导出、OPS02 XLSX Canvas/形状/图片外链校验两case通过",
      "partial（PPTX/XLSX安全预览/导出交互）",
      "受控window.open/本树save出口，不下载字体；PDF/DOCX/DOC/音视频、多页slide/sheet导航缩放、损坏/生成中及播放控制未验",
    ],
    "PANE-01": [
      "C-retry responsive9/full-view6case通过；FL SPFV001保留节点通过、00264px阈值失败且observer无DOM；LC SSC多child开关/身份隔离通过，Terminal后选区失败；M-final SPFV hook0case",
      "partial（pane/child交互）；FAIL（QA合同/布局或focus候选）",
      "SPFV独立001+002无OpenSidePane已合menu-reviewed，pending不计结果；补完整拖排/overview/context/Agent、人机交接、terminal焦点时序与远端，旧logo/5px样式不修产品",
    ],
    "BROW-02": [
      "B与M-final各1case：真实guest初始geolocation query期待denied、实际granted；源码权限策略装配遗漏与两run一致，确认BUG-005",
      "FAIL（已确认产品权限接线）",
      "[源链归因](logs/validation-browser-permission-attribution.md)；未点击slider/allow/reset、未请求真实位置/摄像头。补origin隔离、决策/session/persistent、撤销重启、JS dialog/popup/下载；真实设备另验",
    ],
    "EXTRA-03": [
      "LC TRJ46/276等待自动model-io writer失败；当前fork已删除recorder，仅保留历史只读viewer，后续80条/查找/33MiB未达",
      "FAIL（旧自动录制QA合同）；BLOCKED（历史viewer前置）",
      "[当前维护合同归因](logs/feature-inventory-local-canonical-attribution.md)；外置公开导入合成task+本树独占历史JSONL可补viewer，不恢复writer、不用seed宣称录制通过；开发门禁/净化/展开复制/有界尾读仍未验",
    ],
    "SET-19": [
      "QSM07入口；FL无关OpenSidePane hook0case；LC无OpenSidePane独立SE02/03两case通过：切模型物化默认reasoning、删已选模型后不恢复候选/不可保存",
      "partial（入口/user模型表单交互）",
      "只验user两项；名称/tools/prompt/内置override/scope、增删启用、持久化及写失败等仍缺；SE01/04旧workspace/官方插件夹具排除",
    ],
  };
  for (const [id, values] of Object.entries(rows)) {
    const lines = text.split(/\r?\n/u);
    const index = lines.findIndex(
      (line) => line.startsWith("| <a id=") && line.includes(`></a>${id} `),
    );
    if (index < 0) throw new Error(`Missing row ${id}`);
    const cells = lines[index].split("|").map((cell) => cell.trim());
    lines[index] = `| ${cells[1]} | ${cells[2]} | ${values.join(" | ")} |`;
    text = lines.join("\n");
  }
  text = text.replace(
    /证据截点为 menu-final 完整结束：[^，]+（北京时间；summary `completedAt=[^`]+`）/u,
    "证据截点为 local-canonical 完整结束：2026-11-07 02:11:09.378（北京时间；summary `completedAt=2026-11-06T18:11:09.378Z`）",
  );
  if (!text.includes("| LC ")) {
    const marker = "\n确定性独立用例合计";
    text = text.replace(
      marker,
      "\n| LC | local-canonical 9spec完整结束、13case：8通过/5失败，exit1；PIA2/FTS2/OPS2/SE2通过，MPS/SSC/TRJ/TOOLBAR/TSL08失败 | [NDJSON](runtime/qa-menu-20261106-local-canonical/evidence/test-results.ndjson)、[summary](runtime/qa-menu-20261106-local-canonical/evidence/summary.json)、[分层归因](logs/feature-inventory-local-canonical-attribution.md)、[fit真实DOM](runtime/qa-menu-20261106-local-canonical/evidence/qa-composer-fit-0-6-001-30916-1793988522119.json) |\n" +
        marker,
    );
  }
  const paragraph =
    "LC在2026-11-06T18:11:09.378Z完整结束：9spec、13case、8通过/5失败。正常PIA/FTS/OPS/SE断言只代表表列范围；MPS是Windows selector缺陷，TRJ是已删除自动writer旧前置，SSC是在大量child交互完成后Terminal切换清空选区，TOOLBAR两真实240px帧与缺骨架probe吻合，TSL08在输入前活动path断言失败。三菜单40、SPFV2、归档5的menu-reviewed仍是计划；residency独立重跑未获结果，不预计47或限额通过。\n\n";
  if (!text.includes("LC在2026-11-06T18:11:09.378Z"))
    text = text.replace("## 项目与任务", paragraph + "## 项目与任务");
  text = text.replace(
    "## menu-final截点的未执行与环境缺口",
    "## local-canonical截点的未执行与环境缺口",
  );
  text = text.replace(
    "以下是当前87行状态标签的去重统计，依据已结束的filtered、Browser与menu-final实际case刷新。local-canonical待执行，不预先计入通过。",
    "以下是当前87行状态标签的去重统计，依据已结束的filtered、Browser、menu-final与local-canonical实际case刷新。新menu-reviewed与residency结果未到，不预先计入通过。",
  );
  const actualRows = text
    .split("\n")
    .filter((line) => line.startsWith("| <a id="));
  if (actualRows.length !== 87) throw new Error("Matrix must retain 87 rows");
  const tagged = (tag) =>
    actualRows.filter((line) => line.split("|")[4].includes(tag));
  const notRun = tagged("NOT-RUN");
  const blocked = tagged("BLOCKED");
  const fail = tagged("FAIL");
  const overlap = notRun.filter((line) => blocked.includes(line));
  const union = new Set([...notRun, ...blocked]);
  text = text.replace(
    /- 含`NOT-RUN`的\d+组；含`BLOCKED`的\d+组；两者交集为SET-13一组，合计\d+个唯一组。另有\d+组含`FAIL`标签，需结合各行失败层级判断。/u,
    `- 含\`NOT-RUN\`的${notRun.length}组；含\`BLOCKED\`的${blocked.length}组；两者交集为SET-13一组，合计${union.size}个唯一组。另有${fail.length}组含\`FAIL\`标签，需结合各行失败层级判断。`,
  );
  text = text.replace(
    /- 26组中，18组仍有/u,
    `- ${union.size}组中，${union.size - 8}组仍有`,
  );
  text = text.replace(
    "[NAV-13](#nav-13)、[PRJ-04](#prj-04)、[TSK-02](#tsk-02)、[TSK-05](#tsk-05)",
    "[NAV-13](#nav-13)、[PRJ-04](#prj-04)、[TSK-02](#tsk-02)",
  );
  text = text.replace(
    "[CMD-03](#cmd-03)、[CHAT-05](#chat-05)",
    "[CMD-03](#cmd-03)",
  );
  text = text.replace(
    "[FILE-02](#file-02)、[FILE-03](#file-03)、[FILE-04](#file-04)、[FILE-05](#file-05)、[GIT-02](#git-02)",
    "[FILE-02](#file-02)、[GIT-02](#git-02)",
  );
  text = text.replace(
    "[EXTRA-02](#extra-02)、[EXTRA-03](#extra-03)、[SET-07](#set-07)、[SET-08](#set-08)、[SET-19](#set-19)、[BOT-01](#bot-01)",
    "[EXTRA-02](#extra-02)、[EXTRA-03](#extra-03)、[SET-07](#set-07)、[SET-08](#set-08)、[BOT-01](#bot-01)",
  );
  text = text.replace(
    "## 计划批次以后仍需补到的最短本地清单",
    "## 历史计划推算与最短本地候选（不是当前结果）",
  );
  text = text.replace(
    "这是按local12、filtered23、Browser5、residual13的**计划范围推算**",
    "以下保留早于local-canonical的候选选择过程；现行状态以上方87行和去重清单为准。这是按local12、filtered23、Browser5、residual13的**历史计划范围推算**",
  );
  await fs.writeFile(target, text);
  process.stdout.write(
    JSON.stringify({
      target,
      rows: actualRows.length,
      notRun: notRun.length,
      blocked: blocked.length,
      overlap: overlap.length,
      union: union.size,
      localUnion: union.size - 8,
      externalUnion: 8,
      fail: fail.length,
    }) + "\n",
  );
})().catch((error) => {
  process.stderr.write(error.stack + "\n");
  process.exitCode = 1;
});
