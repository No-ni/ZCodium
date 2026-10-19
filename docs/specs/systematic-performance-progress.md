# 系统性性能优化进度（2026-10-19）

Goal：八个性能领域均按当前源码检查，实施收益明确且风险可控的候选；另完成用户已授权的 Bot 关闭契约。状态：完成，环境限制见下。未提交、推送、发布或触发构建。

## 基线与边界

- 原任务记录 freshness（含 fetch）通过、typecheck/lint 通过、架构 0/0/0。续接时 HEAD 为 `47fcbe890a14994dbd2f28ac42a16bd6de875b4d`；freshness fetch 因 curl 56 连接重置失败，`--no-fetch` 显示 main 相对 origin/main ahead 0 / behind 0。不能把本地引用等同远端实时状态。
- PowerShell 7、corepack pnpm 10.33.2；验证使用预装 Node 24.18.0，mise 要求 24.14.0，未找到 mise。尝试获取官方 24.14.0：nodejs.org 下载停在 4096 字节，确认进程仍在且 7 分钟无进展后终止；npm Windows 包在 40 秒超时，仅收到部分数据。未运行未完成/未经校验的下载、未修改全局环境；指定版本验证未完成，属于网络环境限制。
- 开工已有 `.github/workflows/desktop.yml`、Desktop/Web/Relay 手机远控及相关 spec/test、`docs/reviews/`、Markdown round26 生产文件/测试/spec。保留这些改动，不计为本 Goal 成果。
- 使用 architecture-governance、vercel-react-best-practices、agent-browser；已读 services/desktop/ui/rpc/plugin-ui 受控上下文、RPC/plugin-ui 及直接依赖契约、DESIGN/CONTEXT。plugin-ui 是 managed 模块，其余本次生产改动归 legacy services/desktop。未更改依赖边界。

## 八领域结论与候选

P1=高频且收益明确，P2=特定场景的重要成本，P3=收益或安全等价证据不足。路径均相对仓库根；确认程度及验证单列，不以扫描命中数量作为结论。

| ID / 领域 / 优先级                        | 具体路径与触发                                                                                                               | 证据、成本、方案及风险                                                                                                                                                            | 结果与验证                                                                                                                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 Electron 通信、状态事件、数据处理 / P1 | `packages/desktop/src/main/taskRealtimeBus.ts` rememberReplayBatch，每次 stream flush                                        | 已确认：反复序列化最多 60 批 replay 窗口。复用 gate 的准确 JSON UTF-16 字符长度，条目淘汰同步减总量。风险是 reset/淘汰漂移                                                        | 已实施；真实 Bus + 合成 Host、旧算法差分、精确阈值/Unicode/terminal/stale owner/run/跨 workspace/late subscriber 验证                                                         |
| C2 Electron 通信、数据处理 / P2           | 同文件 splitOversizedBatchForOwner，含大量 op 的超限批次                                                                     | 已确认：每追加 op 都复制、扫描和序列化整个前缀。改为 op 精确长度 + 小 envelope + 逗号；保留 seq 位数、terminal、单个超大 op 边界                                                  | 已实施；分片完整输出差分及真实 schema publish 回归；不声称 IPC 次数减少                                                                                                       |
| C3 异步 IO、内存生命周期 / P2             | `packages/services/src/bots/botRemoteWorkspaceBridge.ts` 三类 Main 请求完成                                                  | 已确认：成功/失败回包仍保留 5/60 秒 timer。统一登记并完成即取消；同步回包不创建 timer，发送错误清登记；不改变原期限                                                               | 已实施；18 项正常/错误/并发/精确 deadline/同步响应/identity 测试                                                                                                              |
| C4 React 渲染 / P1                        | `packages/ui/src/plugin-ui/adapters/usePluginUiToolCallModel.ts` 的裁决订阅，正文续写                                        | 已确认：store 重建字段相同的对象也触发各卡片 render。模块内 usePluginUiRowDisposition 用 useShallow 稳定全部浅字段，保留每次原通知。风险为漏字段/跨 scope 陈旧值                  | 已实施；同浏览器新旧对照和逐字段、aging、pin、删除、换会话、卸载重挂验证。单 hook 只保留一个快照，无跨会话缓存                                                                |
| C5 内存生命周期、状态事件 / P2            | `packages/services/src/bots/feishuChannelRuntime.ts` SDK terminated 与 waitForAbort race                                     | 已确认：共享 runtime signal 上每次失败遗留一个 abort listener。每次连接用局部组合 signal，finally 只取消该等待                                                                    | 已实施；真实 runtime+合成 SDK/锁/时钟，8 次失败、正常终结、dispose、5000ms 重试及锁/连接释放顺序验证                                                                          |
| D1 已授权生命周期修复 / P1                | Bot bridge、botRemoteRuntimeServices、botsService 的关闭链                                                                   | 已确认：dispose 清 Map 后 Promise 永久悬挂，且生产没有调用 bridge.dispose。用户已授权明确关闭错误；统一取消本地等待、禁止新请求、清理在途/已返回 adapter，并接入 BotsService 关闭 | 已实施；21 项 bridge 测试 + 2 项真实 RPC adapter 测试；这是有意修复关闭行为，单独列出，不包装成性能等价修改                                                                   |
| R1 React 渲染复查 / P3                    | `ConversationTimeline.tsx`、`ConversationTurnGroup.tsx`、`useConversationProjection.ts`                                      | 已有虚拟列表、session-scoped render cache、memo 和稳定 row；当前 session 投影通知仍必要。全状态订阅不能证明历史 DOM 重渲染                                                        | 定向复查发现 C4 并处理；其余不盲加 memo 或删通知，行共享/turn cache 回归已纳入                                                                                                |
| R2 状态与事件 / P3                        | `conversationProjectionStore.ts`、`packages/rpc/src/channelClient.ts`、channelServer.ts                                      | generation/stale ACK、listener 清理、runtime unavailable 与 transport replaced 分支已有明确语义；通知包含连接事实                                                                 | 不合并必要通知；双 delivery kind、RPC 生命周期及 projection recovery 测试已纳入                                                                                               |
| R3 异步与 IO / P3                         | `packages/services/src/file/fileService.ts`、bots/providers/providerRequest.ts                                               | file scan 已有 worker 队列、existsBatch 限 15 并发、readRange finally close；provider 的 deadline 包含响应体并清外部监听器                                                        | 排除盲目 Promise.all/缩短 deadline；文件扫描与 IO compatibility 回归已纳入，C3/C5 单独修复                                                                                    |
| R4 启动与加载 / P3                        | desktop renderer main.tsx、ui/root/LazySettingsPage.tsx、ui/ChatMediaAttachmentPreviewDialog.tsx、ui/lib/shikiHighlighter.ts | E2E bridge 条件加载、Settings/PDF 懒加载、Shiki 按需加载与 in-flight 复用已存在。聚合 import 过重仅是假设，缺生产 bundle/启动 profile                                             | 不实施无测量的拆包。early database/硬件加速 bootstrap 的同步设置读取有“先于日志路径/Chromium 初始化”要求，不能盲改为延后异步。startup gate 测试已纳入；未构建或测量安装包启动 |
| R5 内存与生命周期复查 / P3                | ui/lib/chatSessionScrollMemory.ts、shikiHighlighter.ts；services/bots/channelRuntime.ts、providers/feishuProvider.ts         | scroll=200 项；token cache 同时限 128 项/2M 字符/100k token；in-flight finally 移除；锁 heartbeat release 清 timer，SDK close 清 poll；waitForAbort 仅有 C5 一个调用方            | 排除无限缓存/合并 Shiki 引擎；C5 和 D1 已处理。其他局部 AbortController 不跨重试复用，不能等同共享 signal 累积                                                                |
| R6 日志与持久化 / P3                      | desktop/main/logger.ts、hostLogRelay.ts、services/logger/serviceLogger.ts、session/tasksDatabase/startup.ts                  | 异步串行日志限 512 pending、host 暂存限 128，production debug 在序列化前退出；每次 mkdir 同时提供目录被移除后的恢复。数据库迁移在 Host Worker 串行有序且 finally close            | 不批写/跳 mkdir/改变 migration 顺序：缺真实吞吐瓶颈及失败恢复等价证据。14 项诊断测试通过；无真实日志吞吐或磁盘写入收益宣称                                                    |

## 实测与行为等价证据

- C1：相同 120 个 stream flush，序列化输入中的 op 访问量从 **5550 降到 120**；真实 Bus 新实现与保留的旧 replay 算法对照。UTF-16 大小定义、60 批/512 Ki 字符淘汰和原投递事件均保持。
- C2：同一 1200 op 批次，序列化 op 访问量从 **454529 降到 1200**；所有输出分片与旧算法深度相等。上述是合成输入的工作量实测，不是 CPU 时间、端到端延迟或内存字节收益。
- C3：原任务旧实现记录三种请求各 64 并发完成后 timer 仍为 64；续接新实现测试三种均为 **0**。原任务记录来自附件，本轮重跑新实现确认，不虚构旧版耗时。
- C4：续接时同一个隔离 Edge、同输入的旧订阅/新 hook 对照；12 卡 × 30 次正文更新，1280×900 和 390×844 两种宽度的额外 render 均 **360 → 0**。逐字段变化及手动 pin 仍立即更新。仅代表裁决订阅引起的 render，不代表整个 Timeline 零渲染。
- C5：续接先跑旧生产实现，8 次失败后的监听器为 **[2,3,4,5,6,7,8,9]**；新实现为 **[1,1,1,1,1,1,1,1]**，dispose 后为 0。原 SDK signal 未被局部 abort，旧 client/lock 先清理再退避。
- D1：先在旧实现运行关闭契约测试，16 项失败；接入 BotsService 的两项新增测试先确认旧调用链悬挂。修复后全部通过。Bridge 关闭错误与 RPC 的既有 ConnectionClosed 分层保留，无新增协议字段或远端业务取消指令。

## 规格与主要文件

- [实时总线规格](performance-realtime-size-accounting.md)：`packages/desktop/src/main/taskRealtimeBus.ts`、同目录 taskRealtimeSize.test.ts/reference.ts。
- [Bot 请求 timer](performance-bot-request-timers.md)、[关闭契约](bot-remote-bridge-lifecycle.md)：`packages/services/src/bots/botRemoteWorkspaceBridge.ts`、botRemoteRuntimeServices.ts、botsService.ts；test/botRemoteRequestTimers、botRemoteBridgeLifecycle、botRemoteRuntimeServices。
- [飞书等待器](performance-feishu-abort-wait.md)：`packages/services/src/bots/feishuChannelRuntime.ts`、test/feishuAbortWaitCleanup.test.ts。
- [插件裁决订阅](performance-plugin-disposition-subscription.md)：`packages/ui/src/plugin-ui/adapters/usePluginUiRowDisposition.ts`、usePluginUiToolCallModel.ts；test/performance-plugin-disposition.tsx/html；`scripts/ci/performance-plugin-disposition-browser.test.mjs`。

## 验证记录与恢复位置

- 专项分批验证：Bot timer 18 项、bridge 生命周期 21 项、真实 RPC adapter 2 项、飞书 4 项，合计 **45 项通过**。浏览器对照 **1/1** 通过；local/desktop diagnostics **14/14** 通过。
- 扩大回归命令见下；首次 96 文件、704 项中 **703 通过/1 失败**。唯一失败是本轮新写的旧分片工作量断言误设为 >500000，实测 454529；修正并添加混合并发/偏好版本用例后，最终整合回归 **96 文件、706/706 通过**（75.67s）。之后为 spec 的 stop 场景补充 active/backoff 两项测试，飞书文件 **4/4 通过**。当前共有 708 项已验证的相关 Vitest 用例；没有功能差分失败。
- 本次新增的 SSH 联合类型闭包窄化错误和 bridge 超出 400 行的 lint 错误均已修复；基线算法工作量断言错误也已修正。最终 **typecheck 通过；lint 3098 文件、0 warning/error；架构 violations/baseline/new=0/0/0；21 个匹配文件的定点格式检查通过；git diff --check 通过**。最后新增的 stop 测试已格式化并再次通过 lint，没有关闭校验规则。
- 未运行完整安装包/Electron guest/真实插件或真实飞书网络 E2E。浏览器夹具用真实 React hook/store/派生，不启动真实 Agent，外部请求被阻断；临时 profile/Vite cache 已清理。agent-browser CLI 不在 PATH，复用仓库已有 Playwright/Vite 入口，没有安装依赖。
- 自动审批拒绝清理临时 Node 下载，返回原因仅为 `blocked by policy`；改为逐个指定文件删除仍被拒绝，因此没有改用其他工具绕过。约 217 KiB 残片留在 `C:/Windows/TEMP/zcodium-performance-node-24.14.0`（node.exe、node-win-x64.tgz、SHASUMS256.txt）。这不是构建产物，文件未被执行；本任务没有生成安装包或长期 artifact。

## 完成审计

1. 八个领域都有当前源码依据与明确结论，表中涵盖位置、触发、成本、可信度、风险、验证和优先级；复查从 React 发现 C4、从共享 signal 发现 C5、从关闭调用链发现 D1 接入缺口，均已处理。
2. 收益明确、风险可控的 C1–C5 已实施并验证；已授权 D1 已接入真实 BotsService 关闭链。R1–R6 的其他项有明确的不实施理由或测量缺口，不以增加修改量代替收益。
3. 保留 identity/path 分工、owner/lease、stale run、跨 Host 路由、desktop continuous/mobile replayable、序列号与 gap 规则。合成 Host 差分、RPC/server/projection/mobile 回归提供对应证据；唯一有意改变的行为是用户批准的 Bot 关闭错误。
4. 已审查全部生产 diff、新测试和 spec；7 个生产文件（含新增 hook），合计 +259/-109，净 +150 行。没有改动依赖、协议 schema、默认配置、持久化或平台范围。原有 24 个已跟踪非本任务文件的 diff 统计与续接基线一致，未覆盖其内容；未暂存或提交。
5. 真实失败、Node/远端 freshness/完整应用 E2E/生产启动 profile/临时下载清理限制均已记录。后续只有取得生产测量证据后再评估拆包、日志批写等 P3 假设；没有遗留的已确认且可安全实施的重要性能候选。

```powershell
corepack pnpm exec vitest run --config packages/ui/vitest.config.ts --maxWorkers=1 packages/desktop/src/main/taskRealtimeSize.test.ts packages/services/test/botRemoteBridgeLifecycle.test.ts packages/services/test/botRemoteRuntimeServices.test.ts packages/services/test/botRemoteRequestTimers.test.ts packages/services/test/feishuAbortWaitCleanup.test.ts packages/services/test/gitCommandTimeoutCleanup.test.ts packages/services/test/zcodeStorageStartupGate.test.ts packages/services/test/zcodeProtocolClientCompletion.test.ts packages/ui/test/performance packages/rpc/test packages/server/test packages/services/test/terminalShutdown.test.ts packages/services/test/gitCommitPathMembership.test.ts packages/ui/test/conversationProjectionStore.rowSharing.test.ts packages/desktop/src/main/webRemoteControl/servicePipe.test.ts packages/web/src/mobile/protocol.test.ts packages/web/src/mobile/taskConversationLifecycle.test.ts packages/ui/src/hooks/useWorkspaceServicesScope.test.ts packages/ui/src/plugin-ui packages/services/src/gen-ui/adapters packages/shared/src/gen-ui/contract.test.ts
node --test scripts/ci/performance-plugin-disposition-browser.test.mjs
node --test scripts/ci/local-diagnostics.test.mjs scripts/ci/desktop-local-diagnostics.test.mjs
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm architecture:check --changed
```
