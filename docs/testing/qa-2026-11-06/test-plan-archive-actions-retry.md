# 归档行操作最小补测计划

状态：**真实执行完成，2actual PASS、exit0；保留外置pending未转正**。不修产品、不改canonical/assertion/timeout，不恢复旧设置布局。root唯一串行UI执行，新增文件为`manual-review/pending/qa-archive-actions-20261106.test.ts`，2it顺序保留，独立新run限定`qa-menu-20261106-archive-actions-final`。

## 当前失败与排除范围

独立archive-list-retry的[NDJSON](runtime/qa-menu-20261106-archive-list-retry/evidence/test-results.ndjson)、CLI末段与源码联核为3it：ARM01/05/06 FAIL、ARM02 FAIL、ARM03 PASS。第一条已完成展开/收起、搜索、时间排序和项目选择，到`captureArchiveLayouts`第452行才寻找Archives内已迁到General的`archive-auto-archive-switch`失败；该helper第417行先收起所有组，未执行退出后的setArchiveGroupsOpen(true)。第二条第320行直接找未挂载的alpha行失败，未restore/cancel/delete；不能将其认作会话消失。第三条确实在Unclassified筛选确认仅删1个、落库且其它任务保留，并执行group-unarchive后group消失、scheduled归档清零；不重复ARM03。

新计划仅补行级恢复和单会话删除取消/确认后重启不复活。General自动归档控件已由QLA08真实保存恢复通过，不再改它；新seed使用当前时刻created/updated，不修改默认配置。若不能证明路径边界直接失败，不放宽guard。QAR02明确依赖QAR01恢复成功，前条失败时后条在任何UI动作前停止，保留依赖原因，不误报新的删除产品问题。

## 既有owner与accepted场景

| ID | 前置与真实动作 | 已有合同与验收 | 排除 |
| --- | --- | --- | --- |
| QAR01 | 退出屏障后只向本run双库播种3个独占合成归档任务；真实进入Archives、查询owned prefix、明确展开own group，再点第一行取消归档 | ArchiveGroupCard默认closed且关闭不挂载行；useArchiveManagement冻结完整候选身份、mutateProjectTask单owner。目标行消失，Host archived=0/cli_deleted=0、CLI session仍存在，其它2个保持归档；保持scope完整 | 不重复主题布局/排序/批量group restore；不发prompt |
| QAR02 | 用第二个own archived row点击删除→Escape取消；核库与行不变、busy释放；再次点击并确认，只删第二个；正式helper冷重启后再从真实菜单进入Archives并展开own group | 取消在confirm return前不执行mutate；确认仅1个候选，Host cli_deleted与CLI time_deleted持久。删除行不复活，第三个archived/未删保留，第一恢复仍未删 | 不重复已PASS的filter bulk-delete；不操作真实/远端/running会话，不物理删除CLI历史 |

## 写入与生命周期边界

按已审canonical的`restartIntoWorkspacePreservingProfile(workspace,{afterElectronProcessExit})`复用正式退出屏障。仅在afterElectronProcessExit回调旧Electron/Host退出后写本run `.zcodium/v2/tasks-index.sqlite`与`.zcodium/cli/db/db.sqlite`；SQLite表、meta_json与CLI session shape复用当前canonical，ID带本次pid/timestamp独占前缀，插入前断言ID不存在。不导入注册it的旧spec，不写产品仓库或其他run，不清理已有数据。项目/roots/workspace来自当前隔离DEFAULT_WORKSPACE；输入及HOME/artifacts/TEMP/cache祖先和子项拒绝reparse/redirect。

路径检查和PS7不跟随子项审查先执行；合成seed目录限定当前run。write JSON/PNG使用独占wx，失败afterEach保存状态与错误。新spec无模型请求，记录回放请求数始末相等。独立run只需Bootstrap，无OpenSidePane/SafeTerminal/SafeGit；finite common+archive.json可沿现有明确列表，不影响其他运行中的suite。

第一次冷重启在suite beforeAll，beforeEach reload observer尚未装载：只称正式helper退出屏障，不声称有独立PID JSON。QAR02内冷重启位于it，可被现有observer捕获；仍以实际输出为证据，缺JSON不伪造PID。失败不绕过storage flush、退出或重启屏障。

## 静态准入与执行限制

静态必须真实describe/fullTitle精确注册2、排除0；noEmit/lint/rawJS parse/闭包及source SHA；独占路径与SQLite seed纯schema核验，不启动UI或写真实用户数据。完成后root决定独立串行运行，不与已在执行的GRP/supplement共享UI/build。真实通过后才回填SET-26/TSK-01对应partial；未执行不计通过。

[真实注册/noEmit](logs/feature-inventory-archive-actions-preflight.json)accepted=true，2fullTitles、排除0、diagnostics0；spec SHA `843ea6a2d87f987f28c5c7bfbc8b7ce178e7193177e24d230ba889f5143367d6`。[实际source内存SQL检查](logs/feature-inventory-archive-seed-preflight.json)用当前Host/CLI baseline完整DDL，仅SQLite `:memory:`执行source seed：两库各3行/metaID正确、重复seed在任何新写前拒绝、成功/拒绝均关闭两handles，3probe通过；2个raw renderer脚本按WebDriver函数体parse通过，无name helper。定向oxlint spec与seed静态脚本均0warning/error；不会以这3个QA probe增加133产品test计数。

root审查后独立执行参数：

```powershell
& .\docs\testing\qa-2026-11-06\run-menu-tests.ps1 -RunId qa-menu-20261106-archive-actions-final -Bootstrap -Specs '../../docs/testing/qa-2026-11-06/manual-review/pending/qa-archive-actions-20261106.test.ts' -Grep '(?:^| )QAR0[12]:' -ReplayFixtures './test/e2e/fixtures/upstream/common.json,./test/e2e/fixtures/upstream/conversation-session/conversation-session-archive-management.json'
```

finite common SHA `60f4898eb393afc84f86d9d492af910928658a954b1a777d7d5d5cb537033210`、archive SHA `d2295f799f005fb4b1a29d5d939b406f719e1fb110c51842b852617a792817c0`（fixtures为空，无请求）。该run不得与最后supplement的RFC/title有限列表混用。

## 实际结果与范围

root本次独立run已完整结束，summary `completedAt=2026-11-06T19:43:17.629Z`、exit0。[NDJSON](runtime/qa-menu-20261106-archive-actions-final/evidence/test-results.ndjson)实际记录QAR01于19:42:37.801Z通过、QAR02于19:43:03.027Z通过；[summary](runtime/qa-menu-20261106-archive-actions-final/evidence/summary.json)2actual、2PASS。源码仍为准入SHA `843ea6a2d87f987f28c5c7bfbc8b7ce178e7193177e24d230ba889f5143367d6`，不再修改或复验本轮源。

[QAR01状态](runtime/qa-menu-20261106-archive-actions-final/evidence/qa-archive-actions-31128-1793994110974-002-QAR01.json)核行取消归档后Host archived0/cli_deleted0、CLI time_deleted null，其它两条保持归档；[删除取消状态](runtime/qa-menu-20261106-archive-actions-final/evidence/qa-archive-actions-31128-1793994110974-003-QAR02-cancelled.json)保留双库原值；[QAR02冷重启后状态](runtime/qa-menu-20261106-archive-actions-final/evidence/qa-archive-actions-31128-1793994110974-005-QAR02.json)核仅delete目标Host cli_deleted1/CLI time_deleted存在，restore目标仍未删、keep目标仍archived1/cli_deleted0，真实组只显示keep，confirm消失、requests0。对应独占PNG同目录保留。

beforeAll首次seed阶段managementPresent true/status[]只是默认折叠时合法捕获；后续真实展开/行操作已执行，不能把该中间空数组当种子缺失。第一次重启仍只认正式退出屏障，不倒推beforeEach观察器已安装。本次只覆盖本树3合成任务的行恢复/单删取消确认/冷重启持久化；跨Host、running、自动调度和完整归档管理仍保留缺口，不认整个组PASS。
