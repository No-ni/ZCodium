/** 只配置已有桌面 E2E runner；测试数据及子进程写入当前项目隔离根，不装配官方账号与云回放。公开调用类型沿当前源码，不另造状态或执行入口。 */
export type DesktopTestConfigEntry1 = typeof import("../../wdio.conf.js");
