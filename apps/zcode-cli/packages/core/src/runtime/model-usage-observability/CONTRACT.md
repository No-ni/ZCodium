# 模型用量归属

Runtime 在模型调用结束后只通过此模块保存通用模型、turn 和工具用量事实；SessionStore 仍是持久化 owner。

真实 Provider requestId 与 attempt-1 形成唯一模型账本键。失败重试、stream/HTTP fallback 保留各次明确用量，重复同尝试终态只结算一次，不增加 aggregate 行。只有最后对应的成功尝试可补用调用 result；没有报告的字段不补零。完全没有网络身份的旧 Model 保留原逻辑调用入口。

原生上下文 tracker 复用公开身份函数，不另写模型账本。无终态的最后尝试保留本次实际结束时间和流式窗口；取消 retry backoff 不建立未启动尝试。写入失败隔离到当前事实，只输出稳定技术诊断，不输出原始错误内容。

recordModelUsageFact 可接受 onModelUsage(record) 回调，逐次交付与账本相同的完整归一化 ModelUsageRecord 和真实 rawUsage，不重新提取、合并或增加 aggregate。账本持久化与回调分别隔离；一条账本写入失败仍交付该条回调，回调失败不阻止后续尝试或使已完成调用变失败。原生维护用它交给既有 Goal owner，按冻结 targetID 与 record.id 的持久 receipt 去重；主轮次 accounting 继续只消费主轮次事件，不从这个回调再计一次主轮次。
