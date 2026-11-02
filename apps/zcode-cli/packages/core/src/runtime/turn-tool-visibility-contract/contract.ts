/** 从当前 turn/runtime 派生可见工具，不复制注册表、不恢复官方命令。公开调用类型沿当前源码，不另造状态或执行入口。 */
export type TurnToolVisibilityEntry1 = typeof import("../methods/turn-tool-visibility.js");
