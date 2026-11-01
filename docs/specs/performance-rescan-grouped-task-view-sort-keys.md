# 复扫 UI 派生计算：grouped 任务视图排序 key 的调用内预计算

## 规则、所有者与边界

`buildGroupedTaskViewFromSessions`（`packages/ui/src/lib/buildGroupedTaskViewFromSessions.ts`）是 grouped 侧栏的纯派生投影：输入分组结构、tasks-index 持久行与 sessions-index 实时详情，输出与旧 `listGroupedTaskView` 同形的节点视图。它不持有状态、不做 IO；视图状态仍由 `useGroupedTaskView` 唯一拥有，本修复只改函数内部的排序 key 计算，不新增 store 状态、跨调用缓存、公开入口、异步流程或第二条事实来源。

- `useGroupedTaskView` 的 effect 以 `sessionsIndexItems` 为依赖：sessions-index 每个内容帧都会重跑一次全量 join 与三处排序（RPC 由单飞缓存短路，CPU 不短路）。排序 key 的重复构造按帧累计。
- 组成员排序 `sortGroupTasks` 与顶层节点排序（`missingNodes.sort`、`nodes.sort(compareGroupedNodes)`）的可见性契约不变：组成员序 = 成员 `sortOrder`，缺失按 `addedAt` 降序 +`key` 升序在 `max(sortOrder, 0)` 后按 `GROUPED_TASK_ORDER_STEP` 补序；顶层序 = `topLevelOrders`，缺失按 `createdAt` 降序 + `nodeMapKey` 升序在 `max(topLevelOrders.sortOrder, 0)` 后补序；末次统一按 `sortOrder`（`?? 0`）决胜 `nodeMapKey`。
- 输入行对象、structure、members、topLevelOrders 均不被修改；每次调用都从当次输入重新派生。

## 已确认问题

三处排序在比较器内重复构造派生 key：

- `sortGroupTasks` 末次排序（L84-91）：每次比较调用 2 次 `taskKeyOf`（`sortOrder` 打平时再 2 次 `localeCompare` 决胜），而首轮循环（L63-72）已为每项算过同一把 key。`taskKeyOf` = `buildTaskWorkspaceKey`（`workspaceIdentity?.trim() || workspacePath`）+ 模板拼接。
- `missingNodes.sort`（L174-183）与 `compareGroupedNodes`（L43-53，用于 L193 的 `nodes.sort`）：`createdAt`/`sortOrder` 打平时每次比较构造 2 个 `nodeMapKey`；task 节点的 `nodeMapKey` 走 `taskOrderMapKey`（含 `JSON.stringify`），而创建 task 节点时（L165）本已为 `topOrderByMapKey` 查询算过同一把 key。

实测（真实生产函数，workspacePath/workspaceIdentity 计数 getter，单 group、`sessions: []`；每次 key 构造读 2 个属性，故 key 构造次数 = 读取次数 / 2）：

| 输入规模与分布                 | 实测 key 构造 | 其中结构性（merge join + active 桶 + 首轮，修复后下限） | 比较器占比                |
| ------------------------------ | ------------- | ------------------------------------------------------- | ------------------------- |
| n=512，sortOrder 已有序 / 逆序 | 2,558         | 1,536                                                   | 1,022（511 次比较 × 2）   |
| n=512，sortOrder 种子随机      | 9,448         | 1,536                                                   | 7,912（3,956 次比较 × 2） |
| n=512，sortOrder 全部打平      | 5,712         | 1,536                                                   | 4,176（1,044 次比较 × 4） |

交叉校验：由实测读取数反推的比较次数与冻结 oracle 比较器的调用次数逐场景相等（511 / 3,956 / 1,044），且真实模块输出顺序与 oracle 逐项一致。操作计数是合成输入的工作量指标，不能换算成整机提速比例；本修复不声称运行时或物理分配收益。

## 修复方案（唯一所有者不变）

- `sortGroupTasks`：首轮只记录 `{ task, key }`（成员/缺序分类与 `maxOrder` 仍在首轮完成）；`missing` 补序全部写完后，末次排序以 decorate-sort-undecorate 复用首轮 key，order 在比较时从最终 Map 解析（`?? 0`）。成员 order 不得在首轮快照——重复 key 仍以 Map 最后写入为准（缺序补写会覆盖同 key 的成员序），不去重。
- 顶层：创建 task 节点时已算的 `taskOrderMapKey` 存入调用内 `Map<node, key>`，供 `missingNodes.sort` 与 `nodes.sort` 的决胜查询复用；group 节点不预计算，只在打平时走原 `nodeMapKey` 模板（无打平时不退化）。
- 逐位保留：`localeCompare` 决胜、稳定排序（同一输入序列 + 同一比较器）、`max` 初始 0 与负序、`?? 0` 回退、`if (leftOrder !== rightOrder) return leftOrder - rightOrder` 分支（不用 `差值 || locale` 捷径，避免改变 NaN 等输入语义）、`workspaceIdentity.trim() || workspacePath` 口径。
- 无跨调用缓存、无新 store/hook/RPC、无协议与持久化变化；纯计算等价优化不改变交互、布局与 `DESIGN.md` 任何渲染规则。

## 验收

1. 先新增回归 `packages/ui/test/performanceGroupedTaskViewSortKeys.test.ts`：以 `packages/ui/test/fixtures/performance-grouped-sort-baseline/` 冻结的改动前源码为 oracle（内存装载，依赖注入真实的 `taskQueryCache` 与 `buildTaskListResultFromSessions`），覆盖全函数输出等价（结构化边界 + seeded 随机差分，含 sessions enrich、pinned/archived/deleted、重复成员/键、混合重复键、无序补序、空/单项、同路径不同 identity、负序、顶层打平、missingNodes 打平）、输入不可变（深冻结）、task 引用保持、fixture 哈希与 manifest 一致，以及调用内 key 构造预算（真实生产函数 + 计数 getter）。
2. 预算口径：修复前在预算输入上超预算失败（红），修复后通过（绿）；预算按 `4 × (组成员数 + 顶层 task 数) + 64` 次 key 构造设定，锁住「比较器不再重复构造」这一量级。
3. 专用入口 `scripts/ci/ui-grouped-task-sort-keys-regression.test.mjs`：沿用既有 UI Vitest 隔离 wrapper 模式（project-test-sandbox 内、仓库固定 Node、沙箱内 vitest 配置与缓存、精确测试数、逐文件执行断言）。

- 生产改动仅函数内部（211 行，新增 28 / 删除 12，净增 16）；无跨调用缓存、无新 store/hook/RPC、无协议与持久化变化。主代理最终联合复跑的 69 项源测试和 16 项守卫全部通过，typecheck / lint / 变更架构通过；Lint 4 条警告和全仓格式的旧文件失败保留，不修改受保护基线。完整门禁、隔离事件与边界见[统一验证记录](../../.run-logs/project-only-validation/performance-continuation-4AdfBY/final-verification.md)。

## 验证记录

- 回归 `packages/ui/test/performanceGroupedTaskViewSortKeys.test.ts`（15 项，含 fixtures 模块 `performanceGroupedTaskViewSortFixtures.ts` 与冻结 oracle `fixtures/performance-grouped-sort-baseline/`，manifest 记录改动前 revision `187232e2` 与 sha256 `b722e94a…`）：未改生产文件时 13/15 通过、2 项预算红灯失败（随机分布 256 成员实测 4,198 次 > 预算 1,088；已有序实测 1,278 次 > 预算 776）；最小改动后 15/15 通过（两项均降至结构下限 768 次）。
- 子代理诊断性复测（未纳入提交回归，不作为父代理实测数据）（真实生产函数，tsx 内存装载 + 计数 getter，单 group、`sessions: []`）：修复后所有分布的 key 构造恒为 3n（n=512 为 1,536 次，n=256 为 768 次，n=64 为 192 次），比较器占比 0；输出顺序与冻结 oracle 逐场景一致。修复前同口径为 2,558 / 9,448 / 5,712（n=512 的已有序 / 随机 / 全打平）。
- 红绿灯与复测均在 `.run-logs/project-only-validation/` 沙箱内执行（wrapper `scripts/ci/ui-grouped-task-sort-keys-regression.test.mjs`，沙箱 `ui-grouped-task-sort-keys-tGviY0` 红 / `ui-grouped-task-sort-keys-umQWSi` 绿），HOME/TEMP/APPDATA 与数据目录全部重定向，不触碰真实用户数据。
- 本轮 16 个可格式化文件的定向检查通过；全仓格式只剩两个开工受保护旧回归文件失败，未改旧文件。Knip 未识别独立 Vitest 入口，将本测试与 fixture 列为 unused files，但包装器实际执行了 15 项，保留测试、不添加忽略规则。

## 验证边界

- 被测排序算法只处理内存数据；测试会读取项目内 fixture、冻结源码与 manifest，并在独立沙箱输出配置/缓存/报告，不能描述为整套测试无 IO。HOME/TEMP/APPDATA 与数据目录由包装器重定向；Node 写权限不覆盖所有 shell/原生副作用，历史失误另见统一记录。
- 工作量计数只反映指定合成输入的属性读取次数，不代表 Electron 整机时延或堆占用；未执行浏览器 E2E（无交互与组件结构变化）。
