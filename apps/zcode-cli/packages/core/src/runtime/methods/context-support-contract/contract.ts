/** 历史公告、模型结果和 Memory 索引继续由 AgentRuntime 持有；辅助函数只接受原输入，压缩重述不改写历史前缀。 */
export type Entry1 = typeof import("./../context-announcement-inputs.js");
export type Entry2 = typeof import("./../context-compact-restatement.js");
export type Entry3 = typeof import("./../context-model-result.js");
export type Entry4 = typeof import("./../project-memory-index.js");
