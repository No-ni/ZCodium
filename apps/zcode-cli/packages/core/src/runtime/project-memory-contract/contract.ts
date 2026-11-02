/** 缓存及待更新事实仍归原 AgentRuntime；辅助函数消费同一 runtime，取消和迟到结果保持既有代际规则。公开调用类型沿当前源码，不另造状态或执行入口。 */
export type ProjectMemoryRuntimeEntry1 = typeof import("../helpers/project-memory-dream.js");
export type { ProjectMemoryUpdate } from "../helpers/project-memory-dream.js";
export type ProjectMemoryRuntimeEntry2 = typeof import("../helpers/project-memory-recall.js");
export type { ProjectMemoryRecallPrefetch } from "../helpers/project-memory-recall.js";
