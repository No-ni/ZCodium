# desktop-source-settings-bridge

校验窗口事件和 attachment 后转交现有 MessagePort 服务连接；Source 服务身份和释放仍归既有端口 owner。

实现范围固定在本模块列出的当前源码，不接管其他模块的数据。跨模块调用沿原公开入口；module.ts 的 requires 来自实际 imports。新增或修改行为前按对应产品 spec 更新验收；本次职责登记不改变执行顺序或默认开关。
