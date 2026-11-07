# 菜单专项发现的开发入口与审计门禁修复

日期：2026-11-07。范围为 [菜单 Bug 报告](../testing/qa-2026-11-06/bug-report.md) 的 BUG-001、BUG-002/VAL-001、BUG-003/VAL-002；只恢复当前合同，不新增产品能力、状态所有者或跨层接口。保留本工作树已有改动，不提交、推送、打包或启动桌面。

## 产品规则与所有者

- 开发入口由 `scripts/dev-desktop-env.mjs` 串行调度。macOS Helper 构建条件复用当前 `isComputerUseHelperProducerInstalled` 的结果；缺少契约时跳过 Helper，继续 `pre-dev` → Agent CLI → 可选 bytecode → `dev:runtime`。Windows 不调度 macOS Helper。任何已调度阶段失败时停止后续阶段并退出1。能力判断仍遵守 [构建与发行域](../../.agents/specs/official-3.17.1-build.md)，不恢复已删除 Helper producer 或 Linux 资源。
- `mobile-remote-onboarding.mjs` 只是引导组件/RPC夹具，不提供已退休的官方遥测端口。移除它的空 `reportTelemetryEvent` 成员；不改 `no-telemetry.test.mjs` 的扫描范围、禁用名单或生产平台合同，也不恢复遥测模块。该旧浏览器夹具本轮只静态审查，完整引导UI和真实远端不据审计通过宣称已验收。
- 本地工作流配置由现有共享resolver与 `CodingPlanSubscriptionService` 决定。快照始终包含 `offeredMode`，未选用户模式时与 `mode`相同；默认 disabled，forceRefresh不触发官方IO，合法环境覆盖为 alwaysOn/onDemand。仅更新 `no-official-purchase.test.mjs` 四组期待，保留27条退休RPC拒绝、凭据/官方接口访问陷阱，不改生产resolver或服务。

```mermaid
flowchart LR
  P[现有Helper能力探针] --> G[开发入口唯一调度]
  G -->|mac且能力完整| H[既有Helper构建]
  G -->|缺能力或Windows| D[pre-dev]
  H --> D
  D --> A[Agent CLI]
  A --> B[显式bytecode]
  A --> R[dev runtime]
  B --> R
```

## 回归与验收

先新增 `scripts/ci/dev-desktop-env-dispatch.test.mjs`，用 TypeScript AST提取实际唯一顶层try/catch，在VM绑定合成平台、能力布尔及run/process/console替身。覆盖darwin/win32、能力可用/不可用、bytecode开/关的8组合与阶段失败中止；旧源码应检出darwin读取未声明变量，修后按实际调度顺序通过。不导入执行开发入口，不spawn、构建或启动Electron；能力导出可用性仍由既有构建门禁约束，VM证据不替代macOS真机完整开发启动。

修复后实际执行该回归、`no-telemetry.test.mjs`、`no-official-purchase.test.mjs`，并回归 `official317-build.test.mjs` 与 `audit-boundaries.test.mjs`。本地工作流共享快照由原服务门禁实际消费，不新增或恢复退休测试。所有HOME/TEMP/cache/data/log及子进程环境限当前工作树中央sandbox，路径创建前拒绝realpath/reparse越界；源码读取使用异步IO，日志用独占名称，保留此前失败记录。根typecheck、Lint与changed架构由主任务统一执行并如实记录；针对性通过不替代完整桌面、原生平台、真实Provider或远端验收。

## 实际实施与定向证据

先落本规范与9项开发入口回归，再实际执行三文件红测，最后修改三个目标：统一现有Helper变量引用、移除遥测空方法、四组期待补offeredMode；各改动有中文原因/依据注释。未改生产resolver、正式审计扫描或禁用规则。新回归不改变生产模块导出，仅只读AST与实际try/catch的VM执行。

| 批次 | 实际结果 | 证据 |
| --- | --- | --- |
| `tests-bug001-003-red-20261107` | exit1，14项=7PASS/7FAIL；4项darwin未声明变量及阶段中断1、workflow旧快照1、遥测旧夹具1失败；Windows四组合与现有IO门禁通过 | [原日志](../testing/qa-2026-11-06/logs/validation-tests-bug001-003-red-20261107.log)、[命令/环境](../testing/qa-2026-11-06/logs/validation-tests-bug001-003-red-20261107.json) |
| `tests-bug001-003-green-20261107` | exit1，13PASS/1FAIL；生产三问题和8组合已通过，新VM阶段拒绝夹具在外realm抛Error导致catch记录对象，未改生产catch | [原日志](../testing/qa-2026-11-06/logs/validation-tests-bug001-003-green-20261107.log)、[命令/环境](../testing/qa-2026-11-06/logs/validation-tests-bug001-003-green-20261107.json) |
| `tests-bug001-003-green2-20261107` | exit0，14/14，0skip；VM绑定与副作用替身相同Error构造器后，8组合和每阶段拒绝中止均通过，原5项审计也通过 | [最终日志](../testing/qa-2026-11-06/logs/validation-tests-bug001-003-green2-20261107.log)、[命令/环境](../testing/qa-2026-11-06/logs/validation-tests-bug001-003-green2-20261107.json) |
| `tests-bug001-003-adjacent-20261107` | exit0，31/31，0skip；既有构建与审计边界保持 | [相邻日志](../testing/qa-2026-11-06/logs/validation-tests-bug001-003-adjacent-20261107.log)、[命令/环境](../testing/qa-2026-11-06/logs/validation-tests-bug001-003-adjacent-20261107.json) |

使用主任务已审查的 `.run-logs/qa-2026-11-06/validation/run-validation.mjs` 串行三文件/两文件批次，实际Node24.18.0、Corepack pnpm10.33.2；该Node不同于mise固定24.14.0，保留此工具链限制。所有批次日志独立保留。相邻构建回归仅在中央project-only-validation合成目录复制现有资产、装载真实配置，不打包、不下载资源。9项VM回归不等于真实macOS启动；旧mobile浏览器夹具没有运行，其完整UI、远端allowlist与原生picker仍待相应隔离回归。

根typecheck、Lint、changed架构与最终格式结果由主任务统一补充。定向通过只解除上述已确认源码/门禁问题，原菜单失败与未测环境不回写为全量通过。
