# 插件生命周期观测（本 fork：本地诊断，去官方埋点）

> 边界：官方上报 SDK、TelemetryCore、专有事件上传、设备归因与 UI 埋点已移除。本 fork 不上报任何 `plugin_lifecycle` / `plugin_discovery` / `plugin_usage` / `plugin_runtime_error` / `agent_step` 业务埋点，也没有官方接收地址。本文只记录当前源码里的本地诊断口径；对外导出仅在用户显式配置自建 OTLP 接收端时发生（见 [DIAGNOSTICS.md](../../DIAGNOSTICS.md)），不回退官方地址。

## 当前实现

- 插件管理服务（`packages/services/src/plugins/pluginManagement.ts`）的 `withPluginTelemetry` 只把入口观测上下文（`entry` / `client_kind` / `trigger`，类型见 `ZCodeAgentPluginMutationTarget.telemetry`，注释标明「仅 Host 观测使用；不会传给 CLI」）附加到变更类 RPC 参数上；本 fork 不读取该上下文做任何对外上报。
- 逐插件同步终态的唯一可观测记录在数据同步弹窗：`createPluginSyncResultReporter`（`packages/ui/src/data-sync/app/marketplacePluginSync.ts`，由 `packages/ui/src/data-sync/ui/DataSyncDialog.tsx` 按目标设备 `remoteKind` 创建）在目标端导入结束后写一条安全本地 debug 日志。

```text
DataSyncDialog ─ 每插件导入结束 ─▶ createPluginSyncResultReporter(remoteKind)
        └─ logger.debug("[data-sync] plugin sync outcome",
             { scope, remoteKind, result, durationMs })
```

## 本地诊断字段边界

逐插件同步终态日志只含固定字段：`scope`（当前为 user）、`remoteKind`（目标设备传输类型）、`result`（固定枚举）与数值 `durationMs`。不记录 pluginId、marketplace、URL、路径、错误原文或任何业务身份；仅本地，不外发。

结果映射沿用 `toPluginSyncLogResult`：created / updated → success，skipped → noop，已停止（`DATA_SYNC_STOPPED_ERROR`）→ cancelled，其余 → failure。inline 插件按批导入，耗时为该批耗时。远端同步以目标端导入完成结果为事实，不用导出代替成功。

## 对外导出（仅用户自建 OTLP）

本地诊断默认不外发。仅当用户同时设置 `ZCODE_DIAGNOSTICS_EXPORT_ENABLED=1` 与 `OTEL_EXPORTER_OTLP_ENDPOINT`（或 `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`）指向自建 HTTP(S) 接收端时，安全本地记录才以标准 OTLP/HTTP JSON 导出；没有默认接收地址，停用开关并重启后不创建导出队列、定时器或网络请求。桌面仅由 Main 持有出口。完整口径见 [DIAGNOSTICS.md](../../DIAGNOSTICS.md)。

## 范围与保留事实

以下插件管理操作仍然存在，但本 fork 不再为它们生成对外的生命周期事件，可排查性由上面的本地同步终态日志和既有安全本地日志承担：

- install、uninstall、update、restore、configure、reset_config、enable、disable、source_add、source_remove、source_refresh。
- 远端同步触发点是数据同步弹窗的插件分类（[数据同步](../remote/data-sync.md)），每个插件一条。
- 取消与进度仍用操作协议已有的 operationId；dryRun 不记录终态；版本只取实际返回记录，缺失时省略。

## 影响与验证

- must-inspect：PluginStorePage → pluginManagementStore → IPluginManagementService → CLI；数据同步弹窗 → marketplacePluginSync → createPluginSyncResultReporter；桌面 Main 诊断出口。
- must-preserve：真实业务结果、scope / 远端身份透传、取消/进度 operationId、列表刷新、本地诊断字段边界（不带 pluginId / marketplace / URL / 错误原文）、无官方上报与无默认 OTLP 地址。
- 测试覆盖：本地同步终态日志的字段白名单与结果映射、批量耗时归属、不发起任何外部端点请求；对 `withPluginTelemetry` 只断言入口上下文透传，不断言上报。
