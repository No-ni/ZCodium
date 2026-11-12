# 原生上下文压缩 Runtime

AgentRuntime 的实例拥有策略、来源、内核候选和请求观察；SessionStore 只原子保存该实例的事实，UI 只通过 query 读取小摘要与有界分页。完整契约见本仓 `docs/specs/native-context-compression-implementation.md`。

每次维护先冻结 historyVersion/generation/policyVersion，再发模型请求；等待期间不持写锁。提交时重新验证三者、停止信号、完整 canonical 分组和净收益。候选失败不改写已提交块，已经发生的模型用量仍保存。策略完整保存用 policyVersion CAS，存储写入用 revision/branchGeneration CAS。

维护的 cancellation 与开始时间属于同一个 native owner；可选 activeMaintenance 只投影它与既有 activeForegroundExecution 的当前 id。preparing 入队不视为运行，finally 与同实例 cancellation 一起释放瞬态证据；不把执行 id 写入持久操作、fork 或冷恢复记录。现有 Stop 用该 id 取消同一 Runtime 命令，迟到 id 不匹配时拒绝。

付费维护在 FIFO admission 和每次 decision/summary 真正发请求前读取 SessionStore 的既有 Goal owner。paused/budget_limited 拒绝新的付费维护，排队后暂停也不能绕过；不恢复 Goal，不创建用户消息、Goal run 或 activeInputId。自动安全点被门禁挡下时不消费 lastCheckedHistoryVersion，恢复 Goal 后同一历史仍可按原规则检查。已确认无 Goal 可以继续；Goal 读取失败不可当作无 Goal 执行付费请求。

真正调用前冻结 targetID。通用 recordModelUsageFact 的 onModelUsage 回调交付同一份归一化逐 requestId/attempt 与 rawUsage，维护仅在这个出口调用 accountTargetUsage，以 record.id 为可选 usageID。主轮次 events/TurnResult 不混入维护用量。已知 input/output 或 Provider total 按既有 ModelUsage 口径结算；完全未知不产生零费用 receipt，真实零仍有 receipt。暂停、取消、策略作废和候选提交失败不抹掉已启动请求的已知费用；清 Goal 或替换后旧请求不归到新 targetID。

SessionStore receipt 与 Goal 计数同事务，重复物理键不会重复付费，model_usage 裁剪不会删除 receipt。计数仍由 accountSessionTargetUsage 唯一写入，原生状态/候选和 Renderer 不持计费状态。模型账本写失败仍调用 Goal 回调；Goal 计费失败遵守既有 owner 的稳定告警与隔离契约，不把已完成模型响应改成失败，事务失败不留下阻止重试的 receipt。

只改变 provider 请求副本，原始 RuntimeMessageEntry/canonical part 不被修改。原文和原图引用只能解到当前会话持有的来源。成功响应完整保存后才产生图片 receipt；fork/rewind 只保留完整边界内的成员，compactBoundaryId 与分支 generation 分开。

主请求的 operationIds 来自实际插入的有效摘要块、实际改变内容的工具视图及一次性 pending 操作。块/视图与生产操作的关系保存在 kernel，与转换和 completed 操作在同一 CAS 提交；首次请求消费 pending 后，后续继续发送同一转换仍保留该关系，不关联未发送或被替代的块，不重新计费或改写冻结数字。缺少旧关系时不按正文或时间猜补；已存在但格式非法的关系以 invalid-state 拒绝，不当作旧态缺失。冷恢复复用持久关系；回退裁掉失效成员与操作，compact 清除转换关系，fork 将完整边界内的操作关系重映射到子任务 inherited ID，与原 fork bundle 原子提交。去重后的请求关联沿用 100 项上限；pending 只承担一次性事件。

原图回取的发送豁免只属于真实工具结果所在的 canonical 用户轮；用 distinct real-user 边界校验，synthetic carrier 不算新轮。同轮失败/取消/CAS 失败仍可按原字节重试，后续真实输入不继承旧轮豁免。旧 ToolPart、原图、回取记录和已提交 receipt 保留，不通过删除历史或请求准备阶段消费 intent 恢复可用性。

NativeContextStatus.currentSegmentId 必须直接投影当前 state.compactBoundaryId；深度 compact 提交与事件发布后，即使 lastObservation 仍是上一段主请求，也返回新边界。初始化/恢复/分叉继续复用该状态 owner，不建立独立趋势段状态。

historyVersion 反映当前 Runtime 的完整输入历史，包含 ContextBuilder 的系统前缀、canonical 消息与实际 shell 环境提示；普通追加或恢复时的输入环境变化也会改变它。原文身份与来源归属仍按 canonical 消息和 part 校验。该版本用于查询迟到围栏和维护提交校验，不作为可比较曲线的边界。观察冻结的实际模型、contextWindow/inputBudget、estimatorVersion、generation 与 compact segmentId 才描述输入曲线边界。

桌面 continuous 和手机 replayable 共用同一个 Runtime、事件 revision 与既有 attachment。snapshot 不承载原图、来源原文、完整内核或任意文件路径。原图 RPC 每页最多 512KiB decoded，记录详情和原文也有界。
