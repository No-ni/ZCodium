# 第五轮性能扫描与 review

## 接续基线

上一轮完成工作区列表分桶、模型轨迹限量映射、flush 无目标回扫过滤、文件树 packed 直达 Worker。最终 148 项 Vitest、4 组 Edge 回归、根 typecheck/lint/架构/格式检查通过。精简记录见 `performance-round4.md`。

本轮开始 main 与 origin/main 同步，架构基线 0、新增 0；之前所有未提交修改必须保留。用户授权扫描、自行修复并 review，最多三个子代理。没有提交、推送、打包或 Actions 授权。

## 方法与边界

按当前源码和调用场景确认新热点，用访问/调用计量与行为回归先复现。先 spec 后代码，保持既有错误、排序、状态所有者与协议边界；不为未经验证的问题增加持久缓存。目标场景先失败后修复，最后统一验证与交叉 review。

Node 24.14.0，pwsh 7，corepack pnpm。UI 与服务按架构上下文阅读。所有会话事实、workspaceIdentity、owner/lease、Desktop continuous/mobile replayable、Windows/macOS 平台边界沿用当前契约。

## 结果

本轮完成五项修复，详细所有者、规则、时序与验收见 `performance-round5-file-search.md`、`performance-round5-ui.md`、`performance-round5-v4.md`、`performance-round5-services.md`。

| 问题                       | 修复与证据                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------- |
| 关闭索引搜索后仍拉取剩余块 | effect 拥有本地 signal，已发请求收口后停止下一块；十块读取中首块取消，块请求 10 → 1 |
| mention 空查询全量排序     | 有界稳定两级分组；20,000 个插件候选类别读取 20,000 → 1,000                          |
| CUA 响应 ID 反复数组去重   | 活动组局部 Set；1,200 个响应数组候选访问 719,400 → 0，改为 1,199 次 Set 查询        |
| /proc 采样瞬时 IO 无界     | 单次最多 8 worker、16 个在途读；200 PID 峰值 400 → 16，失败也等待 sibling 收口      |
| 进程归属深递归溢出         | 显式 DFS 帧；20,000 层链从 RangeError 到完整结果，100 个小图与原算法 owner/顺序一致 |

以上是合成输入的访问/调用计量，不是整机耗时或真实堆字节；Linux 只维护当前公开 reader 的既有分支，未新增 Linux 桌面依赖或构建资源。

## Review 与验证

- 分块取消经独立 review，关闭、卸载、刷新和同 path/service 切换 identity/remoteSessionId 都创建新读取代际，旧块不提交 packed/error，也不继续下一块；正常 IO 错误保留。
- mention 与 CUA 经交叉 review，有限/非有限上限、稳定优先级、原对象引用、重复事件和所有分组边界保持原规则。
- 进程采样主 review 核对有界 worker 的失败收口与同步抛错；该边界增加回归并以 Promise microtask 调用保证 allSettled 等待两次读取。DFS 帧保留原 visited 时机和最近 owner 规则。
- 初次目标 lint 报进程源文件超出行数限制及 new Array 警告；拆出同模块单一路径 IO helper 后解决，没有禁用规则。
- Node 24.14.0 下，全部 performance 测试加 rowSharing/useConversationProjection/sidebarFileTreePath/useWorkspaceServicesScope/workflowHoles/workflowHoleOnlySurfaces，共 **28 文件、195 项通过**。
- `node --test --test-concurrency=1` 执行 performance-browser、performance-find-browser、performance-search-browser、performance-fetch-browser，共 **5 组真实 Edge 回归通过**。之后增加 remoteSessionId 场景，fetch browser 单独重跑仍通过。
- 最终根 `corepack pnpm typecheck`、`corepack pnpm lint`、`corepack pnpm architecture:check --changed`、变更格式检查及 `git diff --check` 通过；Lint 0 warning/error，架构基线 0、新增 0。
- 变更模块仅 ui/services，生产源共 6 文件，新增 105 行、删除 36 行，净增 69 行，包含 34 行同模块 IO helper；其余新增为规格、回归和受控浏览器夹具。
- 开工时已有 110 个未提交路径。本轮只对已有 `useWorkspaceFileSearchIndex.ts` 追加经 review 的取消与作用域依赖，其余原有路径内容保持完整；本轮交接记录更新为最终结果。

## 限制

浏览器使用生产 hook/Worker 与受控 FileService/Host/文档引擎；未启动完整桌面 Agent、真实 CUA 驱动或 Office 排版联调。当前 Windows 环境没有执行真实 Linux /proc 采样。取消只停止尚未发出的 RPC，在途服务端操作仍按既有契约收口。没有长期堆采样或整机性能基准。

本轮未提交、推送、打包或触发 Actions。
