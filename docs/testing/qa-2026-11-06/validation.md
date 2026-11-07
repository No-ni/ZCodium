# 质量验证与确定性功能测试

测试日期：2026-11-06至2026-11-07（Asia/Shanghai），目录沿用开始日期。项目版本：3.17.1。测试对象为当前根工作树，包含开工前已有的未提交修改；没有修改产品代码、安装依赖、打包、推送或触发GitHub构建。

## 结果

全部UI批次已退出，QA测试源冻结后完成最终验证。五项必需门禁为 **4项PASS、原root lint FAIL**；只排除本轮生成runtime的补充lint为PASS，不替代原命令失败。测试确认8项分为6个产品问题与2个确定性门禁问题；重复置顶后的整session超时仍是责任/根因待区分的运行候选，不增加确认问题数。

| 最终命令 | 真实结果 | 证据 |
| --- | --- | --- |
| 安全prepare（固定工具链） | exit0；19个TS工程，含外置QA；输出/声明/增量缓存及祖先均在本树 | [记录](logs/validation-prepare-pinned-final.json)、[输出](logs/validation-prepare-pinned-final.log) |
| `corepack pnpm --dir packages/desktop typecheck:e2e` | exit0；嵌套pnpm10.33.2、Node24.18.0；有Node24.14.0 engine偏差警告 | [记录](logs/validation-desktop-e2e-typecheck-final-pinned.json)、[输出](logs/validation-desktop-e2e-typecheck-final-pinned.log) |
| `corepack pnpm typecheck` | exit0；当前配置增量检查 | [记录](logs/validation-typecheck-final.json)、[输出](logs/validation-typecheck-final.log) |
| `corepack pnpm lint` | **exit1**；16,053文件、38,388 warnings、76 errors | [记录](logs/validation-lint-final.json)、[完整输出](logs/validation-lint-final.log)、[独立归因](logs/validation-lint-final-attribution.json) |
| `corepack pnpm architecture:check --changed` | exit0；violations/baseline/new均0；base=`merge-base upstream origin/main` | [记录](logs/validation-architecture-final.json)、[输出](logs/validation-architecture-final.log) |
| `corepack pnpm exec tsc -p docs/testing/qa-2026-11-06/tsconfig.qa.json --noEmit` | exit0；全部当前外置QA与observers，无类型诊断 | [记录](logs/validation-qa-typecheck-final.json)、[输出](logs/validation-qa-typecheck-final.log) |
| 补充：`corepack pnpm lint --ignore-pattern docs/testing/qa-2026-11-06/runtime/**` | exit0；5,731文件、3 warnings、0 errors；仅排除本轮生成runtime | [实际参数/记录](logs/validation-lint-final-source.json)、[完整输出](logs/validation-lint-final-source.log) |

原lint的76个error全部为隔离app-home插件缓存副本的`eslint(max-lines)`；Jiti编译缓存还产生大量warning。没有删除缓存、更改生产lint配置或把原失败改写为通过。补充命令实际被CLI接受并仅传入上述一个ignore pattern，保留其它QA源码。3个warning分别为`validation-e2e-counts.mjs:26`、`feature-inventory-update-browser-matrix.cjs:108`、`feature-inventory-matrix-links.cjs:15`的`prefer-string-starts-ends-with`，均在QA统计/链接脚本；源码补充扫描无error。归因解析覆盖全部76条error；它没有宣称结构化重建全部38,388条warning。

之后新增的两份纯读证据统计脚本及最终链接检查器另做定向lint，3文件0warnings/0errors，[记录](logs/validation-validation-final-evidence-lint.json)、[输出](logs/validation-validation-final-evidence-lint.log)。该验证只检查报告工具，不计入133确定性测试或UI用例。

最终逐文件重读NDJSON得到 **188唯一case、250尝试**：最新151PASS/31原始FAIL/6SKIP，全部174PASS/70FAIL/6SKIP。[counts033](logs/validation-e2e-counts-033.json)与[独立分层摘要](logs/validation-e2e-final-summary.json)保存实际身份和统计。183个case至少有过一次非skip记录、244个非skip尝试；最新非skip为182（SLM13曾旧前置FAIL后被正确SKIP），这些数字不等于每个功能动作完成。19个有case记录的完整批次共249尝试、173PASS/70FAIL/6SKIP；另保留取消core批次的重复VP30一次真实PASS，不增加唯一case。

| 最新case分层 | 唯一 | PASS | 原始FAIL | SKIP |
| --- | ---: | ---: | ---: | ---: |
| 正式canonical（`packages/desktop/test/e2e/`，排除仓内pending） | 109 | 83 | 26 | 0 |
| 仓内pending | 2 | 2 | 0 | 0 |
| 外置docs QA | 77 | 66 | 5 | 6 |

BLOCKED描述功能动作未抵达或无case的hook/安全前置，不能伪造为NDJSON case。原始FAIL包括产品表现、旧QA契约/定位前置和session/环境错误，不能当作产品Bug数。确定性测试仍为133唯一、131PASS/2稳定FAIL；另5次独立复跑为3PASS/2相同FAIL，共138尝试。最终copy-history-final实际3case为RFC01/HIST01 PASS、HIST02 FAIL；HIST02已跨过2/2搜索，止于Escape后row42挂载等待，其后动作未验，未确认为产品Bug。详见[最终主报告](test-report.md)、[Bug分类](bug-report.md)、[保留执行历史](test-execution-history.md)。

### 最终工具链隔离修订与版本偏差

20:32:26–20:32:35 UTC安全prepare退出0，审查18个TypeScript工程输出祖先与既有工具路径，见[记录](logs/validation-prepare-final.json)。20:32:51–20:32:58 UTC首次[desktop-e2e-typecheck-final](logs/validation-desktop-e2e-typecheck-final.json)退出0，但package脚本嵌套的裸pnpm解析到Codex自带fallback shim，实际使用Node24.22.1/pnpm11.25.0；外层仍是Node24.18.0/Corepack pinned10.33.2。此记录保留为版本偏离，不纳入固定工具最终通过。

已只读审fallback脚本：仅设pm_on_fail=ignore并绝对调用自带Node/pnpm，不覆盖runner的HOME/TEMP/XDG/npm cache。继承PNPM_HOME、NODE_OPTIONS与NODE_COMPILE_CACHE均未设；root/desktop/e2e-report的node_modules/.bin没有pnpm竞争项，根packageManager与现有工作树Corepack缓存包均为10.33.2。首次命令未安装依赖、启动UI或改变产品；prepare覆盖的build:node输出仍在本树。没有据此声称嵌套版本符合仓库要求。

最窄修订只改隔离runner，已完成[本树bin/cache及现有Node/Corepack路径审计](logs/validation-pinned-toolchain-path-audit.json)：22个祖先/目标检查、1316个缓存项，重解析点0，保存工具SHA。新建本树bin/pnpm.cmd，所有裸pnpm经绝对既有Node24.18.0/Corepack.js执行；删除大小写重复PATH键，唯一PATH只含本树bin、固定Node/Git和Windows系统目录；PNPM_HOME指本树bin。HOME/TEMP/APPDATA/XDG/npm/tsx/Corepack/cache与Git配置均仍在工作树；Corepack网络关闭、禁自动管理包管理器、Node/V8 compile cache关闭且路径固定本树。缺少既有本树pnpm缓存即拒绝，不再从真实用户目录补取或安装。

初次版本探针因Windows ComSpec前斜杠使cmd解析失败；保留[失败](logs/validation-nested-pnpm-version-final.json)与[诊断](logs/validation-shim-syntax-diagnostic-final.json)，统一为Windows绝对反斜杠后，实际嵌套[pnpm=10.33.2](logs/validation-nested-pnpm-version-final-confirmed.json)、[node=v24.18.0](logs/validation-nested-node-version-final-confirmed.json)均exit0。之后以新名称desktop-e2e-typecheck-final-pinned及其余四门禁执行，原desktop-final日志未覆盖。Node仍偏离mise的24.14.0，严格该版本环境未验；本轮没有安装新工具。

### 此前验证与执行历史

以下表格及后续按时间记载的分节保留早期真实验证/截点，最终结果以上述表格与counts033为准；不将早期PASS扩认为QA源修改后的最终门禁。[counts032](logs/validation-e2e-counts-032.json)是local-final-targeted之后、最后3条之前的247尝试历史截点，不是当前统计。

| 验证 | 真实结果 | 证据 |
| --- | --- | --- |
| `corepack pnpm typecheck` | 退出 0 | [输出](logs/validation-typecheck.log)、[时间与退出码](logs/validation-typecheck.json) |
| `corepack pnpm lint` | 退出 0；5,664 个文件；0 warnings、0 errors | [输出](logs/validation-lint.log)、[时间与退出码](logs/validation-lint.json) |
| `corepack pnpm architecture:check --changed` | 退出 0；violations=0、baseline=0、new=0；比较基线 `merge-base upstream origin/main` | [输出](logs/validation-architecture-check.log)、[时间与退出码](logs/validation-architecture-check.json) |
| 外置 QA spec：`corepack pnpm exec tsc -p docs/testing/qa-2026-11-06/tsconfig.qa.json --noEmit` | 退出 0，无类型诊断；本轮显式包含 docs 内 pending spec | [输出](logs/validation-qa-typecheck.log)、[时间与退出码](logs/validation-qa-typecheck.json) |
| 菜单、设置、导航与 fork 审计 | 89 个测试；88 通过、1 失败；0 跳过 | [输出](logs/validation-tests-menu.log)、[完整命令](logs/validation-tests-menu.json) |
| 本地功能、通知、机器人选择与模型汇总 | 44 个测试；43 通过、1 失败；0 跳过 | [输出](logs/validation-tests-local.log)、[完整命令](logs/validation-tests-local.json) |
| 两项失败的独立复跑 | 5 个测试；3 通过、2 失败；均复现 | [输出](logs/validation-tests-reproduce.log)、[完整命令](logs/validation-tests-reproduce.json) |
| 外置补充spec及SPFV/reload observers的targeted类型检查 | 退出0，无诊断；只检查类型，未运行UI | [时间/退出码](logs/validation-qa-typecheck-observer.json) |
| reload只读observer CJS/tsImport装载 | 退出0，两个exports均存在；零browser调用、零进程扫描 | [输出](logs/validation-reload-observer-static.log)、[完整命令](logs/validation-reload-observer-static.json) |

独立测试合计 **133 个：131 通过、2 失败、0 跳过**。复跑的 5 个测试已包含在这 133 个中，不重复计数。两项失败均属于测试/夹具与当前契约不一致；本批没有确认产品在运行时重新引入官方遥测、购买或官方配置请求。

Typecheck 实际运行时间为 22:55:51–22:55:55，lint 为 22:55:51–22:55:52。`tsc -b` 会在各项目内生成或更新声明、输出和增量缓存，因此本次属于当前配置的增量检查，不是干净环境重构建。运行器使用本机 Node **24.18.0**、缓存的 pnpm **10.33.2**；`mise.toml` 固定 Node **24.14.0**，本批未安装或切换 Node，严格固定版本环境仍需后续复验。

主任务首次freshness因Git TLS失败；feature_inventory随后实际执行无 `--no-fetch` 的 `node scripts/check-workspace-freshness.mjs` 退出0，main与origin/main ahead/behind均0。已核对 [独立原始记录](feature-inventory-freshness.log) 与脚本默认 `git fetch origin --prune` 的执行分支；该次检查含真实fetch，不是仅缓存对照。原始记录仅保存日期2026-11-06，未推断秒级时刻。两次不同条件/时刻的结果同时保留；成功范围是当前fork origin/main，不扩认本轮另行更新了全部upstream来源。

## 针对性覆盖

| 用例文件（仓库根相对路径） | 个数 | 检查内容 |
| --- | ---: | --- |
| `scripts/ci/audit-boundaries.test.mjs` | 11 | 官方控制面/OAuth/购买与推送入口删除、用户 Key 额度、fork 帮助链接、内置插件默认启用集合、发行归属、文档插件许可/版本、AstrBot 文档、后台资源采样默认关闭 |
| `scripts/ci/no-telemetry.test.mjs` | 2 | 无遥测 SDK；源码禁止采集入口。第二项失败见 VAL-001 |
| `scripts/ci/bundled-help-config.test.mjs` | 3 | 本地帮助配置、协议校验、中英文社区链接、开发态/正式态配置路径、损坏配置、Desktop 提示的 Host 事实与本地关闭 |
| `scripts/ci/provider-config-menu-entry.test.mjs` | 3 | 中英文键集合、前往 Provider 配置文案、路径派生与文件物化一致 |
| `scripts/ci/local-preferences.test.mjs` | 1 | 命令中心的新任务、打开项目、设置、技能、MCP 动作与官方登录/退出删除 |
| `scripts/ci/windows-ui-help-menu-regressions.test.mjs` | 5 | 自有更新源可用性、Renderer/Windows/macOS 原生菜单与托盘一致、帮助动作失败提示/重试/本地化/日志净化 |
| `scripts/ci/windows-ui-navigation-regressions.test.mjs` | 20 | 前进/后退删除项与别名清理、跨 workspace identity 隔离、自动化/插件导航目标、模型重启锁、未读更新拒绝与回滚、敏感信息不落日志 |
| `scripts/ci/windows-ui-root-events-regressions.test.mjs` | 13 | 通知定位任务、远程 identity/path 解析、tab/metadata 优先级、本地 fallback、语言及回调变更、事件释放、日志净化 |
| `scripts/ci/windows-ui-settings-owner-regressions.test.mjs` | 11 | 终端字体/系统 profile/shell、HTTP 代理/no-proxy/CA、自动归档、Windows 托盘、硬件加速与证书设置只写 base Host |
| `scripts/ci/windows-ui-settings-refresh-regressions.test.mjs` | 11 | 设置保存与旧读取交错、并发写入读取合并、完成时序、CAS 失败刷新、订阅变化、服务缓存隔离、失败时保留可用快照 |
| `scripts/ci/windows-ui-shortcut-window-regressions.test.mjs` | 9 | 快捷键默认恢复冲突、Windows 物理键别名与 macOS scope、录制动作幂等、IME/重复键/无效键、托盘隐藏窗口重新显示与过期窗口清理 |
| `scripts/ci/astrbot-bridge-selection.test.mjs` | 10 | 权限/提问/菜单选择的 payload、编号与命令、语言、群聊路由、seq/回放、权限恢复后的任务 stream 与结束状态归属 |
| `scripts/ci/desktop-workspace-deep-link.test.mjs` | 5 | workspace 深链、旧登录 payload 拒绝、窗口就绪/关闭隔离、确认与重试、IPC/preload 的 OAuth 删除 |
| `scripts/ci/feedback-boundary.test.mjs` | 3 | Host 不接受旧反馈上传命令，不传播旧端点/设备身份，通知保留执行和权限状态 |
| `scripts/ci/local-onboarding.test.mjs` | 1 | 本地引导偏好更新/顺序/损坏恢复、删除身份与上传字段、无官方网络 IO |
| `scripts/ci/local-usage.test.mjs` | 2 | 本地统计依赖、旧套餐 tab intent 清理、统计/Provider/插件设置导航 |
| `scripts/ci/no-official-purchase.test.mjs` | 3 | 27 个旧购买 RPC 拒绝、本地统计无账号 IO、本地工作流配置。第三项失败见 VAL-002 |
| `scripts/ci/retired-web-oauth.test.mjs` | 1 | 内存 bundle 检查 Web 登录/token 模块删除、WebSocket/API 配置、本地 referrer 策略 |
| `scripts/ci/summary-model-selection.test.mjs` | 12 | 汇总模型优先级/失败 fallback、reasoning/text/tool 聚合与不完整流拒绝、摘要模型偏好/清空的 schema 兼容 |
| `scripts/ci/update-source-ownership.test.mjs` | 7 | 缺失自有更新源时跳过、无官方回退、构建常量注入与 updater cache 的 appId 隔离 |

这些是源码、schema、受控 callback、模拟服务与隔离本地文件测试。Windows/macOS 原生菜单与窗口行为使用 mock；AstrBot/模型与网络分支使用模拟输入；Web bundle 在内存中构建。**不能用本批结果替代真实 Electron 菜单点击、真实远程服务器、真实模型 API、手机 Web 或 macOS 真机验收。** 主测试报告中的 E2E 与人工交互证据应单独汇总。

## Bug 与修复交接

### VAL-001 / P2：遥测审计扫描被旧 E2E 夹具占位方法阻塞

- 状态：已确认，首次执行与独立复跑均失败。
- 触发命令：在下述隔离环境执行 `node --test scripts/ci/no-telemetry.test.mjs`。
- 预期：源码不含官方或私有采集入口时审计通过；夹具不继续声明已经删除的旧平台能力。
- 实际：`product code cannot enable official or proprietary telemetry collectors` 在测试第 66 行失败，命中 `packages/desktop/test/e2e/manual-review/pending/mobile-remote-onboarding.mjs`。
- 已确认原因：该夹具第 85 行的内嵌浏览器脚本仍声明 `reportTelemetryEvent: async () => {}`。扫描仅排除 `.test.` 文件，没有排除这个无 `.test.` 后缀的测试夹具。命中的函数体为空，不构成实际遥测导出证据。
- 影响：fork CI 的确定性审计门禁不能全绿；容易把遗留 fixture 误报成生产采集。
- 建议：优先按当前 `IPlatformService` 契约清除该夹具里的废弃方法，再验证夹具浏览器测试；保持对真实产品采集入口的守卫强度。若改扫描规则，应明确测试目录边界并保留真实负例，避免扩大忽略范围掩盖产品代码。
- 证据：[首次失败](logs/validation-tests-menu.log)、[独立复跑](logs/validation-tests-reproduce.log)。

### VAL-002 / P2：官方购买删除回归测试使用旧工作流快照契约

- 状态：已确认，首次执行与独立复跑均失败。
- 触发命令：在下述隔离环境执行 `node --test scripts/ci/no-official-purchase.test.mjs`。
- 预期：以当前共享 `DynamicWorkflowClientConfig` 的快照契约检查 disabled/alwaysOn/onDemand，同时保留官方配置/凭据 IO 禁止断言。
- 实际：第 98 行 `deepEqual` 期待 `{mode:'disabled', enabled:false, source:'default'}`；实际还含合法字段 `offeredMode:'disabled'`。第三个测试首条断言停止，后续 forceRefresh/环境覆盖分支在本批没有抵达，不能宣称这些分支已执行通过。
- 已确认原因：`packages/shared/src/dynamic-workflow-feature.ts` 第 59 行已把 `offeredMode` 声明为必需字段，`createDynamicWorkflowClientConfig` 第 64–72 行始终输出它。`codingPlanSubscriptionService.ts` 按共享 resolver 生成快照，测试期待仍沿用旧形状。
- 影响：本地工作流配置审计回归持续失败，且遮挡后续分支的验证。未确认官方购买或配置请求回归。
- 建议：更新 disabled/forceRefresh/alwaysOn/onDemand 的期待，包含 offeredMode，并保留旧账号/购买 RPC、凭据访问和官方 IO 的禁用断言；复跑该文件和共享工作流模式测试。
- 证据：[首次失败](logs/validation-tests-local.log)、[独立复跑](logs/validation-tests-reproduce.log)。

## 写入范围与执行方式

所有命令 cwd 都是 `C:\vibecoding\zcodium`。运行器 `.run-logs/qa-2026-11-06/validation/run-validation.mjs` 在启动前审查 18 个 TypeScript 工程的输出/声明/增量缓存及祖先路径；拒绝符号链接/重解析点，确认输出只在当前工作树。已存在的根 `node_modules/.bin`、typescript、oxlint、tsx 和待复制的 pnpm 工具缓存也审查无符号链接。缓存的 pnpm 10.33.2 从既有目录只读复制到工作树，未执行依赖安装。

子进程的 HOME、USERPROFILE、TEMP、TMP、TMPDIR、APPDATA、LOCALAPPDATA、XDG config/cache/data、npm cache/store、tsx cache、`ZCODE_DATA_BASE_DIR` 和 Git 全局配置均定向到 `.run-logs/qa-2026-11-06/validation` 内；Corepack 网络关闭、不更新默认版本、不 auto-pin；清除外部 Node loader/compile cache 与继承的代理/CA；Git 子进程禁用全局/系统配置、fsmonitor、hooks 和可选锁。没有使用真实 `.zcodium` 或系统临时目录作为测试目标。产生的测试夹具按现有测试逻辑在各自本工作树临时目录内清理。

实际批次命令保存在对应 JSON 证据中。当前工作树内可用的复现入口为：

```powershell
node .run-logs/qa-2026-11-06/validation/run-validation.mjs prepare
node .run-logs/qa-2026-11-06/validation/run-validation.mjs typecheck
node .run-logs/qa-2026-11-06/validation/run-validation.mjs lint
node .run-logs/qa-2026-11-06/validation/run-validation.mjs architecture-check
node .run-logs/qa-2026-11-06/validation/run-validation.mjs tests-reproduce scripts/ci/no-telemetry.test.mjs scripts/ci/no-official-purchase.test.mjs
```

运行器与缓存属于本次临时验证材料；迁移报告或清理缓存后，须按同一范围规则重建隔离环境，不能直接在真实用户 HOME/TEMP 下复跑带文件 IO 的测试。

## E2E 架构上下文

已读取仓库 `architecture-governance` 技能并生成 `corepack pnpm architecture:context desktop-test-config`：[完整受控上下文](logs/validation-architecture-context.log)。当前策略没有 `desktop-e2e` 模块；`desktop-test-config` 为 managed、owner=testing、requires=none，只覆盖 `packages/desktop/test/test-config-contract` 和 `packages/desktop/wdio.conf.ts`。合同要求只配置已有桌面 E2E runner，测试数据及子进程写入当前项目隔离根，不装配官方账号与云回放。新增 `packages/` 或 `apps/` 源文件不能仅因已有 E2E 目录就宣称获得该模块覆盖，应先确认治理归属。

## 主 E2E wrapper 的独立安全审查

已只读审查 `run-menu-tests.ps1`、`run-windows-e2e-shards.mjs`、`wdio.conf.ts` 和桌面/Agent bundle 构建入口。Wrapper 使用固定工作树、经过格式校验的 run ID，明确调用已有 `@zcode/desktop test:e2e` 内部 runner 的单 shard 和给定 spec；Corepack 只从本工作树既有 pnpm 10.33.2 缓存复制，关闭网络；Chromedriver 只复制本工作树既有固定版本 executable。WDIO 将 HOME/USERPROFILE/dataBaseDir 改为本轮 app-home；构建 pnpm 使用加载配置前的 tool-home。共享 `out`、CLI `dist`、`.e2e-cache`、bundled-agents 与测试 evidence 仍位于工作树，构建的是 E2E JS bundle，不生成 installer。

本轮检查时 `C:\`、`C:\vibecoding`、工作树祖先均无重解析点；QA runtime 子树扫描也未发现重解析点。当前继承环境没有 NODE_OPTIONS、NODE_COMPILE_CACHE、npm_config_store_dir、npm_config_userconfig、TSX_CACHE_DIR、PLAYWRIGHT_BROWSERS_PATH 或外部 COREPACK_HOME。配合主任务明确选择的内部 spec，本轮没有观察到用户目录/系统临时根写入目标。

初始 wrapper 有三项可复用防护缺口，后续只读复审确认主任务已在新版本中修正：

1. 初版 `Assert-QaPath` 只检查目标祖先，没有扫描既有 runtime 子树。新版在写入前扫描整个既有 runtime 并拒绝重解析点，防止重复 RunId 下的 app-home/Corepack 子目录链接绕过。
2. 初版未锁定 Node loader/compile cache、tsx cache/npm userconfig。新版清空 NODE_OPTIONS，并把 NODE_COMPILE_CACHE、TSX_CACHE_DIR、npm_config_store_dir/npm_config_userconfig 显式定向到本 run。
3. 初版 `Specs` 没有范围约束。新版逐个按 Desktop cwd 解析，检查存在的工作树内 `.test.ts` 文件并拒绝祖先链接；主任务仍须按场景审查 spec 内容。文档外置 spec 已由专项 tsconfig 显式类型检查通过。

Agent 构建所用 `apps/zcode-cli/packages` 中另有 54 个 pnpm workspace `node_modules/@zcode` junction，逐项读取目标均仍指向本工作树对应包；不能声称整个 CLI 包树没有链接。桌面输出、E2E cache、bundled-agents 和根工具 cache/vite 临时目录扫描未发现重解析点。

上述是 wrapper 的审查与后续修正记录，不是产品 bug 或当前发生外部数据写入的证据；没有为了审查重启运行中的 E2E 或执行额外清理。

### 外置项目准备 hook 与源码指纹证据

后续只读审查 `qa-project-bootstrap.cjs` 与 wrapper 的 `-Bootstrap` 入口。Hook 仅在获准 wrapper 隔离环境、Provider replay 下继续，核对 HOME/USERPROFILE/TEMP/APPDATA/XDG/Corepack/npm cache、合成 workspace、配置与 SQLite 路径；Windows 子进程通过环境 JSON 传递路径，隐藏窗口并只读检查祖先及既有子项的 ReparsePoint，拒绝越界链接。SQLite 使用 readOnly 和 SELECT，关闭连接，数据库及可能使用的 `-wal`/`-shm` 路径也被核对。

Hook 保存创建前截图、配置与迁移账本，缺少项目行时经现有项目 UI 创建合成 `ZCodeProject`，校验信任对话框仅含该 root；创建后核对持久项目 owner/primary root、侧栏及草稿入口。系统目录选择使用现有 `selectNativeProjectDirectories` 的单次 `showOpenDialog` mock，并在 finally 恢复；不能把这一步标为真实 Windows 原生目录对话框验收。其余项目创建持久化使用真实 Renderer/preload/Main/Host 链路。Mocha 插件保留已有 bridge preflight 与各阶段 hooks；[插件加载验证](logs/e2e-preflight-project-bootstrap-loader.json)只验证组合结构，未执行 hook 或 UI。

在当前 wrapper 中 NODE_OPTIONS 已清空，NODE_COMPILE_CACHE、TSX_CACHE_DIR、npm store/userconfig 已定向本 run。复审确认 Hook 后续也把这四项路径纳入 required；初版拒绝所有非空 NODE_OPTIONS 会阻断 WDIO 自己注入的受控 tsx。后续只允许本工作树安装版 WDIO 的确切 loader URL（1或2次）及最多一次 source-maps，拒绝外部 loader、任意 require/未知 flag/三次注入，并再核对 loader 重解析点；[纯语法正反例验证](logs/e2e-preflight-bootstrap-node-options.json)实际执行，未执行 UI。初版 Worker 证据前缀为 `qa-project-bootstrap-<WDIO_WORKER_ID>-*`，创建前 JSON 保存 suites title/file；实际 core-retry 发现同 Worker 再次调用仍覆盖此前文件，15:48:14 的 0-0-before 已有项目，不能作为首次空项目的 Bug 证据。Hook所有者于15:53:22 UTC改为Worker、模块调用序号、PID和毫秒timestamp组合；PNG独占预留、JSON使用 `flag:wx`，每次before/after保存装载时hook SHA。见 [变更与语法检查](logs/e2e-preflight-bootstrap-metadata-change.json)。新Worker 0-6首次调用的 [before JSON](runtime/qa-menu-20261106-core-retry/evidence/qa-project-bootstrap-0-6-001-10316-1793980408042-before.json)与 [PNG](runtime/qa-menu-20261106-core-retry/evidence/qa-project-bootstrap-0-6-001-10316-1793980408042-before.png)已实际查看，项目表及UI均为空、迁移已登记；同调用after记录真实UI创建的1项目/1primary root。已经装载旧模块的Worker仍保留旧命名，原独立SQLite快照有效，不把后次覆盖文件解释为首次状态。上述是测试材料自主修正，没有修改产品行为；单独加载hook时仍须重复完整隔离审查。

`wdio.conf.ts` 的可选源码证据调用现有 `e2e-source-evidence.ts`：构建前后保存 `packages/*/src` TS/JS 文件的 SHA-256 与 staged app 输出指纹，不复制源码内容；复用构建会标为 unverified，构建中源码变化会单独标记。`fresh-stable` 仅证明这组 Renderer/Host/Main 输入文件在构建期间未变以及输出已存在，未覆盖 docs QA spec/hook、wdio 配置、apps CLI、package 配置和构建脚本。主报告须附实际对应 run 的 manifest，不把它扩展为完整构建输入或全部平台验收。

后续 core 首批取消的入口问题已由本轮 QA runner 修正：调用 pnpm test:e2e 时不再加入单独 `--`。安装中的 WDIO CLI 纯解析验证显示旧参数把 spec/mochaOpts 留在 positional，`mochaOpts=null`；修正后 `mochaOpts.require` 为所需 hook 数组，见 [两组参数解析证据](logs/e2e-preflight-cli-options.json)。该验证不启动 UI，新单 plus run 的实际 hook/UI结果仍需单独确认。新 run 的应用 HOME 使用 `.e2e-home-<RunId>` 保留既有归档测试的安全前缀，图片截图环境固定到当前 evidence 子目录；均仍受工作树路径和重解析扫描约束。这些是临时测试材料的自主修正，不是长期产品缺陷。

正确转发普通 CLI 后，core-final 的逗号连接21spec被 WDIO 当作一个文件路径，在 config 初始化退出1，尚无build/UI/case；[原始运行日志](logs/e2e-qa-menu-20261106-core-final.log)保留完整命令。Runner 后续改为逐项重复 `--spec`，仍按每项先做工作树存在/扩展名/祖先路径检查。新 core-retry 的真实运行结果在主报告独立追加；配置探针与取消都不计为产品bug。

曾评估本轮连续迭代复用 build，但现有 `fresh-stable` manifest 仅含 packages src 与 app 输出，Agent 构建在该 manifest 后执行，没有 CLI 构建前后完整源指纹。不能把事后当前 CLI SHA 反写成旧构建时事实。本轮取消复用 helper 方案，未创建新 helper、未开启 skip build；后续继续正常 fresh 构建，报告区分各 run 证据。

### Windows reload只读观察器

SC90退出屏障的原始摘要未保存底层cause及超时末刻PID，现有perf采样只证明关闭中的main/子进程曾存活，不能区分helper误判与产品退出问题。本轮新增外置 [CJS入口](reload-observation.cjs) 与 [TS实现](qa-reload-observer.ts)，由bootstrap所有者在原beforeEach之后、afterEach之前串接；已复审当前hook保留原bridge、SPFV observer及其它hooks，见 [注册与非目标guard静态核验](logs/e2e-preflight-spfv-observer.json)。

观察器在 `shutdownDriver:false` 的正式reload前只读获取权威main PID及现有身份collector的Windows进程集合，原delete返回时仅记时刻；afterEach以WMI读取PID创建时间及run/home marker并保存完整Error.cause，不访问已经失效的Renderer。系统完整命令行仅在内存中用于身份解析，不写证据；WMI隐藏子进程继承隔离环境、使用NoProfile，无清理/kill/timeout替换。独占证据只写本run工作树目录并检查祖先重解析。该辅助装配不能替代真实reload验收，当前静态退出0没有被算UI通过；执行与修复判定见 [专项计划](test-plan-reload-observation.md)。

### 活跃夹具目录扫描竞态与安全guard验证

local-actions初次和retry均未形成case：初次seed-lock消失返回PathNotFound；retry返回DirIOError/DirectoryNotFoundException，当时尚未归因，不能仅按错误名宣称目录瞬时消失。共享 [qa-reparse-children.ps1](qa-reparse-children.ps1) 当前仅允许这两类确切NotFound记录且二次确认queue路径仍不存在；已有路径、权限异常、其它IOException与重解析点继续拒绝，不以扩大忽略范围使测试绿。

已只读审查主任务保存的 [三项DirIOError分类probe](logs/e2e-preflight-reparse-dirio.json) 和 [六项动态删除/拒绝分支重跑](logs/e2e-preflight-reparse-race-recheck.json)，9个场景当前均PASS；原6项早期证据另保留。它们是工作树内合成目录/错误记录的QA安全检查，无应用启动，不纳入133个产品确定性test或任何UI通过率。后续local-actions真实case仍需独立执行和报告。源码manifest与当前QA材料的装载指纹范围保持各自限制，guard probe通过不代表所有运行时写入或完整构建输入都获得了证明。

local-actions-final随后仍在beforeAll扫描前置退出1、0case，错误为DirIOError且目标为CLI种子目录scripts。后续 [真实长路径对照](logs/e2e-preflight-long-path-powershell.json)确认259字符目录持续存在、是目录且非链接：Windows PowerShell 5.1.26100.9711稳定抛DirectoryNotFound/DirIOError，当前已安装PowerShell 7.6.9与Node 24.18.0均读取2项。因此撤回“可能瞬时child消失”的初始假设，本次是PS5.1长路径枚举能力限制，严格guard拒绝存在路径异常的行为正确。没有扩大catch或移除reparse检查。

QA所有者仅将bootstrap、local/residual spec的扫描子进程改用本机既有`C:/Program Files/PowerShell/7/pwsh.exe -NoProfile -NonInteractive`，路径仍经隔离环境传入、隐藏子进程且写入根保持工作树。主任务随后以同共享guard [完整扫描旧失败合成HOME](logs/e2e-preflight-long-path-integrated-scan.json)，PS7成功核对229目录/1169项并保留祖先与后代重解析检查。该集成扫描是只读环境验证，无应用case，不属于9项原guard探针或133项产品test；local-actions-ps7真实UI结果独立待追加。旧retry日志含同类长路径，但未保存当时目录存在性对照，不把第三次现场证明扩认成第二次瞬时状态。

Residual最近静态记录于18:40:26.492 UTC刷新，[e2e-preflight-residual-static.json](logs/e2e-preflight-residual-static.json)保存sourceSHA2eb73bb1…、13case注册/noEmit/public codec/targeted lint结果。该文件随QA修改刷新，旧menu-final/menu-reviewed装载输入与修正见[归因](qa-menu-reviewed-attribution.md)；随后supplement已经执行RLM04–13，不能仍称无UI。总QA配置包括services既有yazl/node-forge声明，不新增产品ambient声明；最终noEmit仍等待全部QA编辑结束。

PS7适配后 [独立静态核验](logs/e2e-preflight-ps7-adaptation.json)保存三个受改QA文件的新SHA：总QA noEmit、bootstrap语法、PS7共享guard只读扫描均退出0；定向oxlint退出1、1warning/0error，命中local spec第146行无用spread空fallback。这是实际失败的定向lint记录，不与较早root lint退出0混同；最终全仓门禁仍待最后编辑通知。旧Residual13静态SHA继续代表适配前输入，新SHA由本证据另列。

local-actions-ps7于17:13:15.762 UTC结束exit1、0case，PS7扫描已跨过但beforeAll/afterAll均在`footerSubmenu('locale')` locator等待停止。此时尚无12项test body或NDJSON，不能计产品菜单fail/pass；新的QA hook定位问题交由套件所有者审查，[summary](runtime/qa-menu-20261106-local-actions-ps7/evidence/summary.json)的infraFailureCount=0也不能抹除真实hook错误。

### 有限ReplayFixtures参数与截图前置

主任务新增wrapper的显式`ReplayFixtures`参数，混合pending/canonical批次须包含common与各case-local fixture，避免旧common-only覆盖抑制自动选择。只读复核参数在运行目录/build/UI之前逐项拒绝空token、非本树/非existing leaf `.json`，检查祖先及各父树重解析点；隔离环境/default设置之后才写入审核后的规范化列表。没有自动读取整个legacy池、改为capture或启用skip build。

[实际runner前缀预检](logs/e2e-preflight-replay-fixtures-parameter.json)保存1个有限7文件正例和空token/缺失JSON/越界3负例，4项均符合期待。它只运行参数前缀，没有runtime创建/build/UI，不纳入133产品test或E2E，且独立于9个目录扫描guard场景。当前本地canonical计划为9spec/13case、有限7fixture，见 [本地canonical计划](test-plan-local-canonical.md)；CFR英文commit和completed旧draft helper已排除，计划不代表运行通过。

SC13使用固定`.e2e-artifacts`的父目录已由主任务先做路径审查并在工作树内准备，见 [目录准备证据](logs/e2e-preflight-sc13-directory-ready.json)。这解除截图写入前置，不修改正式spec的硬编码路径契约，也不代替SC13主题/宽度/几何的实际结果；后续filtered结果独立追加。

filtered随后于17:25:41.566 UTC真实完成SC13全部case并通过；[实际NDJSON](runtime/qa-menu-20261106-filtered/evidence/test-results.ndjson)与本批exit1/19case的summary各自保留。整批失败来自其它case/hook，不抹除该条通过，也不代表硬编码路径已修复。

### 分组置顶单复现的独立只读sampler

新增 [计划](test-plan-grp-pin-targeted-repro.md) 与 [grp-pin-process-sampler.mjs](grp-pin-process-sampler.mjs)，只针对固定新run `qa-menu-20261106-grp-pin-repro`，尚未live运行。main身份同时要求工作树Electron executable、精确run/home与staged app参数、无child type；首次确认后固定PID与创建时刻，后代沿PPID并要求创建时刻不早于父进程，main退出后只追此前已确认代次。WMI使用既有PS7只读CPU ticks/workingSet/线程/handle；全系统命令行仅内存解析，不落盘，Host角色仅复用本run既有perf名称，无证据的utility保持未分类。

隔离runner已新增`grp-pin-sampler-static`、`grp-pin-sampler-lint`与供root后续启动的`grp-pin-sampler`入口。首轮装载SHA为`60f647800a062a7221c9d7195d0a6d44b73dfd0c78ca34066aa00ecc624c7`；当前版本`node --check`退出0，[纯内存9项身份/CPU guard](logs/validation-grp-pin-sampler-static.json)退出0，[定向oxlint](logs/validation-grp-pin-sampler-lint.json)退出0、0warning/error。live前依据`wdio.conf.ts:503,2998`核对真实`--app=<main/index.js>`参数，已改为完整精确entry匹配，并增加错误entry后缀与早于父进程创建时间负例。首次定向lint曾有prefer-startsWith警告，已在本辅助文件修正后重跑；不修改产品代码。

Live入口要求全部HOME/TEMP/npm/tsx/Corepack/data路径在工作树、外部Node loader清空且目标runtime/旧exit证据不存在，须先sampler后wrapper。默认2秒、最多15分钟，实际WMI时长另记；唯一时间戳NDJSON使用独占文件句柄，完整exit-code/summary或上限自然收尾。没有kill、CDP/UI请求、重试/timeout变更，也不扩大到其它run或系统进程。静态9probes不是133产品确定性test或E2E，live采样与canonical结果待root全部既有planned批次结束后串行执行。

menu-reviewed RLM03超时后主任务另授权 [两次CIM计划](test-plan-menu-hung-observation.md)，新增独立 [观察器](menu-hung-cim-observation.mjs)，没有放宽原GRP sampler。`node --check`退出0；隔离runner实际执行 [命令/退出码](logs/validation-menu-hung-cim.json)为exit1，两次完整run/home/app identity都未匹配， [两点JSON](logs/validation-menu-hung-cim-1793989860430.json)保存空processes及拒绝原因。锁定RLM0-1 perf main25980，不采其它worker。读取既有生命周期确认worker已于18:27:07.090 UTC退出，观察发生18:31:01/.04 UTC，属于after exit / no liveCPU；[详细边界](logs/validation-menu-reviewed-session-attribution.md)不推断死循环或使用SLM新Main补造CPU。

### 可选SafeTerminal启动前审查

只读复审wrapper新增`-SafeTerminal`：进程PSModulePath限制到本机既有PS7/Windows系统模块根，先检查两根及所有既有子项无reparse；模块analysis cache、HOME/USERPROFILE/TEMP及其它缓存仍定向工作树，并禁用PowerShell遥测。新prebuild NoProfile探针重新核对PATH首个pwsh为既有PS7、profile四入口的祖先重解析点，存在的外树profile一律拒绝；PowerShell可能追加的工作树模块目录允许，已审系统根允许，已知且不存在的Program Files模块目录单独记录，其它外树目录拒绝。

较早 [有限启动前缀记录](logs/e2e-preflight-safe-terminal.json)中`modulePathExact=false`和`terminalApproved=false`保留当时边界，不伪写成PTY通过。后续 [正式prelaunch证据](runtime/qa-menu-20261106-terminal-preflight/evidence/qa-terminal-prelaunch.json)实际为PS7.6.9、4个profiles均不存在、shellMatches与模块分类通过，仍明确只是NoProfile前置。`qa-short-local-menus`的terminalGate还会从实际Main读取隔离env/PATH、验证当前Main→Host sanitizer→Terminal继承源码SHA、再从实际Main执行只读NoProfile probe；通过后才打开PTY。没有现成Host/PTY运行证据时，不把wrapper或静态source合同扩认真实Terminal执行与profile加载验收。

### 实际Pending与skip的统计合同

已读安装版`@wdio/mocha-framework`/`@wdio/utils`：动态Mocha `this.skip()`识别Pending后仍调用配置afterTest，结果为`passed:false, skipped:true`；本仓reporter没有独立onTestSkip写NDJSON，afterTest保存`result.status`但当前utils没有给status/skipped字段。当前`e2e-reporting-summary.ts:460–478`先排除skipped/pending status，再把无status、passed=false且空error/errorStack、unknown/空category作为旧skip兼容记录。

本轮 [计数器](logs/validation-e2e-counts.mjs)与 [纯分类helper](logs/validation-e2e-result-classification.mjs)保持相同summary合同，保存每条`outcome/classificationSource`，将unique、任一已执行unique、最新pass/fail/skip与全部尝试pass/fail/skip分开。实际动态skip须与CLI和步骤JSON联核，不能只按false当FAIL；无case的hook阻塞也不伪计skip。 [7个纯内存分类probe](logs/validation-e2e-result-classification-static.json)退出0，仅验证QA聚合，不计133产品test或UI。menu-reviewed的QLA07已实际limited→context.skip，QLA09真实通过，不能沿用早期计划假设；早期无skip统计值保留为历史截点。

Browser human冷重启已实际生成 [独占observer JSON](runtime/qa-menu-20261106-browser/evidence/qa-reload-observe-0-3-2-32284-1793986710714.json)：before-delete的Main18192与13个初始PID在after-test全部不存在，新Main32720创建于17:38:36.331 UTC、run/home一致，原delete时刻均落盘。本case在reload后的Browser launcher前置失败，不是该轮退出屏障失败。内部第二delete的Main bridge读失败仅写observer-read-error；test.error为null时仍以真实NDJSON错误为准，不能反写不存在cause或由此扩认SC90修复。

### 当前只读统计截点

18:02:48.597 UTC独立 [counts010](logs/validation-e2e-counts-010.json)已包含local-canonical当前2条实际失败，全轮118unique/151attempt、latest98PASS/20原始FAIL/0SKIP、全部119PASS/32FAIL/0SKIP。该run仍无退出码记录；MPS已确认为Windows路径未CSS转义的QA selector错误，真实拖选失败仍待归因，不提前判新产品缺陷或将9spec/13case计完成。最后root typecheck/lint/architecture与外置QA noEmit继续等待全部UI批次及QA编辑完成通知。

18:07:34.118 UTC的 [counts011](logs/validation-e2e-counts-011.json)纳入本批8实际case（6PASS/2FAIL），全轮124unique/157attempt，latest104PASS/20原始FAIL，全部125PASS/32FAIL，0SKIP。新增PIA01/02、文件树搜索2条、OPS01/02实际通过；未有本批退出/fit证据，不将静态observer接入或计划数量算通过。

local-canonical于18:11:09.378 UTC完整结束exit1、13case=8PASS/5FAIL；18:13:02.110 UTC的 [counts012](logs/validation-e2e-counts-012.json)为全轮128unique/162attempt、latest106PASS/22原始FAIL、全部127PASS/35FAIL、0SKIP。取消core的1次重复PASS仅增加尝试，已完成批次为161次。新增SE-02/03实际通过；MPS、TRJ、TSL08为QA合同漂移，SSC终段选区仍待归因。

18:23:23.896 UTC的 [counts014](logs/validation-e2e-counts-014.json)是menu-reviewed运行中截点：14记录=10PASS/3FAIL/1SKIP；全轮142unique、141uniqueExecuted、176attempt、175executed，latest116PASS/25原始FAIL/1SKIP，全部137PASS/38FAIL/1SKIP。没有该run final exit，不能替代最终统计。QLA07 NDJSON为passed=false且无error，步骤JSON明确limited及空memory catalog，suite保存证据后context.skip；QLA09真实PASS。QLA05/08与RLM02正在归因，未新增确认产品问题。

18:26:07.086 UTC的 [counts015](logs/validation-e2e-counts-015.json)新增RLM03失败，全轮143unique/177attempt、latest116PASS/26原始FAIL/1SKIP、全部137PASS/39FAIL/1SKIP。RLM03点击Mark as unread后首个element请求与诊断DOM/finally/afterEach连续超时，最终栈被finally覆盖；[只读逐步归因](logs/validation-menu-reviewed-session-attribution.md)不含live资源采样，不新增确认产品bug或伪造未抵达case。

实际fit [6.3KB摘要](logs/validation-composer-fit-attribution.json)保存原789713B/24帧SHA与两240px帧；[生产源码内存probe](logs/feature-inventory-fit-probe.json)在不装载React/Electron的非渲染合成DOM上确认测量副本缺四个布局节点、完整结构直接fit生成model-icon，而副本提前返回。已登记BUG006/P2；此probe不增加133或E2E，真实outer窄布局、ref归属/SPFV关联待独立验收。TSL08的 [reload与规范归因](logs/validation-tsl08-attribution.md)显示oldMain30304及12初始PID退出、新Main30660身份匹配，旧无项目期待冲突当前失效项目原选择规则，不把它当退出屏障产品失败。

menu-reviewed于18:38:45.834 UTC完整结束exit1，5spec/47it计划实际37记录=18PASS/15原始FAIL/4SKIP。QLA07保存memory开关有局部通过但空catalog scope/refresh未验，SLM05/14是公开只读fixture没有runtimecopy/Find，SLM07已有AstrBot配置而guard正确skip；四项实际Pending与步骤JSON联核。QLA09真实PASS。RLM03未读菜单点击后同session协议持续超时、后10项无case；ARM08/07旧开关位置失败后留在General，后3列表断言属QA级联而非seed丢失。QA原因与后续最小适配见 [menu-reviewed归因](qa-menu-reviewed-attribution.md)，没有改产品或把静态READY算UI通过。

SPFV002在menu-reviewed真实560px空输入浮窗折两行，outer shell有`composerLayout:inline/composerModelIcon:true`，inner named `group/toolbar` dataset为空、模型文字仍block。已独立查看PNG并复核owner源链，确认BUG007/P2；[只读压缩摘要](logs/validation-spfv-attribution.json)保存原DOM/PNG与source SHA、geometry和一次实际复现边界。两份同counter快照不算独立重跑；64px旧断言不是规范。`ChatPromptEditor`的outer/inner共享toolbarRef，inline算法已写outer flag而CSS仅消费inner named group flag；该路径绕过BUG006的clone测量、确实生成true，因此两项不能合并同根因。

首个GRP独立run在Agent fresh build写`process-lifecycle.d.ts.map`时TS5033 UNKNOWN，onPrepare退出1、0case，[完整build日志](logs/e2e-qa-menu-20261106-grp-pin-repro.log)保留；[85点sampler](logs/validation-grp-pin-sampler-1793990457431.ndjson)自18:40:57.431至18:43:46.935 UTC自然收尾、所有main=null，与UI前失败一致。没有挂起现场CPU、没有确认文件锁根因，没有删除/恢复既有map或跳build。root授权固定retry，sampler当前仅锁`qa-menu-20261106-grp-pin-repro-retry`，原run与证据保留；新 [14纯内存guard](logs/validation-grp-pin-sampler-static-retry.json)、[语法](logs/validation-grp-pin-sampler-syntax-retry.json)、[定向lint](logs/validation-grp-pin-sampler-lint-retry.json)均exit0，0warning/error。[18:49:19启动前检查](logs/validation-grp-pin-sampler-prelaunch-retry-evidence.json)确认runtime/staged app/exit均不存在、祖先无重解析，SHA b92d49ef…cf073。该段为第二轮启动前历史；随后实际执行结果见下文，原timeout/CPU逻辑不变；先sampler后wrapper规则继续执行。

root的 [真实map打开探针记录](logs/qa-map-open-probe.json)为`FileMode.Open / FileAccess.ReadWrite / FileShare.ReadWrite`，打开675B既有文件成功并finally Dispose，写入字节0；保留打开前SHA a0c4526c…d5c22、Archive属性与mtime18:16:07 UTC。探针工具执行没有独立秒级时刻，只能定位到首次GRP失败后、supplement启动前，不能用文件mtime推断探针时间。没有truncate、内容写入、删除、恢复或ACL修改；成功的事后Open不能确认先前TS5033原因。随后local-supplement按原正常fresh build完整完成Agent，18:53:12.784 UTC进入worker0-0，见 [原日志](logs/e2e-qa-menu-20261106-local-supplement.log)；这仅证明当次构建前置成功，不称已修复文件锁或产品缺陷，case结果仍独立统计。

supplement的RLM04在18:57:46.941 UTC保存同一打开Actions弹窗的两个Settings可见灰选中行；实际选中query返回e.83/e.84、pickerCount=1。已独立viewPNG并复核源码及安装cmdk选择规则，确认BUG008/P2：[小摘要与SHA](logs/validation-command-center-selected-attribution.json)。quickPick两个ID共用title/keywords，CommandCenterDialog793只用title+keywords作为value，cmdk所有同value项同时aria-selected/data-selected=true。不是隐藏DOM计数；实际pointer选择后首断言停止，箭头/Enter与设置动作未抵达，没有重复执行证据。RLM07同run只是支持，不增加独立bug或重复复现数。

### 补测、第二GRP与第三轮准备

local-supplement于19:05:28.964 UTC结束exit1、19实际=11PASS/7FAIL/1SKIP。SLM13严格profile对象unknown keys使PTY前skip；SLM15正文textContent精确断言超时，但PNG可见预期@pierre/diffs File正文，后滚动/Find未达。HIST2为旧公共codec前置，RFC/RMC实际0case、有限replay request guard失败，不能算复制或查找失败。详见 [独立归因](logs/validation-supplement-attribution.md)。

第二GRP于19:09:58.714 UTC结束exit1，仅1case在218行缺task-group-add前置停止，没有首发或pin。既有perf已见Main8448、Renderer25532、Host28484；[121点sampler](logs/validation-grp-pin-sampler-1793991958119.ndjson)全部未匹配root，不证明无Main，更没有挂起CPU。[固定旧PID事后诊断](logs/validation-grp-pin-retry-identity-diagnostic.json)执行时旧PID已退出，不确认先前quote结构。

第三轮仅接受固定`qa-menu-20261106-grp-pin-grouped`；严格原始Windows token解析后核完整run/home/entry，支持值quotes和整tokenquotes，拒绝旧run/重复/后缀/未闭合quote/外树executable。[28项内存guard](logs/validation-grp-pin-sampler-static-grouped.json)、[语法](logs/validation-grp-pin-sampler-syntax-grouped.json)exit0；[lint](logs/validation-grp-pin-sampler-lint-grouped.json)exit0/0error，旧事后diagnostic保留2 useless-escape warning。19:20:42.655 UTC的[prelaunch](logs/validation-grp-pin-sampler-prelaunch-grouped-evidence.json)runtime/staged app/exit均不存在、祖先安全，SHA22ded6f9…b9c64。该准备不启动sampler/UI，不增加产品test/E2E；原两轮证据保留，旧live aliases停用，CPU/创建时间/PPID与时限边界不变。

archive-list-retry于19:19:55.085 UTC结束exit1，NDJSON与CLI均为ARM01/05/06旧layout switch前置FAIL、ARM02缺alpha FAIL、ARM03 PASS；总3=1PASS2FAIL。不能把口头标题错位当reporter错误或将ARM01称整case通过。全轮[最新去重counts026](logs/validation-e2e-counts-026.json)不把复跑增加为新的unique。最终必需门禁仍等待root全部UI退出与QA编辑结束通知。

首锁路径防护最终源SHA `ad11d09c35475c3859d0acafdc8d9cb880faf694af47bbcf9537d618b0155254`：候选首次锁定前再次核executable/appEntry/HOME物化祖先无重解析。[最终syntax](logs/validation-grp-pin-sampler-syntax-grouped-final.json)、[28probe](logs/validation-grp-pin-sampler-static-grouped-final.json)、[两文件lint](logs/validation-grp-pin-sampler-lint-grouped-final.json)均exit0、0warning/error；[19:27:11UTC最终prelaunch](logs/validation-grp-pin-sampler-prelaunch-grouped-final-evidence.json)目标三路径仍不存在。较早22ded6f9指纹与含旧诊断2warning的lint保持历史，不反写为最终输入。

residency-final于19:26:30.368 UTC记录唯一PASS，完整冷重启后0tab；[独立PID摘要](logs/validation-residency-reload-attribution.json)从既有observer只读提取：旧Main10640及13初始PID均消失，新Main31192创建时间19:26:25.797836Z、run/home匹配。原第二delete observer-read-error保留，不覆盖真实casePASS；复用1真实guest验证33logical limit，不称32live guest压力或macOS。第三GRP已先sampler（19:27:55.811UTC）后root唯一UI启动，固定grouped run；当前仅build/运行，不预记结果，也不修改active sampler。

GRP第三grouped于19:33:56.494 UTC实际exit1、1case FAIL；[181点sampler](logs/validation-grp-pin-sampler-1793993275811.ndjson)19:33:58.254 UTC按summary自然结束exit0，首锁Main32200创建19:31:10.757536Z，最终装载源SHAad11d09c…55254一致。Host30244、scheduler29152由本run19:32:00.501既有perf确认。pin返回19:32:03.197→focus true19:32:03.220→element POST19:32:03.221超时19:32:33.233→screenshot超时19:33:03.281→app quit barrier失败→DELETE超时19:33:44.480。[只读窗口摘要](logs/validation-grp-pin-grouped-live-attribution-1793993639704.json)含58点窗口/55点资源及最后Main消失；CPU不证明死循环。与filtered独立run同症状，记高优先运行候选，产品/driver归属待查、8确认数保持；多个timeout只是一条case。

### 测试副本清理限制

root已准备只清理本轮自己创建的`packages/desktop/.e2e-cache/qa-menu-20261106-core`与`packages/desktop/.e2e-cache/qa-menu-20261106-grp-pin-repro`两个staged副本；目标祖先/后代重解析审查与native PowerShell删除命令在CreateProcess之前被自动审批拒绝（`blocked by policy`），没有执行、没有删除或cleanup JSON。两个副本仍保留，未重试或换工具绕过。其它运行的自然清理按既有runner执行；没有清理out、bundled Agents、声明map或真实用户目录。

归档动作QAR于19:43:17.629 UTC完整exit0，QAR01/02实际2PASS；[case](runtime/qa-menu-20261106-archive-actions-final/evidence/test-results.ndjson)与各步骤保留CLI restore、delete取消不改库、确认单删、冷重启不复活和旁路task保留。[既有reloadobserver](runtime/qa-menu-20261106-archive-actions-final/evidence/qa-reload-observe-0-0-4-31128-1793994171626.json)before旧Main30896及12PID在after全部消失，新Main31376创建19:42:57.180270Z、run/home匹配；内部第二delete readerror保留，不覆盖casePASS。QAR是外置新fullTitle2unique，不伪改旧ARM失败记录。

已读[QA最小归因](logs/qa-local-supplement-attribution.md)：旧RLM05全局NewTask转到新draft workspace，查询只取当前workspace且排active，原alpha查询范围前置错误；RLM06和SLM15 preview正文真实显示于@pierre/diffs File open shadowRoot，旧body.innerText/父textContent未进入owner。当前qa-preview-dom只递归preview已知节点并对U+00A0作唯一空格归一；旧run没有shadow快照，不能追认旧现场NBSP。修后静态READY不计UI，最终门禁继续等待最后5spec15it实际结束。

local-supplement-retry于20:01:09.916 UTC完整结束exit1，5spec/15实际case为9PASS/5原始FAIL/1SKIP，见[NDJSON](runtime/qa-menu-20261106-local-supplement-retry/evidence/test-results.ndjson)、[summary](runtime/qa-menu-20261106-local-supplement-retry/evidence/summary.json)及[运行日志](logs/e2e-qa-menu-20261106-local-supplement-retry.log)。RFC02四种会话查找导航与RMC03完整Markdown复制/拒绝恢复实际通过；HIST01六角色/复制/折叠/展开、RLM06 File open-shadow正文、SLM15长文本滚动、FLG01–03设置/目录取消与FLG07合成51项目分页筛选排序实际通过。RFC01误向row内寻找轮尾copy动作，未点击复制；HIST02合成request.messages未累计导致第二marker被当前timeline投影抑制，后续虚拟列表/33MiB尾读未达；RLM05再次在最近查询前置超时。FLG04 stale/value与FLG05错误device子菜单前置由QA所有者独立归因，不能据原始5FAIL增产品bug数。

[FLG独立归因](logs/qa-final-local-gaps-retry-attribution.md)限定FLG04的事实为elementClear成功后旧input引用stale，尚无blur现场事件证据；FLG05当前Memory scope采用FlatScopeMenu而非DeviceScopeMenu。FLG07的真实50→51分页、三个sort与选择恢复限于51个roots=[]、零任务并列项目及名称tie-break；新项目处于七天宽限，unused空态是预期，不扩认为不同任务数或真实目录项目全量管理验收。

FLG06在worker继承Git环境严格准入前实际context.skip，[独占步骤JSON](runtime/qa-menu-20261106-local-supplement-retry/evidence/qa-final-local-gaps-0-3-30892-1793995010062/023-FLG06.json)记录blocked与`Unknown inherited Git environment key rejected`；CLI143182–143188为1skipped，summary为1skip，NDJSON是passed=false且无error。未知键名未采证，Main/Host gate、git init/diff和文件菜单均未抵达；它是环境/准入受限的真实SKIP，不是产品FAIL或PASS。标准编码器未提供，[附加证据](runtime/qa-menu-20261106-local-supplement-retry/evidence/qa-final-local-gaps-0-3-30892-1793995010062/024-FLG06-recording-limit.json)仅保留PNG/时间序列，不称标准视频通过。根任务安排已证QA的最小修正及收尾复验，最终门禁继续等待该轮结束通知。

最终验证入口已准备`desktop-e2e-typecheck-final`：隔离runner执行`corepack pnpm --dir packages/desktop typecheck:e2e`。已核当前脚本先运行e2e-report的`build:node`（仅`tsc -p tsconfig.json`，输出本树dist-node且被prepare输出审查覆盖），随后desktop tsconfig.e2e执行noEmit；未构建viewer或installer。加此入口后runner `node --check`退出0，尚未执行最终五项验证。最终顺序为安全prepare、desktop E2E类型检查、root typecheck、root lint、architecture --changed、外置QA noEmit；报告/矩阵相对链接与87显式anchor另做只读核验，不并入133或UI计数。

local-final-targeted于20:15:28.484 UTC完整结束exit1，4spec/6实际case为3PASS/3原始FAIL/0SKIP，见[NDJSON](runtime/qa-menu-20261106-local-final-targeted/evidence/test-results.ndjson)、[summary](runtime/qa-menu-20261106-local-final-targeted/evidence/summary.json)及[日志](logs/e2e-qa-menu-20261106-local-final-targeted.log)。RLM05任务范围查询、FLG04已有AstrBot改名草稿Escape与路径复制、FLG05合成记忆scope/search/clear/refresh均实际通过，不能继续以旧前置失败当当前结果。RFC01仍在copy按钮唯一性前置失败，尚未点击；HIST01新累计夹具未显示system/tool-result而失败，HIST02依赖前置未执行后续动作。旧HIST01的六角色/复制/展开PASS保留为上一输入的历史证据，但最新状态为FAIL，不能把新夹具失败吞掉。全部case身份重合，增加6次尝试、不增加唯一用例；本批未新增确认产品Bug。

[HIST当前源纯函数佐证](logs/feature-inventory-historical-cumulative-current.json)为currentMode=true、accepted=true，只在当时当前/拟议累计输入上确认1与42两个marker投影；originalFilePresent/Read=false且reconstructionMatchesCapturedSha256=false。旧run路径已由其生命周期移除，未恢复文件；此记录不是逐字重读或成功重建旧raw证据，也不属于133或UI。该历史截点六角色失败与第二case受阻保留，不能以静态probe通过替代UI。其后最后copy-history-final及五项门禁均已实际完成，最新结果见本文首屏。
