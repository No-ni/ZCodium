# 2026-10-31 五轮性能与 bug 扫描

## 目标与执行边界

用户明确要求连续执行五轮扫描、性能优化和 bug 修复。第 1 轮承接已开始的 RPC、客户端、文件与工作区边界扫描；后续根据当前源码和已确认问题选择不同的范围，不以改动数量作为验收目标。

所有改动保留开始时已有的未提交成果。仅修改当前工作树，不提交、推送、触发 Actions、打包或安装。产品身份、`.zcodium`、自有更新源、Windows/macOS 桌面范围及去官方云/遥测边界继续遵循 maintenance spec。

## 所有者与验收方法

- 各问题沿用原模块的状态所有者、接口和依赖方向；不新增第二份已接受队列、持久化事实或跨层写入路径。
- 行为修复先写对应 spec，补能复现问题的回归并确认失败，再做最小修复；注释用中文说明原因。
- 性能优化用结果一致性和稳定的操作数量、扫描次数或分配边界验证；时间测量只作观察，不宣称真机收益或用不稳定阈值挡 CI。
- 远端/异步问题的 spec 写明事件顺序、取消/退休和幂等边界。Desktop continuous 与手机 replayable 继续由同一业务 owner 提供事实。
- 测试使用 `project-test-sandbox.mjs` 与 `source-test-runner.mjs`，只在项目内创建数据、HOME/TEMP/缓存/日志；不访问真实用户数据。
- 使用项目内已有 Node 24.14.0 与 corepack pnpm 10.33.2；最终运行根 typecheck、lint、changed architecture 和相关回归，失败/未执行如实记录。

```text
每轮选择范围 → 当前契约/spec → 可复现缺陷或重复工作证据
             → spec 与失败回归 → 原所有者最小修复 → 执行验证 → 记录结果
五轮完成     → 汇总相关回归 + 类型/Lint/架构门禁 → 最终报告
```

## 轮次记录

| 轮次 | 范围                                           | 状态与结果                                                                                                                                           |
| ---- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | RPC 订阅、客户端连接释放、文件处理、工作区身份 | 已完成并于 2026-11-01 接续复核；SSH IPv6 身份解析与 scratch 点段逃逸修复的 20 + 4 项通过，RPC/client 46 项边界回归通过；本轮没有 RPC/client 实现改动 |
| 2    | 流式工具输入预览                               | 已完成并接续复核；修复嵌套字段外溢、转义字段名、重复字段与悬空转义，48 项通过；560,046 字符夹具整段正则扫描 24 → 0 次                                |
| 3    | 会话增量批量应用与合并                         | 已完成；批量路径不再完整筛选/分配行操作数组，9 项回归通过，500 条增量 `op` 读取 2,500 → 2,002 次；相邻 Store/合并/差分 46 项通过                     |
| 4    | 手机重连、连接换代与订阅释放                   | 已完成；换 socket 前同步作废旧 bridge，43 项协议回归通过；修正真实 smoke 的三个旧产品标题定位器后，Chromium mobile UI + LAN 整条回归通过             |
| 5    | 后台任务控制合并与会话状态投影                 | 已完成；稀疏任务更新保留缺席字段，阻塞 runtime 状态投影先短路，1,000 项历史读取 → 0；5 项回归通过，统一门禁完成                                      |

第 1、2 轮及 RPC/client 回归为原聊天已有成果，本聊天负责复核；接续新增的是第 3—5 轮实现、回归和真实 smoke 定位器修正。开始时其他未提交性能/bug 改动均保留，不计作本轮新增成果。

全五轮任务包共 44 个文件，含 7 个生产源文件；生产源相对当前 main 净增 73 行，其余主要为定点回归和 spec。该统计包含原聊天成果，不作为本聊天独立新增数量。变更模块为 shared、services、web 和 CI 脚本；没有新增状态所有者、跨模块依赖或架构基线豁免。

## 最终验证（2026-11-01）

工具链实际确认：Node 24.14.0，corepack pnpm 10.33.2。Node 测试/类型检查/浏览器 Node 进程使用项目内固定 Node；Corepack 只读复用已缓存版本、关闭网络。测试 HOME、TEMP、APPDATA、业务数据、日志、Vite 缓存与 Chrome profile 均限定在当前项目工作树；44 个任务文件逐项经过 `assertProjectPath` 检查，未触及真实 `.zcodium`。浏览器 profile 的实际路径也由 launch log 证实位于新建项目沙箱。

| 检查                                        | 最终结果                                                                                                                  | 证据                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 11 个 Node 回归入口                         | 内层 132 项全部通过，外层 11 项通过；没有 skipped/cancelled                                                               | `.run-logs/project-only-validation/five-rounds-command-UMYysz/logs/command.log`                     |
| 会话 Store/批量/合并/差分 + 手机协议 Vitest | 89 项全部通过（46 + 43）                                                                                                  | `.run-logs/project-only-validation/five-rounds-vitest-utjgd7/report.json`                           |
| 审计守卫                                    | 9 项通过                                                                                                                  | `.run-logs/project-only-validation/five-rounds-command-rCRxoe/logs/command.log`                     |
| 根 typecheck                                | 通过                                                                                                                      | `.run-logs/project-only-validation/five-rounds-command-cg5ZgL/logs/command.log`                     |
| 根 lint                                     | 0 错误、4 条既有警告                                                                                                      | `.run-logs/project-only-validation/five-rounds-command-kDPDcv/logs/command.log`                     |
| changed architecture                        | violations/baseline/new 均为 0                                                                                            | `.run-logs/project-only-validation/five-rounds-command-k26QbJ/logs/command.log`                     |
| 任务文件格式 + diff whitespace              | 44 个文件格式检查通过，`git diff --check` 通过                                                                            | 项目内 `five-rounds-scope-check.mjs --format-check` 与 Git 检查                                     |
| 真实 Chromium mobile smoke                  | 通过：真实双入口 Web/CSS、LAN endpoint、Channel RPC；流式/分页、配对、重连、草稿、晚 ACK、同 ID 重试、跨目标/远端会话隔离 | `.run-logs/project-only-validation/five-rounds-mobile-e2e-QExbi5/results.json` 与同目录 `evidence/` |

计数去重：132 项 Node 源测试 + 89 项 Vitest = **221 项功能/性能回归**，审计守卫 9 项另计；不把外层 runner 与内层测试重复相加，不把真实 smoke 的多个 PASS 文案当作独立测试计数。

Lint 四条警告与接续开始时相同：`packages/rpc/src/ipc.ts` 两处 set 快照 spread，`packages/ui/test/performanceAssistantWorkRowConversion.test.ts` 两个未使用符号。本任务保留它们，不将 4 警告描述成零警告。

## 失败、修正与限制

- 新后台合并的首版动态 Record 断言在根 TypeScript 检查中触发 TS2352。接续集成改为现有 CLI reducer 同款的 `Object.fromEntries` 非 undefined 字段过滤，避免不安全断言；根 typecheck、lint、相关回归随后重新通过。
- 一次同时运行 Web 测试构建和 Vitest 时，既有纯计时观测项返回 `STACK_TRACE_ERROR`，执行约 5.49 秒，疑似触发默认 5 秒执行期限。停止构建后，保持原配置/断言独立重跑 89 项全部通过；不通过放宽耗时阈值来掩盖同步问题。
- 首次真实 mobile smoke 在返回首页时等待旧标题 `ZCode 远程控制` 超时。当前源码与真实 `home.png` 均是 `ZCodium 远程控制`；修正三处定位器后原 Chromium 场景全通过，未改回旧产品名称。
- 当前项目工具链没有 WebKit 可执行文件，因此 WebKit 明确 skipped；未下载额外浏览器或编码器。没有实体手机、macOS、完整 Electron/真实 Agent 或真实 IPv6 SSH 的验收，不把内存端口、synthetic getter 预算或 Chromium 模拟视口当作这些验收。
- 浏览器验证只临时生成项目内 Web 测试 bundle，使用 `ZCODE_ENV=production`；测试产物用后由受控脚本清理，没有发行构建、打包、安装、备份、提交、推送、PR、issue 或 Actions 触发。

## 既有协议设计欠账

以下边界在原任务/spec 中已经记录。本次没有增加 wire 语义，也不把正常路径回归通过写成它们已修复：

1. `channelServer.listen` 抛错后会清理 server record 并重抛；现有响应类型没有 event 订阅错误帧，客户端如何观察该失败仍需协议决策。见 `bug-scan-rpc-channel-client-boundary.md`；本轮没有真实异步业务入口故障的验证。
2. 显式 `workflowRuns: undefined` 在内存浅合并与省略 undefined 的 JSON wire 之间存在语义边界，既有 coalesce 对照仍保留原行为。见 `performance-round4-conversation.md` 和 `bug-scan-conversation-delta-batch.md`，不擅自引入第三态或新清空协议。

这两项需先按 AGENTS.md 的“发现设计缺陷时先与用户对齐”确定产品/协议规则，再另行实现。
