# 未完成 SDK step 的数字用量

`mergePartialStreamUsage` 由 adapters 的 stream diagnostics 在真实 SDK raw chunk 被消费后调用。它是纯解析入口，不执行 IO、不保存会话、不记 Goal/费用，也不发送 raw body。现有 `recordModelUsageFact` 及既有 Goal 单写者继续负责唯一记账。

按当前 resolved providerKind 读取 Anthropic message_start/message_delta、Google usageMetadata、OpenAI chat/Responses（含 compatible）各自的真实用量字段；不根据字段相似性猜 Provider。只保存有限白名单里的非负安全整数。缺失或 null 保持未知，真实零保留；没报告 total 就不补 total。累计更新覆盖当前 step 的已报告字段，不逐帧相加；缺失字段保留同 step 先前事实。

stream diagnostics 每个 start-step 清当前暂存值；finish-step 的完整 SDK usage 替换该 step 暂存值。若取消、断流或失败先于 finish-step，既有失败出口聚合已完成 steps 与当前部分事实；任一步未知的字段不会因其它步已知而变成完整合计。下一物理 attempt 从新的 diagnostics 开始，不继承旧 attempt 数字。

原生维护、main 与 compact 共用这条 adapter 事实出口。`preserveProviderStreamBoundaries` 仍只裁决 compact retry/可见边界；读取本地 raw 数字不扩大 Core/UI 正文协议，不改变 stop owner 或重试次数。真实 SDK 内存 SSE 回归见 `test/model-partial-usage.test.ts`。
