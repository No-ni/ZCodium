# conversation-render-parts

从当前协议 rows、活动和冻结文件根派生渲染/导航；不推断 Host 组织态，不新建 accepted queue，不更改 desktop continuous 或手机 replayable。

实现范围固定在本模块列出的当前源码，不接管其他模块的数据。跨模块调用沿原公开入口；module.ts 的 requires 来自实际 imports。新增或修改行为前按对应产品 spec 更新验收；本次职责登记不改变执行顺序或默认开关。

查找命中帮助函数只追加到 hook 传入的当前 matches/nextCache；缓存与索引引用仍由 useConversationTimelineFind 原 ref/useMemo 持有，不接管滚动、加载历史或高亮生命周期。

`conversationTimelineFindTypes.ts` 只持有现有查找 hook 参数类型，不提供实现或第二份状态。

活动命中的索引读取复用 `getFindMatch` 纯函数；负索引和越界仍返回 null，active key、滚动、高亮和历史加载状态继续由原 hook 持有。

产物头部 WorkflowArtifactHeader 只展示父传入的版本、按钮与作者信息；lease、字节读取、当前版本、复制与导航事件均由原 WorkflowArtifactView 持有。
