# menu-reviewed 外置 QA 失败归因与补测边界

本文件只读分析 root 执行的 `qa-menu-20261106-menu-reviewed`，原[日志](logs/e2e-qa-menu-20261106-menu-reviewed.log)和run evidence不改写。产品代码、canonical spec、bootstrap和runner均未修改。以下静态READY不计UI PASS；实际功能统计由test-report和原NDJSON记录。

## QLA worker0-0

12项实际9PASS/2FAIL/1LIMITED-SKIP。原suite SHA256 `07f2557d74b5d4068d1e48b8c86929a3573cfc2659fe8997fb40cb5b122bd31c`；修后 `fb3c4976fb123617561f22e6de64b02e428070ec29f1510be1c45298aad98b2d`。

- QLA05 首 Product docs 的fork链接已捕获；第二User community真实点击后没有外部callback。开发stage仅复制main/host/renderer，Main readDesktopHelpConfig按真实appPath计算的仓库config前置可能不存在。仅在新runstage内且缺失时，以本仓已审config/default.json独占写入，拒绝共享cache/外树/已存在target/重解析点，再真实菜单且完整拦shell.openExternal。新runtime appPath若公式落共享目录，仍BLOCKED不写。该前置修正未在本文件时点实际跑过，不登记发布包帮助缺陷。
- QLA08 错误打开archives列表，auto-archive开关实际属于GeneralSectionContent；只改QA `openSettings("general")`。新run仍真实设置、保存和恢复。
- QLA07 实际memory总开关保存/恢复通过，但合成配置没有saved memory catalog，scope/refresh明确LIMITED，不能把没有目录当产品缺memory功能。

计划和静态证据：[QLA plan](test-plan-local-menu-actions.md)、[18:26:21UTC static](logs/e2e-preflight-qla-reviewed-static.json)。补测Grep `(?:^| )QLA(?:05|08):`，只选两项；Mocha按suite fullTitle过滤，裸it stub的起始锚不能证明准入。

## RLM worker0-1

beforeAll已真实导入公开alpha并激活，DB精确title为`Imported: RLM_TASK_中文_01`。RLM01四路径/ID和文件管理器mock实际PASS。RLM02 clipboard无Markdown新增，RLM03点击未读后的WebDriver session持续超时，RLM04–13未抵达功能动作。

RLM02不能仅凭捕获次数0认产品复制损坏或exactly-once断言过严。当前Markdown读取agent.conversationRowsRangeV4；公开归档header只读展示未提供runtimehistory，读取empty是合理候选。但现场没有RPC rows/code摘要或即时empty toast，尚未证实，所以没有修改原RLM02断言。正向由独立RFC真实replay runtimehistory后的RMC03补成功、拒绝、恢复，系统clipboard write/writeText均被拦。

RLM03 18:23:36.152菜单可见，.266–.321真实Mark as unread点击返回；下一task row findElement自.934起超时，之后同WebDriver session DOM/reset/afterEach也超时。finally reset错误覆盖最早element错误，不能把下游十项各登记功能FAIL，也不能凭时间相近归因其它置顶RPC。原始链见[validation会话归因](logs/validation-menu-reviewed-session-attribution.md)。旧worker已退出，不干预其进程或用户数据。

原suite SHA256 `797b81824a904bc37d275408eb63cd18e936e098a3368a2a182110a9e63a1aac`；修后仅Skills导航`skills`→当前`skill`，SHA `2eb73bb1cb66625d0d074c71ecfe68649c43d29b0e1c57442c12d8499fa70ab7`。十项beforeAll独立alpha/file/beta前置与顺序已审，详见[plan](test-plan-residual-local-menus.md)。Grep `(?:^| )RLM-(?:0[4-9]|1[0-3]):`；[静态](logs/e2e-preflight-residual-static.json)不包含UI/Host执行；实际fullTitle选中以inventory合并probe为准。

## SLM worker0-2

15项实际7PASS（01/02/03/04/10/11/12）、5FAIL（06/08/09/13/15）、3SKIP（05/07/14）。原loaded SHA `eaca839f6ba0a303d46adac1027745a7f898145d6d87463ddf70214571d2de1c`；修后SHA `abb2086e369104e2dd2e0a47405966296ea254e9aa8aefd426ae1a1906f39fbe`。

- 06实际英语侧栏为Onboard，原Onboarding matcher错误；只改QA matcher，两个入口仍真正进入/退出onboarding。
- 08右键菜单在[失败帧](runtime/qa-menu-20261106-menu-reviewed/evidence/qa-short-local-menus-0-2-7176-1793989664768/SLM08-frames/captured-000002.png)真实显示Copy absolute/relative/Save/Add；下一帧side pane已关。日志124562匹配index3/e232正确，之后QA scrollIntoView发wheel18，18:30:42.198 waitForClickable发生stale，尚未真正elementClick。09此前Add to chat已产生mention，后Save菜单同helper失败；15同helper单击文件后preview未显。不能把这些证据写为产品文件菜单缺失。补测限定open context-menu，等待唯一目标几何和hit稳定，保存独占目标PNG/JSON，重新收敛后新句柄真实pointer点击；不注入事件、不调用onSelect、不额外wheel。
- 13在PTY前NoProfile探针返回结构对象，原JSON.parse产生`[object Object]`错误，是QA解析阶段失败。修正只接受完整严格object或JSON字符串，8项shape反例均拒；所有实际Main/Host环境继承、PSModulePath/cache、四profile和reparse门禁保留。不能把纯shape/static或root prelaunch probe称真实Terminal通过。
- 05和14公开readonly marker存在，缺runtimecopy/Findindex为已记录fixture边界：[05](runtime/qa-menu-20261106-menu-reviewed/evidence/qa-short-local-menus-0-2-7176-1793989664768/015-SLM05-readonly-fixture-boundary.json)、[14](runtime/qa-menu-20261106-menu-reviewed/evidence/qa-short-local-menus-0-2-7176-1793989664768/038-SLM14-readonly-fixture-boundary.json)。保持真实SKIP，由RFC/RMC补运行时正向路径。
- 07只读本run已隔离HOME的bot-config.v3.json确认version3/bots数组实际1项AstrBot/astrbot，非空guard正确。保留[实际SKIP](runtime/qa-menu-20261106-menu-reviewed/evidence/qa-short-local-menus-0-2-7176-1793989664768/020-SLM07.json)，未清除/覆写配置，未进入provider注册。

[SLM plan](test-plan-short-local-menus.md)与[18:45:23UTC static](logs/e2e-preflight-short-static.json)。Grep `(?:^| )SLM(?:06|08|09|13|15):`只选五项，SafeTerminal必需，不预开side pane。正式UI结果仍待root串行新run，Mocha fullTitle过滤准入见inventory合并probe。

## 补测参数与剩余证据

QLA2+RLM10+SLM5+RFC/RMC3+HIST2为5spec/22it，所有spec独立worker串行；前者只断言Provider请求不增，RFC仅允许exact common+chat-find两fixture。ARM三it另run，只common+archive；不扩RFC未知fixtureguard、不执行ARM07旧入口。全global Grep由root/inventory现有合并plan锁定。

本环境没有标准WebM编码器。交互失败证据是PNG/时间帧序列，未编码WebM不登记为视频。此次QA适配只证明静态、类型、解析与受限前置，没有修复任何产品行为，也未触及真实用户目录、真实clipboard/OSpicker、网络服务或产品外文件。
