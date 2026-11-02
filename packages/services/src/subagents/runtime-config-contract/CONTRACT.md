# subagent-runtime-config

现有缓存按真实目录及 workspaceIdentity 隔离；原配置 scope 持有文件监听与代际，不复写 Agent 已接受输入。

实现范围固定在本模块列出的当前源码，不接管其他模块的数据。跨模块调用沿原公开入口；module.ts 的 requires 来自实际 imports。新增或修改行为前按对应产品 spec 更新验收；本次职责登记不改变执行顺序或默认开关。
