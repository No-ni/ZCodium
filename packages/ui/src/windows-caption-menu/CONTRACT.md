# windows-caption-menu

Windows 标题菜单通过现有平台 hooks 发命令；更新状态来自原 owner，不恢复官方更新源。

实现范围固定在本模块列出的当前源码，不接管其他模块的数据。跨模块调用沿原公开入口；module.ts 的 requires 来自实际 imports。新增或修改行为前按对应产品 spec 更新验收；本次职责登记不改变执行顺序或默认开关。
