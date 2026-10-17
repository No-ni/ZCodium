# 第七轮 UI 性能：工作流详情主轨查询

## 规则与边界

`WorkflowRunPhaseList` 每次渲染调用纯函数 `spineSections`。原函数为每个主轨站分别扫描完整 rails 查找上下半轨；顺序工作流有 N 站、N-1 条边时，这两项查询为平方级。生产图和 run 的阶段上限是 32，本轮计量使用该真实上限，不把超界合成模型当成产品规模。

- 状态所有者不变：Runtime/CommandInbox 拥有运行事实，v4 reducer 拥有只读投影；`WorkflowTimelineModel` 仍是卡片、侧栏和详情消费的共同派生输入。
- 单次 `spineSections` 调用建立局部入边、出边索引，只替换主轨的两项查询，不持久化、不跨调用缓存，也不新增第二份模型或可变事实。
- 入边排除 `twin`、`merge`，出边排除 `twin`、`fork`；两者独立保留原数组 `find` 的首个命中，不能按 from/to 的另一端或 kind 合并覆盖。普通、fork、merge 的绘制口径保持不变。
- band/branch 的成员、跨站轨、成对边、曲线、13px 留白、墨色及输出顺序沿用原算法；空模型、断开的站和无对应边仍无半轨。输入及子对象不可修改。
- 相同位置的新模型、新边或新墨色每次重新派生，不能读取上次索引。没有异步时序、协议、workspace identity、owner/lease 或 Desktop continuous / mobile replayable 交付语义变更。

## 验收

1. 冻结 32 个顺序站、31 条轨，用 getter 计数 from/to 读取：旧实现预算失败，新实现端点读取不超过每条轨四次，输出仍为中间站上下半轨、端点仅一侧。
2. 用原算法作参考，与固定种子的多种模型逐项比较完整输出，覆盖重复端点的首见规则、普通/fork/merge/twin 筛选、断边、并行带、没有 join 的末节缩短，以及相同模型新墨色。
3. 输入递归冻结后调用仍成功，结果中的 rails/curves 为独立新数组。
4. 执行目标 Vitest 与既有工作流留白 UI 套件；根 typecheck/lint/架构与定点格式由主任务统一执行。本次为纯绘制派生等价优化，无新增交互规则或 E2E 场景。

## 定点验证

- Node 24.14.0 下，先在未改生产代码时运行目标套件：1 失败、2 通过；32 站顺序模型的端点 getter 读取为 1,054 次，超过 124 次预算。
- 修复后目标 3/3 通过，端点读取为 62 次（每条轨的 from/to 各一次）；34 个空/单站、固定种子混合边及并行带模型的完整输出与原算法一致，包括新模型替换墨色。计量只反映纯函数属性访问，不是整机提速百分比。
- 既有受控工作流留白 UI 入口 `corepack pnpm exec vitest run --config packages/ui/vitest.holes.config.ts`：2 文件、21 项通过，包含详情清单真实 SSR renderer。SSR 不代表完整 Desktop/远端真机联调。
- 生产改动仅 `ui` 模块的 `workflowRunSpine.ts`，无新增接口或状态；增加局部两张首见边索引，其他绘制逻辑保持原路径。
