# pending-command-recovery

类型、校验与 Composer 接收/拒绝只消费同一 entry/storage；entries、reconcileInFlight、listener 与持久化仍归 PendingCommandRegistry，不自动重放或新增接受队列。

范围仅为列出的现有帮助函数与类型；跨模块消费从原公开入口或此类型合同读取。状态不搬迁，运行参数仍由原调用方提供。

Registry 还在同一实例内保留最多 512 个已投递结论，五分钟过期，只包含 commandId、结论与过期时间，不包含正文或附件、不落盘。ACK、查询或同 workspace 的权威投影可先于 Composer 订阅；晚订阅同步收到已发结论。取消订阅只撤销该监听，新的同 ID 命令登记清除旧结论，过期或被容量淘汰后不回放。该通知窗口不成为 accepted 输入权威，不触发查询、重发或恢复正文；scope 的冻结与 stale 判断仍由提交 owner 负责。
