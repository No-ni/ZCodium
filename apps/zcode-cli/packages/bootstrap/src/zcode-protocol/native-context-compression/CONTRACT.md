# 原生上下文压缩 Bootstrap

对应 `docs/specs/native-context-compression-implementation.md`。本模块只接收意图与只读查询；策略、来源、统计、分支与维护状态由当前会话的 AgentRuntime 持有。

六个 `contextCompression.*` query 经过共享严格参数及结果 schema。宿主沿当前可信 workspace attachment 的同一个 CLI lifecycle 解析 session，复用 record；不另起进程、模型或状态缓存。观察和记录有界分页，迟到页由 Runtime revision fence 与 UI 的 revision/generation/historyVersion 校验拒绝；原文按 token、原图按至多 512 KiB 字节块读取。

`contextCompression.setPolicy` 发送完整配置及 expectedPolicyVersion，沿 CommandInbox 幂等 admission 和 Runtime CAS。`contextCompression.compress` 固定提交时 ModelSelection，维护走 Runtime 的既有前台 FIFO、停止和 lease。Bootstrap 不把维护改写为用户消息或 `/compact`，不保存第二条队列。预热草稿配置必须在 firstInput 前捕获；失败清理 deferred record 并拒绝首发。

桌面 continuous 与手机 replayable 共用同一 Runtime 事件、native revision 和 product projection。snapshot 仅携带小型策略及状态摘要；cold seed 不能覆盖较新的 live 事件或已切换的 record。
