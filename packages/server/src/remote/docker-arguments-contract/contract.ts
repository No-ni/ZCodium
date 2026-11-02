/** 纯构造显式 Docker 命令参数；实际子进程与连接仍由既有 backend 持有，不下载运行资源。公开调用类型沿当前源码，不另造状态或执行入口。 */
export type ServerDockerArgumentsEntry1 = typeof import("../dockerBackendArgs.js");
export type { ResolvedDockerInfo } from "../dockerBackendArgs.js";
export type { OwnedExecChild } from "../dockerBackendArgs.js";
