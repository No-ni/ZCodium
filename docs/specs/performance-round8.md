# 第八轮性能扫描与修复

## 基线与范围

保留开工前全部未提交性能优化和手机远控修改。freshness 确认 main 与 origin/main 同步，架构初检 baseline 0/new 0。使用 pwsh 7、mise.toml 指定的 Node 24.14.0 和 corepack pnpm 10.33.2；默认 shell 的 Node 24.18.0 未用于最终验证。

用户授权扫描后自行修复，使用两名子代理分别处理 UI 与 services，主代理处理 RPC、汇总验证及 review。优先处理能用回归证明的重复工作、未释放请求和深链失败，逐项先 spec 与旧实现回归，再改生产代码。各领域规则与所有者/事件图见 `performance-round8-ui.md`、`performance-round8-services.md`、`performance-round8-rpc.md`。

## 修复与证据

| 问题                                       | 原实现证据                                                                 | 修复后行为                                                                                                |
| ------------------------------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 预览卡片逐引用解析整个变更文件表           | 32 引用、512 路径，属性读取 16,896 次；旧实现 1 项预算失败                 | 调用内惰性首见 exact/唯一 leaf 索引，通过 1,024 次预算；10 组旧输出快照一致                               |
| 同步/异步进程快照递归 DFS                  | 活 root/退出 root 共 4 项 20,000 深链场景 RangeError                       | 同模块单一显式帧遍历；DFS 顺序、首次 PID 去重、循环、PGID 和创建时间过滤不变                              |
| RPC 等待请求超时、取消和 dispose 不出队    | 初始 7 项回归中 6 项失败；晚注册仍执行过期调用/订阅，批量超时保留 payload  | 同一等待表按通道/id 保存，终结立即移除参数和 timer；晚注册仅派发有效请求                                  |
| RPC 活动登记晚于可重入业务回调             | 独立 review 实测 call/订阅同步 dispose 后活动表均残留 1 项；4 项补测先失败 | 调用前登记；终结先从 owner 表移除；迟到订阅句柄立即释放一次，终结后事件不再转发                           |
| CancellationTokenSource 的取消标志恒 false | 取消回归 3 项中 2 项失败，cancel 后缓存/新 token 都报告 false              | 只读 getter 读取 source 唯一状态；预先取消的真实 ChannelClient 调用直接拒绝，不等待 Initialize 或发送请求 |

没有新增公共接口、依赖、协议字段、业务事实 owner 或持久缓存。Desktop continuous/mobile replayable、workspace identity、lease 和 CommandInbox 准入继续沿用原路径。生产改动共 rpc/services/ui 三模块、六文件，新增 137 行、删除 102 行，净增 35 行；这些文件在开工时均没有本地修改，因此此处只统计本轮。

## Review

主代理复核 UI 的首见 exact、重复同路径造成 leaf 歧义、惰性创建与每调用重建，以及 services 显式帧与递归顺序的对应。UI 子代理独立只读复核 services，未发现新增可操作问题。

services 子代理发现并复现 RPC 活动登记重入泄漏，主代理纳入规格、先补红测后修复；追加回归又暴露取消标志静态 false，一并按唯一状态所有者修复。最终 services 子代理再次复核 RPC 的等待终结、先登记活动、迟到订阅释放、先出 owner 表后 dispose 和 token getter，并独立运行 RPC 两文件 17/17 通过，未发现新增问题。

## 验证

- 本轮四个新测试文件共 32 项通过：UI 6、进程快照 9、RPC 等待/活动生命周期 13、取消标志 4。旧实现的失败均在生产改动前确认；正常行为通过参考算法、旧输出快照或真实 ChannelClient 验证。
- 全部 performance 回归、row sharing、路径解析、mobile protocol/lifecycle/window sync、shared raw RPC transport 共 37 个独立文件、272 项通过。统一运行时为 271 项，随后新增的预取消客户端场景与最终两个 RPC 文件复跑通过；重复不重复计数。
- 另运行真实 Host/手机 servicePipe 和客户端 sampling 两文件 10 项、既有 workflow holes 两文件 21 项，均通过。与上项合计 **41 个独立文件、303 项 Vitest 通过**。
- 既有四个 performance 浏览器入口串行运行，5 组真实 Edge 场景通过：搜索代际/目录虚拟化/局部时钟/懒加载、DOCX 迟到完成、文件索引取消与身份切换、会话查找、真实 Worker 文件树搜索。
- 最终根 `corepack pnpm typecheck`、`corepack pnpm lint` 通过；Lint 0 warning/error。`architecture:check --changed` baseline 0/new 0。修改文件定点格式检查和 `git diff --check` 通过；Git 的 LF→CRLF 提示不是 whitespace error。

## 计量限制

预览路径访问是合成工作量计量，20,000 层进程链是鲁棒性压力场景；不将它们换算为整机提速比例。等待表与计时器释放由生命周期断言验证，没有进行长期堆采样。进程测试使用受控进程表，没有启动 20,000 个实际进程；浏览器使用受控服务夹具，未运行完整 Electron/Agent 长期会话或真实手机联调。

本轮没有提交、推送、打包或触发 Actions。
