/** 现有缓存按真实目录及 workspaceIdentity 隔离；原配置 scope 持有文件监听与代际，不复写 Agent 已接受输入。公开调用类型沿当前源码，不另造状态或执行入口。 */
export type SubagentRuntimeConfigEntry1 = typeof import("../subagentRuntimeConfig.js");
