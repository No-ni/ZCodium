# W89失败的独立归因

审查日期：2026-11-07（北京时间），只读源码与已经完成的core-retry证据；没有运行新UI、发送模型请求或修改产品。

- 原始case时间 `2026-11-06T16:02:58.760Z`，错误“删除模型应显示删除成功而非保存成功”，stack停于 `provider-settings-write-recovery.test.ts:112`。
- 该test按顺序先完成第106–110行等待personalModelIds不再含模型，第111行断言models.getExact为undefined。失败发生在后续横幅断言，不能把它倒推为删除写入失败。
- `InlineEditableProviderCard.tsx`（当前路径 `packages/ui/src/settings/model-provider-section/`）第293–299行按operation delete选择modelDeleting/modelDeleteFailure；第319–323行await operation后dismissFeedback，注释明确成功由列表/输入值/弹窗状态体现，不堆叠横幅。
- 第663–677行handleDeleteModel调用onDeletePersonalModel并传operation delete，没有错用保存操作。locale zh-CN:3567/en-US:3813的modelDeleteSuccess键仍残留，rg全UI仅匹配这两个定义，不是该路径的实际反馈。
- 已执行读取：`Get-Content provider-settings-write-recovery.test.ts`、`Get-Content InlineEditableProviderCard.tsx`、`rg -n 'modelDeleteSuccess|modelDeleting|modelDeleteFailure' packages/ui/src`、读取core-retry NDJSON失败及0-18原始log删除时段。没有复跑后的通过结果。

结论：QA成功横幅合同漂移。最小复验为保持既有Repo断言并检查对应模型行/删除pending反馈消失；不要求产品增加成功toast。
