# CLI Debug 只读展示

App 拥有查询、SSE、视图与数据状态，本模块只消费已读取的 trace/context/cache 数据。甘特图独占 vis-timeline 实例、选择和窗口内全屏；卸载时销毁实例、移除事件并恢复 body overflow。未恢复网络采样或上传。

源码从原 App 原样迁移；纯展示组件和格式化函数作为 App 的唯一展示入口。目录注册只约束新增源码，不刷新历史违规 baseline。
