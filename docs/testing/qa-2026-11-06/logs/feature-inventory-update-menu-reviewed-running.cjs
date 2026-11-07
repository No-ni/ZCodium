const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const base = path.resolve(__dirname, "..");
const matrixPath = path.join(base, "coverage-matrix.md");
const source = path.join(
  base,
  "runtime/qa-menu-20261106-menu-reviewed/evidence/test-results.ndjson",
);
const records = fs
  .readFileSync(source, "utf8")
  .trim()
  .split(/\r?\n/u)
  .map((line) => JSON.parse(line))
  .slice(0, 23);
if (records.length !== 23 || !records[22].title.startsWith("SLM08:"))
  throw new Error("Expected exact first 23 MR records");
const capturedAt = records.at(-1).capturedAt;
const counts = {
  passed: records.filter((r) => r.passed === true).length,
  failed: records.filter((r) => r.passed === false && r.error).length,
  skipped: records.filter((r) => r.passed === false && !r.error).length,
};
if (counts.passed !== 14 || counts.failed !== 6 || counts.skipped !== 3)
  throw new Error("Unexpected MR snapshot outcomes");
let text = fs.readFileSync(matrixPath, "utf8");
if (text.includes("MR-running23"))
  throw new Error("Snapshot was already applied; preserve later edits");
text = text.replace(
  "证据截点为 local-canonical 完整结束：2026-11-07 02:11:09.378（北京时间；summary `completedAt=2026-11-06T18:11:09.378Z`）",
  "证据截点为 menu-reviewed 运行中前23条记录：2026-11-07 02:31:44.479（北京时间；NDJSON `capturedAt=2026-11-06T18:31:44.479Z`）。已完成批次截至local-canonical的summary `completedAt=2026-11-06T18:11:09.378Z`；menu-reviewed尚无summary/退出码",
);
const evidenceRow =
  "| MR-running23 | menu-reviewed计划5spec/47it仍运行；本截点前23条实际记录14通过/6失败/3pending；未执行后续case不计结果 | [前23条快照](logs/feature-inventory-menu-reviewed-matrix-snapshot.json)、[NDJSON](runtime/qa-menu-20261106-menu-reviewed/evidence/test-results.ndjson)、[运行日志](logs/e2e-qa-menu-20261106-menu-reviewed.log) |";
text = text.replace(/(\| LC\s+\|[^\r\n]+)(\r?\n)/u, `$1$2${evidenceRow}$2`);
const notes =
  "MR-running23仅是运行中截点：QLA完整12条9通过/2失败/1pending，RLM前3条1通过/2失败，SLM前8条4通过/2失败/2pending；RLM04–13、SLM09–15、SPFV及archive在本截点尚无新case。QLA05首个文档链接mock出口完成、社区链接未捕获；QLA08归档开关selector未抵达。QLA07记忆开关持久化和enabled空catalog真实完成，但scope/refresh无入口，按pending保留。SLM05公开归档只有readonly投影，缺runtime复制动作；SLM07本轮Bot配置非空，在注册UI前拒绝，两者不是功能失败。SLM06/08 locator缺失与RLM02 Markdown复制、RLM03 driver超时仍待分层归因。已执行原生清空dialog取消只验证删除/重启前return，不代表清空确认通过。后续结果等待独立NDJSON/summary，不把planned47写成完成。\n\n";
text = text.replace(
  "## 桌面窗口、主导航与帮助菜单（14 组）",
  notes + "## 桌面窗口、主导航与帮助菜单（14 组）",
);
const patches = {
  "NAV-01": [
    "S/Q-final新任务入口；C-retry首发/第二轮通过；MR residual/short before真实公开合成3row归档导入、readonly正文及非draft taskId/真实task item激活",
    "partial（入口/新任务/公开只读导入）",
    "导入仅合成有效archive及HTML input适配，不验原生picker；损坏/schema/取消/重复单飞尚未抵达RLM后续。补无模型/草稿保留与附件归属",
  ],
  "NAV-03": [
    "Q-step四组合plugin-store-root及V-M审计；MR QLA12当前列表/空态、新增市场源risk gate草稿填写后取消，来源数不变通过",
    "partial（入口/来源草稿取消/合同）",
    "未提交安装或访问市场源；补搜索详情、受控加载/空结果/来源错误及本树来源手动安装/失败，不自动拉官方市场",
  ],
  "NAV-06": [
    "Q-final设置路径中英文与18页；MR QLA01底部偏好真实英文/中文/系统即时保存并恢复通过；V-M root语言合同",
    "partial（偏好菜单/设置/合同）",
    "补系统语言实际变化、原生菜单、跨窗口广播、防回环与真实冷重启",
  ],
  "NAV-07": [
    "Q-step深浅主题设置；FL SC13快捷键视觉；MR QLA02底部浅/深/系统主题真实生效并恢复通过",
    "partial（偏好主题/设置/快捷键视觉）",
    "补系统主题实际切换、跨窗口、各预览/终端/插件一致性及手机真机；桌面窄窗不替代手机",
  ],
  "NAV-08": [
    "FL MODE01设置/偏好编码办公共用并refresh保留；MR QLA03偏好模式保存恢复及QLA04实际大小/放大/缩小/恢复通过",
    "partial（模式/缩放菜单交互）",
    "尚未验已有终端/审查tab及PTY保留；缩放边界禁用、改绑、DPI多窗仍缺",
  ],
  "NAV-10": [
    "V-M/V-L帮助/反馈合同；MR QLA05第1文档链接真实菜单mock openExternal目标通过，第2社区未捕获且case失败",
    "partial（文档菜单mock出口/合同）；FAIL（其余帮助出口待归因）",
    "社区/反馈/需求未完成；补目标/禁用/失败重试与中英文，不创建issue或发送消息。mock出口不代表外部网站可用",
  ],
  "NAV-11": [
    "F SM01–05存储扫描/安全清理交互；MR QLA06无自有源隐藏更新、About真实窗口显示ZCodium和当前版本并关闭通过",
    "partial（存储/About/更新隐藏/合同）",
    "日志导出/取消/净化、CPU/网络资源tab未验；自建更新源需隔离另验，不回退官方",
  ],
  "NAV-13": [
    "MR SLM01真实原生变更记录命令仅请求fork mock链接；SLM02开发工具真实开/关恢复；SLM03清空dialog取消保留合成数据，3case通过",
    "partial（原生菜单/取消交互）",
    "[当前命令/取消边界](logs/validation-native-help-attribution.md)；mock不验外连。清空确认/真实删除/重启不执行；补菜单语言与目标窗口",
  ],
  "PRJ-04": [
    "MR SLM04两个合成项目键盘排序Host持久化读回并反向恢复通过",
    "partial（项目键盘排序交互）",
    "未验drag/不同高度、跨项目拖任务、置顶分区、Escape/dragend高亮及重启恢复；手机禁拖需Web",
  ],
  "TSK-02": [
    "MR RLM01四种任务路径/ID复制及filemanager mock出口通过；RLM02点击Markdown复制后捕获0条而case失败，后续拒绝重试未抵达",
    "partial（路径/ID复制/文件管理器mock出口）；FAIL（Markdown复制待归因）",
    "有效readonly导入不是runtime消息复制前置；补空会话/单飞/clipboard拒绝恢复与手机隐藏。只用本树合成路径/mock剪贴板",
  ],
  "CHAT-05": [
    "LC SSC32–140主草稿加引用、child复用/多开/关闭隔离/active路由通过；145 Terminal后选区清空失败；MR SLM05 public readonly投影无runtime copy动作，pending",
    "partial（消息选区/child交互）；FAIL（focus/选区待归因）；BLOCKED（消息复制runtime前置）",
    "[selection时序归因](logs/feature-inventory-local-canonical-attribution.md)：mouseup完整marker后8ms focusin清空，target未识别；/side、/btw、child发送未达。RFC需有限replay运行时消息补复制，不能以readonly投影称通过",
  ],
  "FILE-02": [
    "MR SLM08已打开合成文件右键路线，绝对路径菜单locator缺失，case失败；没有复制/Add to chat/Save取消成功证据",
    "FAIL（文件右键菜单locator待归因）",
    "逐项file/dir/deleted/Unicode、absolute/relative copy mock、另存取消/失败、加到chat与remote能力仍缺；写入限本树。locator缺失不直接认产品菜单丢失",
  ],
  "SET-01": [
    "QSM01/Q-final中英18页；FL MODE01设置/偏好共用且refresh保留；MR QLA01三语言偏好保存恢复、QLA03模式保存恢复通过",
    "partial（语言/模式菜单交互/合同）",
    "系统语言实际变化、header/终端/审查launcher与PTY、跨窗口广播、本机owner完整持久化仍未验",
  ],
  "SET-08": [
    "V-L local-onboarding隔离偏好/损坏恢复合同；MR SLM06找设置侧栏Onboarding按钮缺失，尚未打开引导，case失败；数据目录未操作",
    "partial（引导合同）；FAIL（引导入口QA locator待归因）；NOT-RUN（数据目录动作）",
    "SettingsPage侧栏Rocket与general第二入口均现有，不能18section代表全部；补当前真实按钮进入/退出/完成，目录非法/dirty/restart限本树",
  ],
  "SET-14": [
    "QSM13入口；MR QLA09 Browser总开关就绪后真实切换、保存/恢复且Windows无Chrome导入通过",
    "partial（入口/浏览器总开关交互）",
    "未导入/清缓存/证书/清数据；owner写失败、同意取消、二次确认/Web/remote提示仍缺，只用本树profile不读真实Chrome",
  ],
  "SET-15": [
    "QSM14入口；MR QLA10 Windows Computer Use总开关与composer显隐标志真实持久化/切换恢复通过，未申请系统权限或操作电脑",
    "partial（Windows开关/composer显隐）；BLOCKED（macOS/权限条件）",
    "Win/mac能力、未知失效/缺权限、重复请求、开关写失败与子Agent禁用仍缺；真机权限和动作独立列证据",
  ],
  "SET-18": [
    "QSM06入口；V-L汇总模型合同；MR QLA07开关即时保存/恢复、enabled空catalog实际通过，缺scope/refresh入口，整case pending",
    "partial（开关持久化/空catalog/汇总合同）；BLOCKED（scope/refresh合成记录前置）",
    "补本树saved-memory项目catalog、scope切换/refresh/search/更新时间与多项目顺序；开关写失败/模型缺失/default/local only仍缺，不把pending算整case通过",
  ],
  "SET-23": [
    "QSM12入口；MR QLA11等待稳定空态/列表，真实新建Hook草稿填写、取消且配置fingerprint不变通过；未执行command",
    "partial（稳定列表/新建草稿取消）",
    "尚未保存/启停/执行Hook；event/env/顺序、trust、删除确认/取消、rewrite/race/导入scope均缺；命令仅本树fixture",
  ],
  "SET-26": [
    "QSM18归档父页；V-M owner合同；C-retry任务归档确认通过；MR QLA08在general查自动归档开关selector未显示，case失败未改值",
    "partial（入口/任务归档确认/合同）；FAIL（自动归档QA selector待归因）",
    "archive5本截点尚无case；settings restore/delete/全部删除、3/7/14/30保存、running guard、取消/local/remote/跨root与重启仍缺",
  ],
  "EXTRA-03": [
    "LC TRJ自动writer旧前置失败，fork仅保留历史只读viewer；HIST01/02外置公开导入+wx历史计划/static READY，无UI结果",
    "FAIL（旧自动录制QA合同）；BLOCKED（历史viewer执行前置）",
    "[归因](logs/feature-inventory-local-canonical-attribution.md)、[历史专项计划](test-plan-historical-trajectory.md)；静态准入不计viewer通过。待HIST2实际展开/复制/虚拟查找/有界尾读；不恢复writer",
  ],
  "BOT-01": [
    "V-L桥路由合同；MR SLM07本轮Bot配置非空，在注册UI前拒绝，pending，无新增/渠道选择动作",
    "NOT-RUN（管理UI）；BLOCKED（合成Bot前置）",
    "补显式合成fixture的管理入口/选择前取消/配置不变；name/model/tools/scope、增删与绑定仍缺，不发渠道消息",
  ],
};
const changed = [];
text = text
  .split(/\r?\n/u)
  .map((line) => {
    const id = line.match(/^\| <a id="[^"]+"><\/a>([A-Z]+-\d+)/u)?.[1];
    if (!id || !patches[id]) return line;
    const cells = line.split("|");
    if (cells.length !== 7) throw new Error(`Unexpected table cell shape ${id}`);
    const patch = patches[id];
    for (const value of patch) if (value.includes("|")) throw new Error("Table separator in patch");
    changed.push(id);
    return `| ${cells[1].trim()} | ${cells[2].trim()} | ${patch[0]} | ${patch[1]} | ${patch[2]} |`;
  })
  .join("\n");
if (changed.length !== Object.keys(patches).length) throw new Error("Missing matrix IDs");
const ids = [...text.matchAll(/<a id="([^"]+)"><\/a>/gu)].map((match) => match[1]);
if (ids.length !== 87 || new Set(ids).size !== 87) throw new Error("87 stable anchors changed");
fs.writeFileSync(matrixPath, text, "utf8");
const proof = {
  capturedAt,
  evidenceKind: "Actual first 23 NDJSON records from running MR; no completion implied",
  source: path.relative(base, source).replaceAll(path.sep, "/"),
  recordPrefixSha256: crypto.createHash("sha256").update(JSON.stringify(records)).digest("hex"),
  counts,
  changed,
  records,
};
fs.writeFileSync(
  path.join(__dirname, "feature-inventory-menu-reviewed-matrix-snapshot.json"),
  JSON.stringify(proof, null, 2) + "\n",
);
process.stdout.write(JSON.stringify({ capturedAt, counts, changed, anchors: ids.length }) + "\n");
