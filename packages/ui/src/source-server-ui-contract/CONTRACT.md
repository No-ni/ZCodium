# source-server-ui

Source snapshot、名称/状态发布者、线路选择和窗口意图各复用既有 owner；Controller 只发原命令，投影不持久化连接事实、不触发部署。

实现范围固定在本模块列出的当前源码，不接管其他模块的数据。跨模块调用沿原公开入口；module.ts 的 requires 来自实际 imports。新增或修改行为前按对应产品 spec 更新验收；本次职责登记不改变执行顺序或默认开关。
