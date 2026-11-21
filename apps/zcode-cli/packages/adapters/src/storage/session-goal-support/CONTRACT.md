# CLI 目标存储辅助

辅助原 session-target.ts 的 row 读取、解码、session 时间更新和 ID/耗时计算。模块只
操作传入的 db.sqlite 连接；SqliteSessionStore 仍是连接 owner，原目标 helper 仍执行
目标状态、run、预算、fork、summary 和 clear 的写入。

- 不新建连接、缓存、计时器或第二份目标事实；不读写 Host tasks-index。
- row 字段、状态字面量、缺席时 null、写后 must-read 异常及 session 时间 max 更新保持。
- ID 的 Date.now/randomUUID 与 ceil 耗时沿用原实现，调用时机由原调用方决定。
- 旧 readSessionTarget 路径保留；辅助出口只供现有 CLI adapter 使用，不新增 package exports。
- Root goal/run 的 CAS 与事件顺序保持；辅助不决定 admission、pause、重启或 fork 完成态。
