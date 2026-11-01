# 复扫 UI 派生计算：文件树搜索展开的平方级扫描

## 规则、所有者与边界

`filterWorkspaceFileTreeRows`（`packages/ui/src/workspace-file-tree/model.ts`）是文件树的纯派生投影：输入已加载行、搜索词、changedOnly 开关与 Git 状态表，输出可见行。`WorkspaceFileTree` 在 `useMemo` 里按 `fileSearchQuery` 调用它——搜索框每键入一个字符就整树重算一次。该函数不持有状态、不做 IO，是本次复扫范围内唯一需要修复的实锤问题。

- 文件树行数据仍由既有 `treeData`（目录枚举、Git 状态、展开/加载态）唯一拥有；本修复只改函数内部的调用内索引，不新增 store 状态、跨调用缓存、公开入口、异步流程或第二条事实来源。
- 可见性契约保持不变，三条规则都沿用 `isWorkspaceFilePathInside` 的既有语义（双方路径先经 `normalizeForRelativePath` 归一化：反斜杠转斜杠、去尾部分隔符，再判断相等或「前缀 + `/`」）：
  1. 行自身命中搜索词（`row.name` 小写化后 `includes` 归一化查询）；
  2. 目录行是某个命中行的祖先或与命中行相等；
  3. 行位于某个命中目录之内或与命中目录相等。
- 输出顺序仍为输入 `rows` 顺序；空查询直接返回 changedOnly 筛选后的行数组（未启用 changedOnly 时保留输入数组引用）；无命中仍返回空数组；`changedOnly` 分支、`statusByPath` 只读契约与既有测试均不变。
- 输入行对象与 `statusByPath` 均不被修改；每次调用都从当次输入重新派生，不保留任何调用间索引（与 changedOnly 分支「不用留存索引」的既有测试一致）。
- 不改变交互、组件结构、虚拟化、Git 状态展示、Desktop continuous / mobile replayable 语义；不触及 RPC、services、desktop、server；本文件无视觉变化，不涉及 DESIGN.md 的组件规范。

## 已确认问题

旧实现在展开阶段对行做两轮平方级扫描：

- 对每个未命中的目录行，`matchedRows.some((matchedRow) => isWorkspaceFilePathInside(row.path, matchedRow.path))` 要线性扫描全部命中行，直到找到祖先关系为止；找不到时扫满全表。
- 对每个未命中行，`matchedDirectoryPaths.some((directoryPath) => isWorkspaceFilePathInside(directoryPath, row.path))` 要线性扫描全部命中目录。

工作量为 `rows × (matchedRows + matchedDirectories)`。实测（仓库固定 Node 24.14.0，计数口径为一次调用内的 startsWith/endsWith/includes/indexOf/lastIndexOf 次数）：1500 行合成树（750 命中文件 + 750 无关目录）修复前 564,000 次；1250 行合成树（500 命中目录 + 750 无关目录）修复前 751,250 次。文件树搜索按 fileSearchQuery 逐字符整树重算，这会增加输入期间的同步计算工作量；实际交互延迟尚未经浏览器或真机测量。changedOnly 分支此前已按同样思路修正（`performanceFileTreeChangedFilter.test.ts`），搜索展开分支一直未处理，与既有各轮 UI 性能 spec 无重复。

## 修复方案（唯一所有者不变）

在本次调用内建立两个只读索引，把两轮 `some` 扫描换成 O(1) 成员查询加逐级上溯：

- matchedDescendantPrefixes：所有命中行的归一化路径自身，及其按斜杠分段后的全部前缀（含边界 0 的空串，中间前缀的尾斜杠按同一归一化规则剥离）。目录行命中规则 2，当且仅当它的归一化路径在该集合中；这与「存在某个命中行，其归一化路径与该目录行相等或以该目录行加斜杠开头」严格等价。
- `matchedDirectoryPaths`：所有命中目录的归一化路径集合。行命中规则 3 当且仅当该行归一化路径自身或其任一祖先前缀在该集合中——逐级上溯时同样覆盖「与命中目录相等」的归一化情形（原始路径尾斜杠/分隔符差异只体现在归一化之前）。

索引大小与「命中行数 × 路径深度」线性相关，判断总工作量与「rows × 路径深度」线性相关。同一组合成输入修复后实测 6,000 次与 4,500 次（耗时 2.39ms / 1.05ms），分别降低 94 倍与 167 倍；预算断言（64 × rows）在回归中锁住该量级。操作数是指定合成输入的工作量指标，不能换算成整机提速比例。

## 验收

1. 先新增回归 `packages/ui/test/performanceFileTreeSearchExpansion.test.ts`：行为基准（复述旧算法的参考实现）对结构化边界与 seeded 随机树逐一等价；两条操作数预算断言在修复前实测失败（564,000 > 96,000 与 751,250 > 80,000），修复后通过（6,000 / 4,500）。
2. 最小实现只替换 `filterWorkspaceFileTreeRows` 的展开阶段，用中文注释说明平方级原因与等价依据。
3. 修复后：新回归通过；既有 `performanceFileTreeChangedFilter.test.ts` 与 `performanceAuditDifferential.test.ts`（与冻结基线逐场景比对）不回归；`architecture:check --changed` 无新增违规。
4. 全量 typecheck / lint 由主代理统一执行，本代理不重复跑。

## 验证边界

- 回归经 `scripts/ci/ui-file-tree-search-expansion-regression.test.mjs` 在 `project-test-sandbox` 内以仓库固定 Node 24.14.0 运行真实 vitest；沙箱把 HOME/TEMP/APPDATA/数据目录全部限制在 `.run-logs/project-only-validation/` 内，无链接越界，不读真实用户数据。
- 专项入口共 18/18 项通过（新回归 9、changedFilter 4、differential 5），入口断言确切执行数量；主代理整合后实际执行全量 corepack pnpm typecheck 与 corepack pnpm lint，类型检查通过，Lint 为 0 错误及 2 条开工前已有警告；架构检查为 0 违规。
- 未执行浏览器 E2E（本修复不改变交互与组件结构）；操作数是指定合成输入的工作量指标，不能换算成整机提速比例。
