# 原生上下文压缩 UI

产品规则见 `docs/specs/native-context-compression-implementation.md` 及三个设计 spec。

CLI Runtime 是策略、压缩块、请求观察和维护记录的唯一写者。此模块只读取 workspace attachment 的版本化 query，通过 hooks 访问服务；写操作通过 SessionPane 的既有 command admission。Main、Renderer 与手机均不维护第二份已提交上下文。

UI 的 Zustand store 仅保留未保存参数、未校验 JSON、图表选择。任务 key 使用 workspace identity 与 session；新任务默认使用本机设置权威。关闭、页签切换及两个编辑作用域不丢草稿。版本变化提示冲突，由用户明确重载，不能合并覆盖。默认保存只改变以后创建任务的完整快照。

创建前的精简趋势仍显示空态；没有 Runtime status 时不查询 ledger。任务与默认参数的普通字段、高级折叠区和完整 JSON 使用编辑器自身的唯一可缩正文滚动区，保存状态与按钮位于同级底栏，按实际换行高度占位，不覆盖内容或键盘焦点。两种弹窗复用同一编辑器与草稿 controller。

详情页四个页签保留至少 44px 高度，页签栏完整容纳按钮与内边距，正文不与它重叠。本页 JSON 操作按钮可换行且不超出编辑器宽度，320px 英文也保持完整标签与命中范围。维护停止复用 SessionPane 对 canonical control 的既有 Stop 入口，不从 native phase 派生第二份控制事实。

原文与原图按需查询，引用只追加到未发送 Composer 草稿。页查询与详情响应通过 revision、generation、historyVersion 丢弃迟到结果。未知用量保留 null；趋势不借窗口水位倒推实际输入，不将父任务继承的维护消耗计入子任务。

趋势的当前历史段只读取 Runtime 状态 currentSegmentId（owner compactBoundaryId），不从最后一次主请求推导。compact 后新段可以暂时没有主请求；主线留空，仍读取该段维护/决策并展示新边界事件。只有维护或操作的历史段使用边界标签，不把维护模型标成主模型。

曲线按实际模型、contextWindow、inputBudget、estimatorVersion、generation、segmentId 与 own/inherited 分开。普通追加更新的点级 historyVersion 不断线，policyVersion 只保留参考标记；查询页级 revision/generation/historyVersion 围栏与请求序号保持不变。

工具保护表只呈现 Runtime 对已保存策略和当前 registry 的匹配结果；最多 200 项且显示实际总数。参数草稿不改变此表，新任务默认没有运行态工具集合；缺席和空集合分别说明，手机纵排保持工具名和每条规则可读。
