/** 类型、校验与 Composer 接收/拒绝只消费同一 entry/storage；entries、reconcileInFlight、listener 与持久化仍归 PendingCommandRegistry，不自动重放或新增接受队列。 */
export type Entry1 = typeof import("../pendingCommandRegistryTypes.js");
export type Entry2 = typeof import("../pendingCommandRegistryHelpers.js");
export type Entry3 = typeof import("../pendingCommandComposer.js");
