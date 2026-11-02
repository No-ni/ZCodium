# project-memory-runtime

缓存及待更新事实仍归原 AgentRuntime；辅助函数消费同一 runtime，取消和迟到结果保持既有代际规则。

实现范围固定在本模块列出的当前源码，不接管其他模块的数据。跨模块调用沿原公开入口；module.ts 的 requires 来自实际 imports。新增或修改行为前按对应产品 spec 更新验收；本次职责登记不改变执行顺序或默认开关。
