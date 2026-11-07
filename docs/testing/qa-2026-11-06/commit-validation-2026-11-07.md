# 最近改动的本地提交检查

日期：2026-11-07（Asia/Shanghai）。用户本轮将任务调整为提交最近修改；本轮未继续全量菜单探索，未推送、触发构建或打包。

## 提交范围

- 会话工作与思考耗时、完成通知、自动队列交接与启动前终态、侧栏及手机列表展示、会话租约、Composer 回执和历史补拉隔离。
- 内置浏览器权限启动装配、平台接口、项目迁移、工具栏布局、命令中心及开发入口的已有修复。
- 对应规范、回归用例、菜单功能清单、覆盖矩阵、测试与 Bug 报告，以及报告直接引用的复现证据。

QA runtime 的 profile、缓存、下载驱动、数据库和其它未引用运行产物保留本地并忽略；报告直接引用的证据按文件纳入。原始日志及机器结果按字节保存，日志不作文本差异或源码空白检查。两个已有的 `node-repl-host/dist-types/*.d.ts.map` 生成映射未纳入提交，也未恢复或删除。

## 本轮实际验证

| 检查 | 结果 | 证据与限制 |
| --- | --- | --- |
| 工作树基线 | PASS | `node scripts/check-workspace-freshness.mjs`：main 与 origin/main 同步，ahead/behind 均为 0 |
| TypeScript 输出路径审核 | PASS | 现有隔离验证器 `prepare`：19 个 TypeScript 项目，输出父目录无重解析点，HOME/TEMP/cache 位于本工作树 |
| 根 `corepack pnpm typecheck` | PASS，exit 0 | [结果](../../../.run-logs/project-only-validation/recent-commit-gates-retry-nH95Qt/results.json)、[日志](../../../.run-logs/project-only-validation/recent-commit-gates-retry-nH95Qt/logs/typecheck.log) |
| 原始根 `corepack pnpm lint` | FAIL，exit 1 | 18,177 文件，46,299 warnings、88 errors；错误来自保留的 QA runtime 插件副本。[结果](../../../.run-logs/project-only-validation/recent-commit-gates-retry-nH95Qt/results.json)、[日志](../../../.run-logs/project-only-validation/recent-commit-gates-retry-nH95Qt/logs/lint.log)；不把补充检查改写成此次原始检查通过 |
| 排除 QA runtime 的补充 Lint | PASS，exit 0 | `corepack pnpm lint --ignore-pattern docs/testing/qa-2026-11-06/runtime/**`，5,690 文件，0 warnings、0 errors；已加入运行目录忽略规则。[结果](../../../.run-logs/project-only-validation/recent-commit-source-lint-70dX4o/results.json)、[日志](../../../.run-logs/project-only-validation/recent-commit-source-lint-70dX4o/logs/lint-source.log) |
| `corepack pnpm architecture:check --changed` | PASS，exit 0 | violations/baseline/new 均为 0，不代表未配置模块或运行语义全量验收 |
| 六文件定向回归 | PASS，exit 0 | [批次结果](logs/validation-tests-recent-commit-20261107.json)、[日志](logs/validation-tests-recent-commit-20261107.log)：21 个顶层测试通过，0 fail/skip；其中 Composer、历史查询、工作状态三个 runner 分别实际执行 22、30、38 个内部场景，不重复计入顶层统计 |
| 暂存差异空白检查 | PASS | `git diff --cached --check`；原始日志与机器快照按 `.gitattributes` 保持原始字节 |

六文件批次为 `embedded-browser-permission-adapter`、`embedded-browser-permission-startup`、`dev-desktop-env-dispatch`、`composer-submission-scope-race`、`session-work-status-projection`、`session-history-query`。副作用使用内存替身或项目沙箱，未启动真实模型、用户会话或设备授权。

隔离检查器首次启动因 Windows PATH 环境键大小写导致子进程找不到 Node，两项命令未实际进入检查；该失败记录保留在 `.run-logs/project-only-validation/recent-commit-gates-WcuasI/`。固定工具 PATH 后才得到上表真实类型与 Lint 结果，未改产品代码。

实际工具链为 Node 24.18.0、Corepack pnpm 10.33.2；Node 不同于 `mise.toml` 固定的 24.14.0。此前报告保留的 CLI 黄金回归 385/386、CLI 全包 Lint 失败及菜单 partial/未执行项仍按原证据记录。本次定向检查不替代 Electron 全量、macOS、真实 Provider、远端或手机恢复验收。
