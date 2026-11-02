# pending-command-recovery

类型、校验与 Composer 接收/拒绝只消费同一 entry/storage；entries、reconcileInFlight、listener 与持久化仍归 PendingCommandRegistry，不自动重放或新增接受队列。

范围仅为列出的现有帮助函数与类型；跨模块消费从原公开入口或此类型合同读取。状态不搬迁，运行参数仍由原调用方提供。
