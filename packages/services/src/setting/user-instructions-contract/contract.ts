/** 用户指令按现有 .zcodium 路径显式读写，统一 100KB 校验；不读取官方账号，不创建第二份设置状态。公开调用类型沿当前源码，不另造状态或执行入口。 */
export type UserInstructionsEntry1 = typeof import("../../../../shared/src/userInstructions.js");
export type UserInstructionsEntry2 = typeof import("../userInstructionsPersistence.js");
