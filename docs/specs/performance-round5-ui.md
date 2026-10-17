# 第五轮 UI 候选排序性能

## 范围与所有者

`packages/ui/src/mentions/mentionSearch.ts` 是 UI 模块内的纯候选排序/截取函数。候选事实仍由现有 plugins、skills、whiteboards、sessions provider 及其原服务或 store 拥有；本项不改变服务查询、workspaceIdentity、authority、会话冻结目录、请求失效或面板交互。

## 产品规则与边界

- 空白 query 且 `requireQuery` 为 true 时返回空数组。
- 空白 query 的默认排序只有两级：`category === files && data.kind === directory` 的候选排后，其余排前；每级都保持输入次序，返回原候选对象，不修改输入。
- 默认显示上限 1,000；有限 limit 先截断小数、再限制为非负值。非有限 limit 保持原有不截取语义（sessions provider 明确使用正无穷按 workspace 自行限量）。
- 非空 query 的模糊得分、中文连续匹配、稳定次序及 limit 语义保持原实现。
- 空 query 不需要全量建立 `{ index, item, priority }` 包装对象或排序：单次调用内最多暂存 limit 个普通候选与 limit 个目录候选；普通候选已达到上限时后续候选无法进入结果，立即停止读取。没有跨调用缓存或新的状态所有者。

## 验收与证据

1. 20,000 个插件候选、默认 limit 时，对照算法读取 category 20,000 次；新路径只读首 1,000 次，并返回相同的 1,000 个原对象。
2. 混合插件、技能、文件与目录，目录在输入前端或后端，按多种有限/非有限 limit 与原 map-sort-map-slice 算法逐项对照；同优先级稳定次序、重复对象、只含目录与冻结数组均保持原语义。
3. 有限 limit 为零或负值时不读取候选；requireQuery 不变。
4. 非空查询仍覆盖 prefix、substring、英文子序列、中文连续匹配，以及插件描述不进入搜索的边界。

纯算法变化没有新的交互，使用 Vitest 验证，不新增浏览器交互夹具。计量是受控输入的属性访问量和源码分配边界，不等同于整机延迟或堆采样。目标回归先失败后实现；根 typecheck/lint/架构由父任务统一执行。

## 验证记录

- 目标文件 `packages/ui/test/performanceRound5MentionDefaults.test.ts`：第一次执行 3 项失败，其中 1 项是非空查询的既有 description/prefix 得分期望写错；校正断言后，改生产代码前结果为 2 项性能回归失败、2 项兼容性回归通过。修改后 4/4 通过，格式化后复跑仍 4/4。
- 默认上限的受控 20,000 插件候选，category 读取由对照算法 20,000 次降为 1,000 次。目录候选可能仍需要遍历完整输入才能确定普通候选不足，但两级暂存各不超过上限；非有限上限按原契约读取并返回全部候选。
- 只修改原本 clean 的 `mentions/mentionSearch.ts`，其余新增为本规格和上述单测；生产源新增 20 行、删除 8 行、净增 12 行，没有跨包依赖或状态/请求边界变更。
- 三个变更文件 oxfmt 通过，生产 diff whitespace 检查通过。架构开工检查 0/0；本子任务 freshness 重跑遇到 GitHub curl 28 网络连接失败，父任务此前本轮 freshness 已确认 main 同步 origin/main。根 typecheck/lint/最终架构和交叉 review 由父任务汇总。
