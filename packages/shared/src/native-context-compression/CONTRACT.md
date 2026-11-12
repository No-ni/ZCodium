# 原生上下文压缩共享契约

本模块只定义纯参数 schema、配置/策略 DTO、数值观察与会话持久化 DTO，不执行模型、文件、网络或迁移操作。当前任务的唯一写者为 AgentRuntime；新任务默认沿既有配置服务保存；界面只编辑未提交草稿。实现规则见 [实施契约](../../../../docs/specs/native-context-compression-implementation.md) 与 [参数目录](../../../../docs/specs/native-context-compression-parameters.md)。

完整参数必须通过同一个 strict schema。叶节点的元数据同时生成 90 项表单描述和推荐值；阈值与模型选择分别作为单个语义字段。JSON 导出只含 schemaVersion、mode、parameters；policyVersion 只属于任务策略，不允许混入配置。缺字段、未知字段、未知简化策略、非法列表与组合依赖均拒绝；关闭子功能仍保留并校验其完整参数。

百分数按 0–100 表示，token、字符、轮、像素、KiB、MiB 不互换。同单位的触发/目标/容量关系在 schema 中检查；混单位阈值、实际保护区、模型模态/输出与图片硬预算必须由 Runtime 在当前 ModelPort 下检查。合法 JSON 不能代替运行态可用性检查。

工具模式仅允许名称或非空名称前缀后的一个末尾 `*`；模式列表有界、无重复、无空白。保留近期工具列表从提前整理列表中做减法，重叠不构成非法配置；硬保护始终由 Runtime 保留。图片 PNG 与 alpha 策略分别显式选择，flatten 使用配置中的 RGB 底色，主题不能改变它。

推荐值创建及路径工具均不保存配置；setter 返回新草稿，非法组合只在完整保存时拒绝，不静默开启依赖或调整其它字段。观察/持久化 DTO 的事实与事件顺序由 Runtime 和 SessionStore 契约负责，UI 不广播原文或完整内核状态。

状态可带 `resolvedToolProtection`：Runtime 对当前工具集合与已保存策略的匹配结果，最多 200 项并提供实际总数；完整工具名最多 512 字符，未知集合用字段缺席而不是空表。该结果不属于可导入配置，不持久为第二份策略，UI 不重新匹配参数草稿。

状态可带严格的瞬态 `activeMaintenance={foregroundExecutionId,startedAt}`，仅 compressing 时有效，由 Runtime 的实际在途执行投影；没有字段不代表可以猜测执行目标。它不属于配置或持久操作。canonical control 使用 `nativeContextCompression` work/stopTargetKind，通过已有 Stop 命令承接取消；终态和冷记录不保留该执行证据。
