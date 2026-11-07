# BUG004 修复验证记录

本记录追加 2026-11-07 修复证据，原 [QA 测试报告](test-report.md) 与 [Bug 报告](bug-report.md#bug-004) 的已执行历史不改写。仅修尚未登记 `0005_projects` 的首次启动 settings 输入；已登记坏账的自动恢复不在此次实现范围。

## 修复范围与状态

先更新 `.agents/specs/official-3.16.2-sqlite-migrations.md`、`host/database-startup/CONTRACT.md` 和 `project-storage/CONTRACT.md`，再添加真实 Worker 回归。Desktop Worker 从已有公开 `@zcode/services/storage-startup` 入口等待 SettingService，向原 startup/Repo 透传 settings；workerData 继续只有 path，进度/失败协议不变。未改历史迁移 SQL/checksum、账本或任务归属决定规则。

产品文件只有 `packages/desktop/src/host/database-startup/tasksStorageWorker.ts` 与 `packages/services/src/project-storage/startup.ts`。其他代理的 Browser/UI 修复及原有本地改动保留。

| 验证 | 实际结果 | 证据 |
| --- | --- | --- |
| 修前架构检查 | exit 0，0 violations | [日志](logs/validation-bug004-architecture-pre.log)、[结果](logs/validation-bug004-architecture-pre.json) |
| 真实 Worker 修前回归 | 3 项：2 PASS / 1 FAIL；旧设置保存的两项目实际为空 | [快照](logs/validation-bug004-worker-before-fix.json)、[执行日志](logs/validation-bug004-worker-before.log) |
| 同脚本修后回归 | 3 项全部 PASS | [快照](logs/validation-bug004-worker-after-fix.json)、[执行日志](logs/validation-bug004-worker-after.log) |
| 两产品文件及 Worker 回归 lint | 3 文件，0 warnings / 0 errors，exit 0 | [日志](logs/validation-bug004-lint-owned.log) |
| 新 E2E 静态准入 | 2 条真实 tsx 注册；0 browser 访问；transpile 0 error；1 raw script 语法通过；2 文件 lint 0/0 | [详细结果](logs/validation-bug004-e2e-static.json)、[执行日志](logs/validation-tests-bug004-e2e-static.log)、[lint](logs/validation-bug004-e2e-owned-lint.log) |
| Desktop UI 首次迁移/完整冷重开 | 2 PASS / 0 FAIL / 0 SKIP，exit 0；root 已串行执行 | [运行汇总](runtime/qa-fix-bug004-desktop-legacy-project/evidence/summary.json)、[逐项结果](runtime/qa-fix-bug004-desktop-legacy-project/evidence/test-results.ndjson)、[计划与验收](test-plan-bug004-desktop-migration.md) |
| 最终全仓 typecheck/lint/architecture 与 E2E/外置 noEmit | root 统一执行，不以定向 lint 代替 | 待 root 汇总 |

Worker 脚本 [validation-bug004-worker-regression.mjs](logs/validation-bug004-worker-regression.mjs) 在工作树 `.run-logs/qa-2026-11-06/validation/bug004/` 内创建独占合成 HOME/旧数据库，装载真实 Worker、SettingService、Repo 与 SQLite 迁移，使用 readonly 前后快照。验证多保存项目的顺序/重复路径去重、conversation/recent-only/task-only 排除、旧任务事实和未触及表哈希、固定 checksum、重开幂等、全新安装空集合以及已记账空项目库不被偷偷补写。它不是 Electron UI 或真实用户迁移验收。

## 桌面运行结果

候选 [qa-bug004-desktop-migration-20261107.test.ts](manual-review/pending/qa-bug004-desktop-migration-20261107.test.ts) 当前 SHA-256 `bf335408fe8e786070885b5de81255de66853d9becbb64931290a36f3c795373`，已经冻结。完整启动参数、安全路径、既有 prelaunch fixture owner、截图/SQLite/DOM/冷重启身份与失败边界见上述计划。禁止 `-Bootstrap`；测试不写任何业务库，不发送模型请求，不在仍运行的 Host 下补种项目，不把 renderer refresh 当完整重启。

独立 run `qa-fix-bug004-desktop-legacy-project` 已结束。B4UI01 于 `2026-11-06T21:30:21.901Z` PASS，B4UI02 于 `2026-11-06T21:30:39.324Z` PASS；[summary](runtime/qa-fix-bug004-desktop-legacy-project/evidence/summary.json) 在 `2026-11-06T21:30:50.157Z` 完成并记录 exit 0（北京时间 2026-11-07 05:30:50）。两项均首次通过，无自动重试。

- 首次启动：[SQLite、侧栏与身份 JSON](runtime/qa-fix-bug004-desktop-legacy-project/evidence/bug004-desktop-31216-1794000611324-first-start.json)、[截图](runtime/qa-fix-bug004-desktop-legacy-project/evidence/bug004-desktop-31216-1794000611324-first-start.png)。真实 Worker 从启动前旧 settings 生成唯一 `ZCodeProject`，侧栏与库中的项目 ID 均为 `bf1ca0b8-c27e-425c-80d4-849884b12152`，单 primary root，外键错误为空。
- 完整冷重开：[旧进程退出屏障](runtime/qa-fix-bug004-desktop-legacy-project/evidence/bug004-desktop-31216-1794000611324-old-process-exited.json)、[重开 JSON](runtime/qa-fix-bug004-desktop-legacy-project/evidence/bug004-desktop-31216-1794000611324-cold-reopened.json)、[重开截图](runtime/qa-fix-bug004-desktop-legacy-project/evidence/bug004-desktop-31216-1794000611324-cold-reopened.png)。同一 profile 的 Main PID 从 31836 变为 25700；项目、roots、两份迁移账本及外键错误逐值相同，侧栏仍显示同一项目。

两次 `0005_projects` checksum 均为 `ac00a61c7c45a5ceb3814b1487901372c5580eb6eb8d31bde5bcdfbd1ed0f0da`。该结果确认本轮隔离旧设置的首次迁移接线及冷重开幂等，不扩大为已登记坏账恢复或真实用户迁移验收；上表修前、Worker 与静态准入结果保留原历史。

## 已登记空项目库的恢复边界

已提交的 `0005_projects` 不会重跑。仅凭现存 settings、历史 task 或空 projects 无法区分“首次迁移漏接设置”和“用户已移除项目”，自动补写会复活已移除入口，NULL 任务归属也已经完成决定。因此本次不新增补偿 migration、不修改旧 checksum、不直接操作真实数据。

可审的后续方案是独立显式恢复流程：先停止所有写者并制作可验证备份/只读预览，由用户逐项确认应保留的项目与 roots，再由同一 Host 的现有公开项目新增操作创建明确选择的入口。任务重新归类另需用户选定 task ID，使用公开移动操作，不按 cwd 批量推断；已有/已删除项目、重名/同 root 冲突必须在预览中展示。该流程不擦账本、不重跑 `0005`，不将不确定的 settings 当业务事实。本记录只给方案，未实现或执行恢复，也不宣称已解决此前用户库里的遗漏。

本机为 Windows，实际 Node 24.18.0 / pnpm 10.33.2；仓库 mise 指定 Node 24.14.0 的差异保留。无安装、macOS、手机、远端、打包、提交/推送、自动恢复或项目外清理。
