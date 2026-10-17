# 第十三轮性能扫描与本地验证

用户授权直接扫描、修复与本地测试，使用 GPT-6 Luna / max 子代理。当前并行上限为三个子代理，分别检查 services、UI hooks、Desktop Main；主代理检查 server 连接适配器并统一验证。保留开工前所有未提交改动，不提交、推送、构建安装包或启动已安装应用。

## 基线与测试边界

- `node scripts/check-workspace-freshness.mjs` 已执行，但 `git fetch origin --prune` 因 GitHub 连接失败退出，不能确认远端新鲜度；继续基于当前检出离线分析。
- 架构初检通过，violations / baseline / new 均为 0。
- 仓库要求 Node 24.14.0，当前 PATH 为 24.18.0；不安装运行时或依赖，不改变持久环境，最终记录实际使用版本。
- 仅使用合成数据、受控流、mock 服务与独立浏览器 profile。测试不使用用户配置、数据库、真实工作区会话或模型 API，不启动 Agent，不消耗外部模型额度。仅清理本轮创建的资源。

## 修复准入

先确认当前产品调用方和所有权，再更新领域规格、补充失败回归并修复。只接受能够复现的重复工作或资源残留，不从合成操作数推导整机提速比例。不改变业务状态 owner、workspace identity、owner/lease、accepted-input、desktop-continuous 与 web-remote-replayable 契约。

各任务完成后统一执行目标回归、已有相关回归、根 typecheck、lint、架构与格式检查，真实记录失败和环境限制。

## 已确认的 stdio 释放问题

`wrapStdioStream` 在 `connectRemote.beginDisposal` 释放连接后仍保留 stdout data/end 与 stream close 监听，迟到 chunk 继续复制成 Uint8Array。领域规则已先更新到 `rpc-connection-ownership.md`。四条新增回归在旧实现为 3 失败 / 1 通过；修复后四条及原 remote connection 三条共 7/7 通过。

修复仅释放本次包装自己注册的 listener、close 订阅及 emitter，并在发送 EOF 前标记终态，重复 dispose 只 end stdin 一次。100 次包装/释放后每次本 owner 的三个监听均归零，其他 owner 的监听保持；1 MiB 迟到 chunk 的 VSBuffer.wrap 从 1 次降为 0。保留活动字节内容与 EOF/close 原顺序，不替代 backend 的优雅退出。

## 本地验证中间记录

- 当前 Node 为 24.18.0 / corepack pnpm 10.33.2，未找到可直接使用的本地 24.14.0；没有下载或更改运行时。
- 第一轮整合 Vitest 为 63 文件 / 389 项通过，覆盖已有 performance、RPC/server/client、desktop guest/dialog、桌面手机 servicePipe、mobile protocol/lifecycle 与新增 stdio 回归。随后 RPC/server 目标组为 10 文件 / 64 项通过。根 typecheck 和 lint 首检均通过。
- Desktop Main 独立 `tsc --noEmit --project packages/desktop/tsconfig.main.json` 基线为 60 个既有错误。根 typecheck 未包含此工程，因此独立记录，并在本轮 Desktop 源码完成后比较新增诊断。
- `browser-without-payment.test.mjs` 1/1 通过。原浏览器批次在前两个 performance-browser 场景约 43 / 46 秒失败后中止，未获得其完整失败栈；没有把中止批次记为通过。独立简化探测可复现非 persistent Edge 的 page.goto 15 秒超时。不能据此确认产品缺陷或归因于某个源码修改。
- 采用随机 loopback 端口、独立 Vite cache 和临时 persistent Edge profile 的 `performance-round12-subagents-browser.test.mjs` 单跑 1/1 通过，卸载后的两种分页场景均为 0 次后续 RPC。
- 简化探测的临时浏览器、临时目录和 Vite server 由 finally 关闭。另一次 HTTP 探测在仓库生成 `node_modules/.vite/performance-round13-probe`；该确切路径已校验，但自动审批两次拦截 Remove-Item 清理（仅返回 blocked by policy，无具体原因），因此保留并如实记录。没有停止或清理其他 owner 的进程与目录。

## 修复结果

| 位置                       | 已确认问题与受控改善                                                              | 兼容边界                                                                   |
| -------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| server `wrapStdioStream`   | 释放后残留三个监听，1 MiB 迟到 chunk 仍复制；释放后监听归零、迟到复制归零         | 仅释放本 owner，原 EOF / backend 等待顺序保留                              |
| services `discoverSkills`  | 同次扫描每个用户 ZCode 正文读取 2 次，现为 1 次；两次扫描累计 4 次变为 2 次       | 无跨请求缓存，第二次反映磁盘编辑；Agents 原名称识别与优先级保持            |
| UI `useSettings`           | 同 service/platform 的三个消费者注册数从 3 降为 1，每次事件只执行一次对应原生回调 | 复用原 SettingsStore 持有引用计数，末位卸载释放；快照与单飞读取 owner 不变 |
| Desktop `applicationIcons` | 不同有效 locator 的结果长期累积，129 个输入留下 129 项                            | 总容量目标 128，仅淘汰 settled 项；pending 去重并允许暂时超限，完成后收敛  |

四项均先更新规格、在旧代码确认失败回归，再实现。services 新增四项回归在旧实现为 3 失败 / 1 通过，最终 4/4 通过，覆盖新请求读盘、名称冲突、无效 frontmatter、受控读失败与嵌套根过滤。未将 Agents 原先必要的名称读取误记成此次消除的工作。

最终整合 Vitest 为 **64 文件 / 393 项通过**，根 typecheck 通过。该批次包含本轮八条新增 Vitest 回归（stdio 四条、skills 四条）及此前相关性能与连接矩阵。各子代理继续只读交叉 review：services 检查 stdio 与设置订阅，另两名检查其他修复；不在 review 时回滚生产代码做旧版对照。

## 最终检查与交付边界

| 检查                                            | 真实结果                                                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 根 `corepack pnpm typecheck`                    | 通过                                                                                                             |
| 根 `corepack pnpm lint`                         | 通过，3036 文件，0 warning / 0 error；过程中的一条测试夹具 spread warning 已修复                                 |
| `corepack pnpm architecture:check --changed`    | 通过，violations 0 / baseline 0 / new 0，没有更新 baseline                                                       |
| 整合 Vitest                                     | 64 文件 / 393 项通过                                                                                             |
| `application-icon-cache.test.mjs`               | 5/5 通过，fake Electron；涵盖真实入口 129→128、命中/LRU、乱序完成、pending 去重与失败重试                        |
| `performance-round13-settings-browser.test.mjs` | 1/1 通过；HTTP 200，无 pageerror，所有请求为 loopback；覆盖多消费者、服务与平台隔离、末位卸载、重挂和 StrictMode |
| 既有隔离浏览器与 browser-without-payment        | 分别 1/1 与 1/1 通过；原浏览器批次的两个失败及中止仍保留上文记录                                                 |
| Desktop Main 独立类型检查                       | 未通过；按文件、错误码、完整消息做多重集比较，忽略改动造成的行列位移：基线 60 / 最终 60，新增 0、移除 0          |
| 定点格式与 diff 空白检查                        | 本轮 15 个文件格式通过；工作区 diff 无空白错误                                                                   |

三个子代理的只读交叉审查均未发现新增可操作问题。主代理复核了服务名称过滤的读取预算与根顺序、设置订阅的单一 owner 和清理边界，以及缓存乱序完成的 LRU 语义；删除了没有实际调用证据的额外 deferred-dispose 状态，未增加公共测试 API 或新的缓存清空接口。

本轮生产代码只涉及 desktop、server、services、ui 四个模块的四个原有文件，新增 179 行、删除 21 行，净增 158 行。另有五份新增/更新规格和六份测试/浏览器夹具文件。没有新增生产依赖、协议字段、持久化业务状态或后台计时器。

所有结果均为受控输入上的工作量、资源边界和兼容性验证；没有运行已安装 ZCodium 或完整 Electron 长会话采样，因此不声称总体 CPU、内存或响应速度提升百分比。本轮未打安装包、下载 artifact、触发 Actions、提交、推送、启动真实 Agent 或调用 ZCodium 的模型/付费 API，未改用户配置与持久运行时环境；保留开工前所有其他未提交改动。仅上述被自动审批拦截清理的仓库内探测缓存保留。
