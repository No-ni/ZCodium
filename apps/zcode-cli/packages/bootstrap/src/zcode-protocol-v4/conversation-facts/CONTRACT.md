# cli-conversation-facts

定义既有 canonical fact 类型与 stream/attachment/origin 纯转换。原 event-normalizer
继续分派原 SessionEvent，ProductProjection 持有 product turn/open segment 与 row 状态。

- 不持有 map/cache/session、不给事件排序或创建实体，不执行 IO。
- ID、visibility、origin、placement、diagnostics、附件与 stream lane 保持原规则。
- 原 context 只供转换读取；live、cold 与 replayable 仍使用同一入口解释身份。
- 只依赖 SDK/shared 公开值；Gen UI/Core 适配保留在原入口，不放入本模块。
- 原 event-normalizer 类型路径兼容再导出；不增加 package exports 或第二个 reducer。
