# conversation-share-local-context

分享沿当前可信 attachment 读取冻结的会话/工作流/文件；只生成本地导出上下文，不上传，不制造第二个连接或快照 owner。

实现范围固定在本模块列出的当前源码，不接管其他模块的数据。跨模块调用沿原公开入口；module.ts 的 requires 来自实际 imports。新增或修改行为前按对应产品 spec 更新验收；本次职责登记不改变执行顺序或默认开关。
