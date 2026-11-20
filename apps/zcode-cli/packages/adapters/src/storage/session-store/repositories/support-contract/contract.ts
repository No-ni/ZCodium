/** 调用者提供唯一 SQLite connection；分批复制和删除沿原事务运行，不创建数据库连接或新的删除 owner。 */
export type Entry1 = typeof import("./../message-copy-batches.js");
export type Entry2 = typeof import("./../session-deletion.js");
