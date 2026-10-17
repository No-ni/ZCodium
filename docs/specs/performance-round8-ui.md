# 第八轮 UI 性能：正文预览卡片文件变更匹配

## 产品规则与边界

`useAssistantPreviewCardsForRow` 已按正文、引用和本轮文件变更作 memo；它调用的纯函数 `buildAssistantPreviewCardsFromReferences` 仍会对每个 Markdown/HTML 引用及 localhost HTML URL 重新解析全部 changedFilePaths。候选上限 15 在这些处理之后，无法限制此重复工作。

- 文件变更事实及异步失效继续由原 hook 和服务拥有；本次仅建立调用内的惰性索引，不跨调用缓存，不增加事实 owner、请求、状态或公开接口。
- 沿用原路径清理、相对 cwd 解析、斜杠规范化和大小写敏感比较。exact 匹配保留 changedFilePaths 的首个命中及原返回路径；没有 exact 时，仅裸文件名可按 leaf 回退，且必须恰好一条匹配。重复条目即使指向同一路径，也令 leaf 回退歧义。
- localhost HTML URL 与正文 Markdown/HTML 共用本轮局部索引。没有此类匹配需求时不建立索引；Home、file URL、远控抑制、localhost 优先、候选排序/去重/截断和 Office/PDF 等卡片沿用原路径。
- 输入数组和引用对象不可修改。下一次调用必须使用本次输入，不能复用上次 changedFilePaths 的索引。没有协议、持久化、identity、owner/lease 或 Desktop continuous / mobile replayable 语义变化。

## 验收

1. 32 条 Markdown 引用与 512 条文件变更，以 changedFilePaths 数字属性 getter 计量：匹配阶段每条变更最多读取一次，既有共享候选投影另读一次；总预算 1,024。先证明旧实现超过预算，再实施索引。
2. 保留先 exact 后唯一 leaf、重复 exact 首见、相同路径重复造成 leaf 歧义、目录限定引用拒绝 leaf、大小写、Windows/POSIX 混合分隔符、相对路径、无匹配和新输入重建规则。
3. 对 localhost HTML URL、远控抑制、HTML 与 localhost 优先级、Office/PDF 无需文件变更、候选顺序/去重/15 张截断及冻结输入，用改动前完整输出快照校验兼容性。
4. 执行目标 Vitest 和既有 `assistantFileReferenceRoot.test.ts`；主任务统一根 typecheck/lint/架构。纯计算等价优化没有新增交互或生命周期规则，计量不代表整机延迟收益。

## 实施与验证

- 原实现先运行目标回归：1 失败 / 4 通过，32 引用 × 512 变更的路径属性读取为 16,896 次；同时生成改动前 10 组完整输出的黄金快照。修复后按调用建立局部首见 exact 与唯一 leaf 索引，通过 1,024 次预算；后续 localhost HTML URL 与 Markdown 混合场景也通过同一预算。
- 新增 6 项目标回归与既有相对路径基准测试共 2 文件、11 项通过，黄金快照逐项不变。覆盖重复 exact 首见、重复叶子歧义、目录限定、大小写、新输入重建、冻结输入、Windows/POSIX、Home/file URL、localhost 优先、远控抑制、PDF、去重/排序/15 张截断和惰性索引。
- 架构检查 0 基线 / 0 新增违规，生产源 diff 无 whitespace error。生产改动仅原本 clean 的 `lib/assistantPreviewCards.ts`：新增 36 行、删除 22 行、净增 14 行；新增本规格、目标测试和改动前输出快照。没有新依赖、公开接口或状态 owner。
- 自审核对路径解析仍走原 helper、exact 首见与 leaf 条目计数独立、索引只在实际匹配时创建且只活于本次调用；原共享候选投影、文件变化加载及 stale 处理未改。定点格式和 lint、根 typecheck/lint 由主任务汇总真实结果。

计量描述合成数据的路径数组访问及重复解析边界，没有测量 Electron 整机耗时或实际堆占用。
