# 动态工作流留白能力（Dynamic Workflow Holes）

**当前状态：P1 / P2 / P3a / P3b 源码与自动测试已落地；真机验收暂缓。**
原子补全、stale approval preview、strict display.fill 与 shared/UI 的 commitSequence 接入，
以及 steps 为空但 phases/holes 非空的图展示均已实现。展示规则、自动验收与待执行的真机
场景见 [`workflow-holes-ui.md`](./workflow-holes-ui.md)。CLI 使用包级 node:test；shared/UI
使用 Vitest，不混用 runner。下文分期记录与验证数字保留为当时快照，不代表当前待办或本轮重跑结果。
这不是上游全量 parity：hole 数据依赖完整图、生长动画、model_bindings 检查与 Rust 同步未做。

## 正确性收尾：审批基线与 durable 提交顺序

- resolve 是 `hole.base_script_hash` 的唯一生产者，模型 schema omit 整个 hole；hash 与
  effective_script 必须来自同一次 getScript 字节。获批工具缺 hash 时 fail closed，不调用补全端口。
- `fillHole.expectedScriptHash?: string` 在 bootstrap 每 run 串行轮到本次时，对当前 scriptHash
  校验；不等返回新增 `fill_preview_stale`（保留原四理由），零编译/草稿/事件/放行副作用，重新
  resolve/审批。内部无显式 hash 调用兼容本地当前基线，不降低 foreign / 用户手停权限边界。
- Journal 必需接口 `commitHoleFill(runId, scriptText, scriptHash, holeFilledEvent): StoredEvent`
  将脚本/hash 与 hole-filled 原子持久化；SQLite 同一事务，内存实现异常不留下部分写入。
  不允许 updateRunScript + appendEvent 降级。引擎先 commit，成功后 swapTables、沿 EngineState
  唯一 record 广播路径通知已存事件（不重复 append）、最后登记 filled 与放行 promise。
  commit 失败：run 行、事件、内存表、停驻 promise 完全不变，resume 不执行失败补全。
- 草稿是 journal 的派生副本：commit 后尽力就地改写，失败不撤销已提交补全；`scriptPath` 只在草稿
  成功写回后返回，缺席时工具输出不得声称磁盘草稿已同步，也不得把旧路径作为本次成功补全的草稿位置。
  快照与 GetWorkflowRun 共用草稿可用性投影；写回期间或失败后隐藏路径，内部保留源路径供下次补全
  重写。成功重写整份有效脚本后恢复路径。冷查询及 resume 遇到既有 hole-filled 时，不凭启动事件的
  路径推断磁盘已同步；没有本进程写回确认时隐藏路径，journal 仍是有效脚本的唯一权威。
- StoredEvent.sequence 是唯一 durable 顺序，返回引擎 FillHoleResult.commitSequence，端口
  FillWorkflowHoleResult.commitSequence，再传 CreateWorkflowOutput.fill.commitSequence 与 strict
  display.fill schema（复用 fill schema）。shared schema 已同步；UI 只读同 run 成功补全的
  最大 commitSequence 选图，不用时间戳/工具行位置排序。
- 通知 manifest 的 name/type 等展示字段按 shared workflow-row-meta 运行时界限截断；不修改
  原始编译类型或编译约束。129 字符合法类型通知必须能通过真实 shared schema。

```text
resolve(getScript 字节 → hash + effective_script) → owner/foreign/manual-stop 权限 → 审批
  → bootstrap run 串行 admission → expectedScriptHash 校验 → compile / stability
  → engine → journal 原子 commit(script/hash + hole-filled) → sequence
           → swapTables → EngineState.record(已存事件，仅广播) → filled / promise 放行
  → bootstrap 事实/草稿 → handler fill.commitSequence → executor display.fill.commitSequence
commit 抛错 ─→ 全部原样；stale ─→ fill_preview_stale → 新 resolve / 审批
Desktop continuous / mobile replayable 使用同一 journal sequence，无新通知/状态 owner。
```

验收用真实 node:test：旧 B 审批期间 A 补全后 B stale 零副作用；atomic append 故障
（内存/engine 与可用 SQLite adapter）回滚，成功仅一条 hole-filled、sequence 递增与 metadata
透传；129 字符合法类型 manifest 通过 shared runtime schema。

### 原子补全验证与交接（历史快照）

以下为原子补全负责者当时的范围与验证；其 shared/UI 交接已完成，未执行的真机场景仍暂缓。

- CLI 递归 build / test / typecheck 均 exit 0；test 141/141（其中本域 105/105），包括真实
  SQLite trigger 注入 append 失败回滚、内存 append 后抛错、真实 engine 与 sandbox stale approval。
- 根 `pnpm typecheck` / `pnpm lint` / `pnpm fmt:check` 最后均 exit 0。此前 typecheck /
  fmt 曾因域外 Web 并行半成品失败，未触碰。架构检查前后 exit 0，violations / baseline /
  new 均 0。本轮文件 targeted lint / formatter check exit 0。
- CLI 顶层 typecheck/lint 脚本 exit 1（`turbo: not found`），另执行递归包 typecheck exit 0；
  递归包 lint exit 1（若干包 root ignore 导致 No files found）。对本域五包 `oxlint src
--no-ignore` 有域外本地半成品 max-lines 基线失败；只查本轮文件 exit 0，不恢复半成品。
  CLI 全量 format:check exit 1（已有大量格式差异），仅格式化本轮文件。
- 日志均在 `/tmp/holes-atomic-*`，精确本轮文件名单 `/tmp/holes-atomic-files.txt`；没有写 git
  操作，没有改 shared/UI/其他 spec/诊断生成物。CLI 提示 Node 期望 24.14.0，运行环境为 24.19.0。
- 后续展示负责者需将 shared fill schema 同步 `commitSequence?: nonnegative integer`，UI 按
  同 run 最新成功 fill 的最大 commitSequence 选图；不能依靠工具行位置或 timestamp。未跑 UI/E2E。

## CI frozen lockfile 修复记录（2026-05-18）

- `@zcode/dynamic-workflow` 是其 CLI `node --import tsx --test` 测试运行时依赖的唯一声明所有者；新增 `devDependencies.tsx: ^4.20.0` 必须反映到仓库 `pnpm-lock.yaml`，CI 继续使用 frozen install，不移除测试依赖或放宽锁定。
- 已核对 CLI 的 `adapters`、`core`、`bootstrap`：三者测试脚本也使用 `--import tsx`，但 package.json 中均没有新增或声明 `tsx`；本次已知变更只有 `dynamic-workflow` 新增依赖。按本任务仅改 lockfile 与本 spec 的边界，不擅自改其它 manifest；若这些测试包的隐式解析另有问题，另行立项处理。
- 生成锁文件使用仓库 pinned pnpm `10.33.2`，只在 `@zcode/dynamic-workflow` importer 增加 `tsx ^4.20.0 → 4.21.0`，未改解析版本；验收保持 frozen install。`pnpm install --frozen-lockfile --ignore-scripts` 实际安装 exit 0（不是 lockfile-only 验证）。
- 验证结果：CLI `dynamic-workflow/adapters/core/bootstrap` build exit 0；四包测试分别 24/1/25/32，全通过（合计 82）；根 `pnpm typecheck`、`pnpm lint`、`pnpm fmt:check`、`pnpm architecture:check --changed` 均 exit 0。Lint 报 50 条既有 warning、0 error。各命令完整日志位于 `/tmp/ci-lock-fix-{lockfile,frozen-install,cli-build,cli-test,typecheck,lint,fmt,architecture}.log`；变更摘要 `/tmp/ci-lock-fix-diff-summary.log`。
- 环境提示 Node 实际 `24.19.0`，仓库要求 `24.14.0`；锁生成 / install 另有已知 deprecated 与 peer dependency warning，不影响退出结果。CI 源日志 `/tmp/failed-ci-job.log` 确认根因是 `ERR_PNPM_OUTDATED_LOCKFILE`，dynamic-workflow 新增 tsx 缺少 importer 锁定记录。

## 背景

上游 3.15.1（`aac47556`）在 `apps/zcode-cli/packages/dynamic-workflow` 里新增了一条纵向能力
——**留白（Holes）**：脚本作者在写工作流时可以先留一个位置，等前面的步骤跑出结果后，再由主
代理为它补上函数体；在那个位置被补上之前，该分支停住等待，同一 run 的其他分支继续跑。

三条证据说明它是**真实能力**而不是重构：

1. 移植前基线树里 `FillWorkflowHole` / `HOLE_CODE` **0 命中**（复核命令见
   [`upstream-sync-3.15.1.md`](./upstream-sync-3.15.1.md) 的「工作项 4」）。整个能力（facade
   符号、编译规则、引擎停驻表、线协议请求、工具、端口、v4 展示）在这边都不存在。
2. 它在协议、工具、权限、UI 四处都有自己的名字与载荷：`hole-reached` / `hole-filled` 事件、
   `FillWorkflowHole` 工具、`DynamicWorkflowRunHole` 快照条目、`workflowRuns` 归约分支。这些是
   产品面契约，不是内部重构。
3. 它改变了 run 的时序模型：一条分支可以在 `await hole<T>(...)` 处**长时间停驻**，而这在
   AskUser / AmendWorkflow 里没有对应物。这决定了移植必须带引擎、协议与宿主三处，不能只搬
   编译器。

上游把 `dynamic-workflow` 从 102 个文件扩到 2,058 个，其中 1,575 个是图分析期望输出快照、
`src` 只 120 个。留白是 `src` 增量里唯一成体系的新纵向能力，因此单独立项；其余增量按
`upstream-sync-3.15.1.md` 逐文件判定。

## 范围与非目标

**范围**：把留白作为本仓库的原生能力实现——facade 与编译规则、脚本降级、引擎停驻与补全集、
沙箱线协议、契约端口与 `FillWorkflowHole` 工具、bootstrap 驱动、v4 快照与 UI 展示。

**非目标**（沿用 [`upstream-sync-3.15.1.md`](./upstream-sync-3.15.1.md) 的 Non-goals）：

- 不搬 `apps/zcode-cli/packages/dynamic-workflow/src/testing/**`。
- 不 vendor `tests/**` 的期望输出快照与图分析夹具。
- 不搬依赖遥测 / 商业 / 官方鉴权的联动面（`packages/shared/src/{telemetry,...}` 等，见该 spec
  的「故意不跟」表）；留白本身不依赖这些。
- 不整包跟随 `dynamic-workflow` 的其他演进（`zcodeSessionProjection`、UI 产品面改版等）。
- 不引入新的 runner：CLI 验收用包级 `node:test`；shared/UI 用仓库已有 Vitest。
- 不搬上游 hole 数据依赖完整图（`holeData` / `hole-flow` / 站点图 hole 节点与相关序列化）；
  当前 phase/hole 图与空 steps 展示不等于该完整图。
- 不做上游补全生长动画或 `model_bindings` 检查；Rust 等价实现/同步未做，不宣称全量 parity。

**与上游保持一致的部分**：协议事件名、`HOLE_CODE`（9012）、`hole#<8hex>` 站点 id 形状、
`FillWorkflowHole` 工具名与拒绝原因字符串、v4 `WorkflowRunHole` 字段。这些是跨端契约，改名会
让后续与上游对照失去锚点。

## 能力边界

以下四个概念取自上游源码（`aac47556`，路径为上游路径），用本仓库的表述写清，便于评审对齐。

### 1. 留白站点如何被识别（编译期）

facade 里声明三个重载：

```ts
hole<T>(name: string, prompt?: string): Promise<T>;
hole<T>(name: string, body: () => Promise<T>): Promise<T>;
hole<T>(name: string, prompt: string, body: () => Promise<T>): Promise<T>;
```

`src/analysis/hole-sites.ts` 在分析器那一趟里按实参形状分派：第二实参是函数字面量即函数体，
否则是提示；第三实参（若有）是函数体。站点 id 由 `src/analysis/hole-id.ts` 的
`holeSiteId(name)` 从名字铸出——名字 trim 后按 Unicode 码点做 FNV-1a 32 位哈希，写成
`hole#<8 位十六进制>`。**键是名字，不是位置**：这样补全在脚本中间插代码时，插入点之后的留白
不会改号，journal 键、ask 规格表、站点阶段表都能在补全前后幸存。名字在整个有效脚本里唯一，
体内再留的留白自己又是 `hole#<hash>`，嵌套关系记在站点表的 `fill` 字段而不是 id 前缀。

编译期规则集中在 `HOLE_CODE = 9012`（与 9003 / 9004 同席），每条都是「与其运行期才炸，不如让
分析器现在就报」：

- 类型实参必须显式写出（推断出的 `unknown` 不是补全要检查的契约）；
- 名字必须是非空字符串字面量，长度 ≤ `HOLE_NAME_MAX_CHARS = 128`，且在脚本的留白与阶段标记
  中唯一（两个标记同名是一个阶段，两个留白同名却是两个缺口）；
- 调用必须被 `await`；
- 不能落在 fan-out 回调（数组方法的回调）里——元素并发跑，补全没法在它们已经在跑时写；
  `for...of` 体允许，因为带 `await` 的 `for...of` 是顺序的，补全到了一轮一轮跑；
- 函数体必须是内联函数字面量（lowering 要把它原样打印成补全文本）；
- 函数体不得引用留白之后才声明的绑定（函数体是编译器不检查「先用后声明」的闭包，运行期会
  TDZ 抛错）。

`FACADE_HOLE_SEGMENT`（`src/facade/dts-hole.ts`）只拼进**完整 facade，不进 snippet facade**：
片段没有 run，也就没有可等主代理补全的东西。

### 2. 如何 splice（编译期 → 有效脚本）

`src/analysis/hole-splice.ts` 提供两件纯文本工具：

- `spliceHoleBody(scriptText, table, holeSiteId, body)`：把 `body` 作为**最后一个实参**拼进
  留白调用——在最后一个实参末尾插入 `, async () => {\n<body>\n}`，函数体每行按调用所在行的
  缩进再加 2 格，右花括号取调用的缩进。插入点是「最后一个实参的末尾」而不是右括号之前：作者
  常按 prettier 习惯写 `hole<T>(\n  "名",\n  \`提示\`,\n);`，尾随逗号会让「右括号前插入」得到
`, , async`，而接在实参末尾之后则得到合法的 `}, \n)`，原注释与尾随逗号都保留。返回
`insertedAtLine`/`insertedLines`，供诊断把行号分到函数体内还是草稿内；留白不在表里或已有
函数体时返回 `undefined`。
- `checkSiteStability(before, after, holeSiteId, insertedAtLine, insertedLines)`：补全前后站点
  id 的稳定性复核。`before` 的每个 id（全部种类）都要在 `after` 里，位置不变，或落在插入点
  之后时行号整体后移 `insertedLines`；`after` 里新出现的 id 必须是这次补全写下的（带
  `<holeSiteId>/` 前缀，或 `fill` 链通到该留白）。任何一条不成立都是宿主故障
  （`fill_ids_unstable`），run 不能拿到它接不上的 id。

补全产出的脚本是**有效脚本**：它被写回 run 行（`updateRunScript`），所以 resume 重放时函数体
内联执行、shim 不过线、`hole-reached` 不再出现。

### 3. runtime 的 `hole` request 是什么（沙箱线协议）

`dynamic-workflow-runtime/src/protocol.ts` 是 NDJSON 线协议的**唯一真源**，child → parent 的
`RequestMessage` 上有一个 `type: "hole"`：

```ts
interface RequestMessage {
  kind: "request";
  id: string;
  type: "ask" | "world-read" | "publish-artifact" | "hole";
  siteId: string;
  name?: string; // hole 专属：留白的字面名
  prompt?: string; // hole 专属：给主代理的提示（引擎记录前截到 4000 字符）
  // ...
}
```

脚本到达一处未补全的留白时，子进程发这条 request，父进程经引擎把它停下，直到主代理补全，再以
`{ code }` 应答——`code` 是有效脚本 lowering 出的 `holeBodies[siteId]`，即 `(async () => {…})`
的文本，不是主代理手写的源码。停驻的分支是一条**在飞请求**：兄弟分支照跑，停滞检测不响。已补全
的留白不再过线。子进程源码 `child-source.ts` 里以纯手写方式镜像这些形状（无法 import 本模块），
父进程侧直接 import 类型，两处必须一起改。

### 4. facade / 包暴露了什么符号

上游 `src/index.ts` 与各模块对外暴露（节选）：

| 符号                                                      | 来源                          | 作用                                |
| --------------------------------------------------------- | ----------------------------- | ----------------------------------- |
| `hole`（三个重载）                                        | `src/facade/dts-hole.ts`      | 脚本可见的留白原语，只进完整 facade |
| `HOLE_CODE` = 9012                                        | `src/analysis/hole-sites.ts`  | 留白编译诊断码                      |
| `HOLE_NAME_MAX_CHARS`                                     | 同上                          | 名字长度上限                        |
| `collectHoleDiagnostics`                                  | 同上                          | 收集 9012 诊断                      |
| `HoleSite` 类型                                           | `src/analysis/sites.ts`       | 站点表的留白条目                    |
| `spliceHoleBody` / `SplicedHoleBody`                      | `src/analysis/hole-splice.ts` | 拼接与稳定性复核                    |
| `holeSiteId` / `holePrefixOf` / `isHoleSiteId`            | `src/analysis/hole-id.ts`     | 名字键与 id 形状                    |
| `HoleRegistry` / `reachHole` / `fillHole`                 | `src/engine/engine-holes.ts`  | 引擎停驻表与补全                    |
| `HoleFill` / `FillHoleResult` / `OpenHole` / `FilledHole` | 同上                          | 补全请求与快照投影                  |
| `HOLE_PROMPT_MAX_CHARS` = 4000                            | 同上                          | prompt 截断上限                     |

## 需要联动的包与文件

路径以上游 `aac47556` 为准；移植时删掉上游特有的遥测 / 商业引用，其余按本仓库的导入规范改。
「所有者 / 纪律」列写明每层唯一的写入口。

| 层                           | 上游文件（示例）                                                                                                                                                                                                                        | 作用                                                                                     | 所有者 / 纪律                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `dynamic-workflow`（编译）   | `src/analysis/hole-sites.ts`、`hole-id.ts`、`hole-splice.ts`、`sites.ts`                                                                                                                                                                | 站点识别、9012、拼接与稳定性复核                                                         | 站点表是编译产物唯一真源；id 只由名字铸                  |
| `dynamic-workflow`（降级）   | `src/lowering/lower-hole.ts`                                                                                                                                                                                                            | 把 `hole` 调用改写成 `__host.hole(siteId, name, prompt, (__src) => eval(__src)[, body])` | 与其余站点同一趟 transform                               |
| `dynamic-workflow`（引擎）   | `src/engine/engine-holes.ts`、`engine.ts`、`engine-state.ts`                                                                                                                                                                            | 停驻表、`hole-reached` / `hole-filled`、`updateRunScript`                                | `HoleRegistry` 是唯一内存所有者；无 journal node 行      |
| `dynamic-workflow`（facade） | `src/facade/dts-hole.ts`、`src/index.ts`                                                                                                                                                                                                | 暴露 `hole` 与上述符号                                                                   | 只进完整 facade                                          |
| `dynamic-workflow-runtime`   | `src/protocol.ts`、`harness.ts`、`child-source.ts`                                                                                                                                                                                      | `hole` request 与 `{code}` 应答                                                          | 线协议唯一真源；child-source 手写镜像                    |
| `contracts`                  | `src/interfaces/dynamic-workflow-run-hole.port.ts`、`dynamic-workflow-run.port.ts`、`src/tools/fill-workflow-hole.ts`、`get-workflow-run.ts`、`create-workflow.ts`                                                                      | 端口读面 `holes[]`、`fillHole` 方法、工具契约与拒绝原因                                  | `fillHole` 端口方法是唯一补全写入口                      |
| `bootstrap`                  | `src/app/dynamic-workflow-run-holes.ts`、`dynamic-workflow-run-fill.ts`、`dynamic-workflow-run-service.ts`、`dynamic-workflow-run-launch.ts`、`dynamic-workflow-run-replay.ts`、`dynamic-workflow-run-observation.ts`                   | 驱动补全：拼接、编译、稳定性检查、改草稿、投影快照                                       | run service 按序调用；纯合成规则无 I/O                   |
| `core`                       | `src/tool/handlers/fill-workflow-hole.ts`、`fill-workflow-hole-description.ts`、`fill-workflow-hole-resolve.ts`、`fill-workflow-hole-splice.ts`、`get-workflow-run.ts`、`src/runtime/methods/dynamic-workflow-run-hole-notification.ts` | 工具 handler、确认窗预览、`hole-reached` 通知                                            | 每条 `hole-reached` 恰好一条通知；`hole-filled` 不发通知 |
| `shared`（v4 展示）          | `packages/shared/src/zcode-protocol-v4/workflow-runs-holes.ts`、`workflow-runs-reducer.ts`、`workflow-runs.ts`                                                                                                                          | `hole-reached` / `hole-filled` 归约、`phaseHoles` 下标、上限                             | reducer 是纯函数；`waiting` 只由引擎停驻表决定           |
| `ui` / `desktop`（展示）     | `packages/ui/src/components/workflow-timeline/**`、`app-shell/WorkflowRunPhaseList.tsx`、`v4/WorkflowNotificationHoleRow.tsx`、`ToolCallBlocks/renderers/workflow-fill-row.tsx`、`WorkflowPermissionHoles.tsx`                          | 时间线上把留白站画成虚线灯、通知行、补全工具行与确认窗                                   | 展示只读 v4 归约结果，不自算状态                         |

`packages/shared/src/diagnosticLogCatalog.ts` 由 `node scripts/diagnostic-log-catalog.mjs` 扫描
生成：任何新增/删除源码文件后必须重跑，否则新增日志模块不进词表。

## 验收场景

1. **未填充留白时运行**：脚本在 `await hole<T>("名", "提示")` 处停住——分支停驻、`hole-reached`
   进 journal、主代理收到一条模型可见通知；同一 run 的其他兄弟分支继续跑；停滞检测不报；快照
   的 `holes[]` 该条目 `state: "waiting"` 且带 `since`。
2. **填充后 splice 的结果**：`FillWorkflowHole` 提交函数体后，有效脚本里留白调用被改成
   `hole<T>("名", "提示", async () => { … })`（函数体接在最后一个实参末尾，缩进 = 调用缩进 + 2），
   拼好的有效脚本写回 run 行；停驻分支以 `{code}` 放行并继续；本世之后再次到达同一站点时直接
   用记住的代码作答，**不再停驻、不再记 `hole-reached`**。
3. **错误码与 HOLE_CODE 的触发条件**：
   - 分析期 `HOLE_CODE = 9012`：缺显式类型实参、名字非字面量 / 空 / 超 128 字 / 与留白或阶段
     标记重名 / 哈希撞车、未 `await`、落在数组方法回调里、函数体非内联、函数体引用晚声明绑定
     ——任一条都让脚本不可提交。
   - 补全被拒的结构化原因：`run_not_found`、`hole_not_waiting`（已补 / 还没到 / 未知 id）、
     `compile_failed`（带 `diagnostics`，草稿不动、留白照旧在等）、`fill_ids_unstable`（站点改号，
     宿主故障）。
4. **journal 里能看到什么**：留白本身**没有** `dwf_node` 行（它不是会自己结算的节点）；journal
   里是 `hole-reached`（`instance.siteId` + `ordinal`、`name`、截断后的 `prompt`）、
   `hole-filled`（`siteId`、`filledAt`、`filledBy`、新的 `phaseNames`、`holes` 下标、`scriptPath`）
   与 `run-launched.holes`（开放留白在阶段表里的下标）。resume 重放有效脚本时体内联执行，
   shim 不过线。
5. **截断与上限边界**：`hole-reached` 的 prompt 超 4000 字符截到上限并以 `…` 收尾（通知与 v4
   又各自再截一次）；留白名字 > 128 被 9012 拦下；快照 `holes[]` ≤ 32 条；v4 归约对
   `phaseNames` / `phaseHoles` / prompt / type 各有上限，越界或重复的下标被丢弃。
6. **并发与生命周期边界**：同一站点在循环里停驻多个 ordinal 时，一次补全放行该站点下**所有**
   停驻分支；`fillHole` 对已结算 run 返回 `settled`、对该站点既不在等又没补过返回 `not_waiting`，
   两条都**不写不发**；run 结算时停驻分支以结算错误拒绝、补全记忆保留；resume 从空停驻表起，
   重跑到未补站点会再记一条 `hole-reached`。
7. **展示**：时间线把开放留白画成虚线灯、补全后阶段表按插入位置右移（`phaseAlongside` 的
   `+k` 规则）；`FillWorkflowHole` 行复用 `CreateWorkflow` 的输出形状；通知行点击能定位到该
   留白的站点 id。

## 分期计划

```text
P1  契约 + 引擎：contracts 端口（holes[] / fillHole）、dynamic-workflow 的 analysis /
    lowering / engine-holes、runtime 的 hole request 与 {code} 应答。
P2  bootstrap + core：run service 的拼接 / 编译 / 稳定性检查 / 改草稿、快照投影、
    FillWorkflowHole 工具与权限、hole-reached 通知。
P3  展示：shared v4 归约（hole-reached / hole-filled / phaseHoles）、UI 时间线、通知行与
    补全工具行、确认窗。
```

依赖方向：

```text
dynamic-workflow（编译 + 引擎）
  └─ dynamic-workflow-runtime（沙箱协议）
contracts（端口 + 工具）
  ├─ bootstrap（驱动与投影）
  └─ core（runtime method + 通知 + handler）
shared v4（归约）
  └─ ui / desktop（展示）
```

P1 完成前不落 P2，P2 完成前不落 P3；每期各自补测试与验收，且必须先跑
`node scripts/check-workspace-freshness.mjs` 与 `pnpm typecheck` / `pnpm lint`。

## 待确认问题清单（P1 前历史快照，非当前 TODO）

1. **是否跟随上游的站点 id 形状**：`hole#<8 位十六进制>` 由名字的 FNV-1a 哈希铸出。我们要不要
   保持逐字节一致？不一致会让与上游 journal 对照失去锚点，但一致意味着继承其哈希撞车语义。
   目前不知道本仓库有没有别处依赖该形状。
2. **停驻与进程死亡**：进程亡故后停驻的 promise 消失，快照的 `waiting` 只在引擎停驻表里有它时
   成立。resume 会重跑到该站点并再记一条 `hole-reached`。但「主代理在 run 停驻期间重启 / 切换
   会话」时，通知与补全入口如何保证不丢，还没读清。
3. **fill 文件的落地策略**：上游把被拒的内联提交写成 fill 文件、下一次按 `path` 交回。文件放在
   本仓库的哪个数据根（`appDirNames.ts` 的 `ZCODE_USER_DATA_DIR_NAME` 还是 run 草稿旁）？保留
   多久、如何清理？
4. **权限与确认**：`FillWorkflowHole` 的免确认规则是「run 归本会话且不是用户亲手停下的」。
   本仓库的权限模型（`core/src/tool/handlers` 与 `permission/service.ts`）是否需要另一条
   approval 路径？目前不知道本仓库是否有对应 owner 概念。
5. **与 Rust 重写的关系**：留白是 Node CLI 的能力。Rust 重写是否要等价实现、还是只保留 Node
   侧、由 Rust 调用？这决定 P2 的工作是否会被重写覆盖。
6. **UI 展示范围**：上游时间线的留白灯、`phaseAlongside` 右移与「补全生长」动画是一整套视觉；
   我们只做最小可用的虚线灯 + 通知行，还是跟随？本仓库的 `DESIGN.md` 是否允许该视觉，尚未对齐。
7. **测试与 CI 口径**：上游留白测试多在 `tests/**`（本 spec 明确不 vendor 快照）。我们要新写
   哪些 `node:test` 用例、是否接入 `scripts/ci/*.test.mjs` 门禁，尚无定论。
8. **诊断日志词表**：`diagnosticLogCatalog.ts` 的生成脚本扫描全仓源码；留白新增的日志模块命名与
   前缀如何登记，会不会触发词表校验，需要确认。

## 定案（P1 开始前）

所有者叫「开始编码」后，对上面 8 条待确认问题逐条取保守结论。原问题保留，结论如下。

1. **id 形状：与上游逐字节一致。** 保持 `hole#<8 位十六进制>`，名字 trim 后按 Unicode 码点做
   FNV-1a 32 位哈希（`analysis/hole-id.ts` 的 `holeSiteId`）。理由：与上游 journal 对照保持锚点，
   且名字键是补全前后站点稳定的根基。哈希撞车沿用上游语义——9012 报错、绝不猜；两个不同名字
   撞到同一 id 时脚本不可提交。本仓库别处不依赖该形状（`FillWorkflowHole` / `HOLE_CODE` 在基线
   0 命中）。
2. **与 Rust 重写的关系：P1 只做 Node 侧。** Rust 是否等价实现待定，不影响本期；本期交付的契约
   与线协议不假设 Rust 会重写。
3. **fill 文件落地：P1 不涉及（属 P2）。** 只记录方向——被拒的内联提交写成 fill 文件时，用
   `packages/shared/src/appDirNames.ts` 的数据根，不放 run 草稿旁；保留时长与清理策略留到 P2 定。
4. **权限 / 确认：P1 只落契约与端口。** 是否免确认留到 P2；P1 **不引入新的 approval 路径**，
   `FillWorkflowHole` 的 handler 与权限判定不在本期。
5. **UI 展示：P3 再定。** P1/P2 不做 UI（v4 归约、时间线虚线灯、通知行、确认窗都留到 P3）。
6. **测试与 CI：新写 `node:test`，不 vendor 上游 `tests/**`快照。** 用例放在`apps/zcode-cli/packages/dynamic-workflow/test/_.test.ts`，并给该包加 `test`脚本，风格与`apps/zcode-cli/packages/contracts/package.json`一致：`node --import tsx --test --test-isolation=none test/_.test.ts`。这样它会被 CI 里已有的
`pnpm -r --filter './apps/zcode-cli/packages/_' test`步骤自动拾取。不接入`scripts/ci/_.test.mjs`。
7. **诊断日志词表：新增/删除源码文件后必须重跑** `node scripts/diagnostic-log-catalog.mjs`。
   留白本身不新增日志模块；若脚本扫描变化，则重跑生成并跑 oxfmt。
8. **站点表 / 阶段表：按上游语义。** 两个阶段标记同名是**一个**阶段（名字继续同一阶段）；两个
   留白同名是**两个**缺口，被 9012 拒绝。留白按名字占阶段表的一个位置。

以上结论不改变本文前面对能力边界、所有者与分期计划的定义。

## 当前状态

**P1 / P2 / P3a / P3b 源码与自动测试已落地，真机验收暂缓。**
P1 契约/引擎/线协议、P2 驱动/工具/权限/通知、P3a 阶段分析与 v4 归约、P3b 展示与正确性
收尾均已接线。P2 的重复投影、通知 manifest、fill 文件与权限、display 契约历史偏差已修正；
未实现的 model_bindings 与上游 hole 数据依赖完整图仍明确排除，不将它们算作已完成。

- 原子 journal 提交先于内存表替换/广播/放行；审批基线过期返回 `fill_preview_stale`，零副作用。
- durable sequence 已从引擎/端口/output/display 贯穿至 shared/UI；同 run 最新成功图按最大
  commitSequence 派生，failed/pending 与旧序号 replay 不覆盖。
- phase/hole-only（steps=[]）图已在工具行/直接启动行联接、审批、工具卡、run digest 与侧栏
  同源展示；通知保留原始 siteId 落站意图。SSR/纯逻辑测试不等于真实 DOM 滚动验收。
- 自动测试包括 shared 的归约与 display 两文件、UI 的 `workflowHoles.test.ts` 与
  `workflowHoleOnlySurfaces.test.ts`；CI Vitest 增加这些入口并保留原有目录，CLI node:test
  沿包级 test 脚本拾取。servicePipe 新 case 沿原入口拾取，mobile 四个测试已被原目录覆盖。
- 当前展示契约与真机场景以 [`workflow-holes-ui.md`](./workflow-holes-ui.md) 为准；
  下列分期验证、交接与「本期不做」均保留为历史时点，不是当前 TODO。

### P3b 后端规则与验收

- 阶段词汇表与站点出生阶段唯一所有者是 dynamic-workflow 的公共
  `collectPhaseNames` / `collectSitePhases`；bootstrap 删除重复投影。launch 的声明表与
  compiled holes 生成 `run-launched.holes`；fill 从有效脚本重算 `hole-filled.holes`。
- 被拒内联函数体异步写入 `<用户数据根>/workflow-fills/<session哈希>/<run哈希>/<site哈希>/`，
  用户数据根复用 `appDirNames.ts` 与 `ZCODE_DATA_BASE_DIR` 口径；名称只作可读标签，完整身份
  哈希隔离会话/run/site，内容哈希实现相同字节复用；先写完整临时文件再原子独占发布，
  并发重试不会读到半写文件，不覆盖用户编辑。
- 保留 7 天（mtime）；每次写入先 await best-effort 清理过期普通 fill 文件，然后写本次文件，
  不用定时器，不在 run 结束时删除（模型可跨长会话重试）。清理忽略符号链接/非 fill 文件；
  崩溃遗留的 `.uuid.pending` 也按相同保留期清理；写失败仍返回原编译诊断。
  测试可注入 root / now / retentionMs。
- 输入 path 可读本次作用域的 fill 文件或正常用户提供的文件；拒绝 `..` 路径段，托管数据根
  内禁止跨 session/run/site 与符号链接绕过。配置根的链接别名与 realpath 返回路径须一致解析；
  外部链接及托管目录内的文件链接仍拒绝。写入路径不使用原始身份或名字作目录路径。
- 批准预览唯一载体是 resolveInput 回填的 `hole.effective_script`，不再使用进程级单槽缓存，
  并发补全不会抢走彼此预览；模型提供的整个 hole 块（包括该字段）都无条件剥掉。
- resolveInput 无条件剥掉模型伪造的 hole 事实，端口快照回填 owner：parentSessionId 匹配
  且 stopReason 非 user 才 owned；权限服务调用 contracts 的 `isFillWorkflowHoleOwnedRun`。
  FillWorkflowHole 不接受会话级全工具免确认；foreign/manual-stop 不能被 yolo/plan 或 session
  allow 绕过。硬 deny 始终优先。编译失败也不替 foreign 输入免确认。
- 每条有效 hole-reached 恰一条通知，originMeta.workflowNotification.kind 为 hole，携带
  siteId/ordinal/name/type 与可用 prompt/草稿/行/前后阶段；文本和 manifest 共用有界 prompt。
  hole-filled 不通知。沿现有 taskId/branchGeneration fencing 与通知 delivery 管线，不另造队列。
- FillWorkflowHole 成功输出与批准预览走 CreateWorkflow display 单一投影（纳入工具名），
  成功输出带 fill 身份与有效脚本图；图边界搬运控制流 holes 与 phase.fill（phase 词汇表
  整体超限时一起丢弃），step.fill 取站点所属阶段的 fill；不手造分析器尚未提供的 hole step
  或 phaseStreams。不引入未实现的 telemetry / model_bindings。

```text
模型输入 → core resolveInput（快照事实 + 路径隔离 + 有效脚本预览）
         → PermissionService（owned 放行；其余 ask；deny 优先）
         → bootstrap 每 run 串行 fill → 编译/稳定性复核 → engine 唯一写入口
                                                        ├─ 更新 journal / hole-filled / 放行
                                                        └─ bootstrap 更新事实 / 草稿
compile_failed → core 清理过期文件 → 独占保存函数体 → 返回可编辑重试 path
hole-reached → core 一条通知（文本 + hole manifest）→ 现有 continuous/replayable 通知管线
```

验收使用实际 node:test：磁盘写读/过期清理/并发不覆盖/身份隔离/路径遍历与符号链接；
resolveInput + PermissionService 的 owned/foreign/manual-stop/伪造与 deny；真实编译/引擎的
launch 与 fill 阶段下标；通知 manifest 数量与字段；成功工具输出和批准预览 display。
后端只修改 bootstrap/core 与本 spec；contracts/shared/UI 由并行负责者修改，诊断生成物最后统一生成。

### P3b 后端验证记录（历史快照，strict display/shared/UI 交接已完成）

- 新增 17 个 node:test（core 原 3 → 19，bootstrap 原 29 → 30）；本域 49/49 通过。
  真正启动 bootstrap run service + 沙箱 + 内存 journal 验证 launch.holes=[1]、补全后
  nested hole-filled.holes=[3] 与 actor 出生阶段；不是仅验证 mock fill 成功。
- `pnpm -r --filter './apps/zcode-cli/packages/*' build` exit 0。
- 同过滤器 `test` 最后一次 exit 1：contracts/test/holes-display-contract.test.ts 引入 vitest，
  该包入口是 node:test，报 runner `config` undefined；此前未有该并行新文件时递归 125 个测试通过。
- 最后一次 `pnpm typecheck` / `pnpm lint` / `pnpm fmt:check` 全为 exit 0；
  `pnpm architecture:check --changed` 前后 exit 0、violations/baseline/new 均为 0。
  core lint 与 bootstrap `oxlint src --no-ignore` 也 exit 0（bootstrap 的普通 lint 脚本
  因根 ignore 报 No files found，exit 1，不能视为通过）。日志保存在 `/tmp/holes-backend-*`。
- 曾遇到并行 shared 测试跨 rootDir 导入、UI 超行数/格式失败，已在最后一轮检查消失；
  未修改它们。typecheck 曾产生 contracts/src 临时 emit 文件，该域负责者现已清理。
- 待跨域同步：shared/UI 读取 display.fill，但 contracts 的
  `src/tools/tool-result-metadata.ts` create_workflow strict schema 尚无 fill；后端当前不冒险
  添加额外 display 键（现有输出根 fill 块与图、批准输入 hole.effective_script 已有数据）。
  同步 schema 后可在现有 createCreateWorkflowDisplay 中搬运 fill，不另建 display kind。
- 未执行 UI/E2E；本域不生成 diagnosticLogCatalog，最后由指定负责者统一生成。

### P3a 范围与验收（本期）

**范围**：

1. **分析层留白集成**（`apps/zcode-cli/packages/dynamic-workflow/src/analysis/**`）：
   - 新落 `site-phases.ts`，导出 `collectPhaseNames(flow)`（run 声明阶段表 + 开放留白下标）与
     `collectSitePhases(core)`（站点 → 词法出生阶段名）。
   - 把留白接进时序走查与控制流投影：`causality-order-{types,state,calls}.ts` 的 `walkHole` /
     `mintHolePhase` / `fillStack`、`causality-order.ts` 的开放留白步、`core.ts` 的
     `CoreHoleSite` / `CoreSites.holes`、`interpret.ts` 的站点铸造、`flow-phase.ts` 的
     `collectFlowHoles` 与 `fill` 传播、`flow-graph.ts` 的 `FlowHole` / `ControlFlowGraph.holes`。
   - 关键结果：**控制流投影的阶段表纳入留白名**（留白按名字站在它的位置上），于是
     `createWorkflowPhaseNames(causalityGraph)`（contracts，读的就是 `flow.phases`）与
     bootstrap 的 `openHoleIndexes` 对现有脚本能返回**真实下标**——`run-launched.holes` /
     `hole-filled.holes` 从此真实生效。
2. **shared v4 归约**（`packages/shared/src/zcode-protocol-v4/**`）：新落 `workflow-runs-holes.ts`
   （`readPhaseHoles` / `readPhaseNames` / `reduceHoleReached` / `reduceHoleFilled` /
   `withoutWaitingHoles`），`workflow-runs.ts` 补 `WorkflowRunHole` schema、`maxHoles` /
   `maxHoleTypeLength` / `maxHolePromptLength` 上限与 `phaseHoles` / `holes` 字段；
   `workflow-runs-reducer.ts` 接 `hole-reached` / `hole-filled` 分支、终态剥 `waiting`；
   `workflow-runs-phases.ts` 搬运 `phaseHoles`；`workflow-runs-started.ts` 新一世剥 `waiting`。
   reducer 保持纯函数，越界 / 重复下标一律丢弃。

**所有者**：

- 开放留白名进阶段表的所有者是控制流投影（`flow.phases`）；`collectPhaseNames` 只读它，
  用 `flow.holes` 标出哪几站是还开着的留白。
- 站点 → 出生阶段名（引擎戳）的唯一所有者是分析层 `collectSitePhases(core)`：issue 与 actor
  两种出生事件都按词法阶段盖戳；一个站点落在多个阶段则不进表。
- v4 留白状态的所有者是 `workflow-runs-reducer.ts` 的分支；`waiting` 的真相在引擎停驻表，
  归约只搬运事件，终态 / 新一世剥 `waiting`，`filled` 跨世保留。

**本期覆盖的验收场景**（编号沿用上文「验收场景」）：

- 场景 4 的**数据链**：阶段表含留白名 → `collectPhaseNames` 给出 `holes` 下标 →
  `run-launched.holes` / `hole-filled.holes` 真实在场；journal 的 `hole-reached` /
  `hole-filled` 在 shared v4 归约成 `WorkflowRunHole`。
- 场景 5 的**归约侧边界**：`readPhaseHoles` 丢越界 / 非整数 / 重复下标并按 `maxPhases` 截断；
  name 按 `maxPhaseNameLength`、type 按 `maxHoleTypeLength`、prompt 按 `maxHolePromptLength`
  （499 + `…`）截断；`holes[]` 按 `maxHoles` 拒新并置 `truncated`。
- 场景 6 的**生命周期**：`run-settled` 与新一世 `run-started` 都剥掉 `waiting` 记录，
  `filled` 记录跨世保留；`withoutWaitingHoles` 一条不剩时整个键摘掉。

**本期不做（→ P3b）**：UI 时间线虚线灯、通知行、补全工具行、确认窗、`phaseAlongside` 的
`+k` 右移视觉、`CreateWorkflowOutput.holes[]` / `Step.fill` / `phaseStreams` 展示面、
`workflowNotification` manifest 的 `kind: "hole"`。

### P1 移植记录（与上游 `aac47556` 对照）

**整文件移植（内容与上游一致，导入路径按本仓库规范、去掉遥测/商业引用）：**

- `dynamic-workflow/src/analysis/hole-id.ts`
- `dynamic-workflow/src/analysis/hole-sites.ts`
- `dynamic-workflow/src/analysis/hole-splice.ts`
- `dynamic-workflow/src/engine/engine-holes.ts`
- `dynamic-workflow/src/facade/dts-hole.ts`（只进完整 facade，不进 snippet facade）
- `dynamic-workflow-runtime` 的 `protocol.ts` / `harness.ts` / `child-source.ts` 的 hole hunk
- `contracts/src/interfaces/dynamic-workflow-run-hole.port.ts`
- `contracts/src/tools/fill-workflow-hole.ts`

**hunk 合并（同名文件只取留白相关改动，其余本仓库自有改动保留）：**

- `analysis/sites-labels.ts`（`Counter` → `SiteCounters`）、`analysis/sites.ts`（留白站点条目）、
  `analysis/facade-misuse.ts`、`analysis/analyze.ts`
- `compiler/compile.ts`（`SCRIPT_PRELUDE_LENGTH`）、`facade/registry.ts`（`hole` 进站点函数清单）、
  `facade/dts.ts`（拼入 `FACADE_HOLE_SEGMENT`）
- `lowering/lower.ts`、`engine/engine.ts`、`engine/engine-state.ts`（仅 `journal.updateRunScript` 接缝）、
  `engine/engine-phase-stamp.ts`、`engine/engine-launch.ts`、`engine/journal-memory.ts`、
  `engine/types.ts`
- `contracts/src/interfaces/dynamic-workflow-run.port.ts`、`contracts/src/tools/get-workflow-run.ts`
- `dynamic-workflow/src/index.ts`、`dynamic-workflow/src/engine/index.ts`

**本期不做（留给后续分期）：** `shared` v4 归约、UI、`analysis/{core,interpret,causality-*,
flow-graph,site-phases,actor-models}.ts` 的图/阶段集成、fill 文件落地策略与权限。

### P2 移植记录（与上游 `aac47556` 对照）

**新增文件：**

- `bootstrap/src/app/dynamic-workflow-run-holes.ts` — 纯合成规则：`compiledHolesOf`、
  `openHoleIndexes`、`readRunHoleEvents`、`phaseNamesFromEvents`、`projectRunHoles`、
  `coldCompiledHoles`、`runHolesOf`、`mapFillDiagnostics`。无 I/O、无状态。
- `bootstrap/src/app/dynamic-workflow-run-compile.ts` — 把 `compileOnce` / `compileProgram` /
  `boundedResumeDiagnostics` 从 `dynamic-workflow-run-submit.ts` 拆出，并新增
  `collectSitePhasesOf` / `phaseNamesOfFlow` 两条宿主侧投影；`CompiledDynamicWorkflowScript`
  补 `holeBodies` / `holes`。
- `bootstrap/src/app/dynamic-workflow-run-fill.ts` — `fillDynamicWorkflowHole`：同一 run 的补全
  串行化、拼接 / 编译 / 稳定性校验 / 交引擎 / 改草稿。拒绝即零副作用。
- `core/src/tool/handlers/fill-workflow-hole.ts` / `-description.ts` / `-resolve.ts` /
  `-splice.ts` — 工具声明、描述、`resolveInput`、`path` 来源归一化与确认窗预览。
- `core/src/runtime/methods/dynamic-workflow-run-hole-notification.ts` — `hole-reached` →
  恰好一条模型可见通知；`hole-filled` 不发。

**hunk 合并（本仓库自有改动保留）：**

- `bootstrap/src/app/workflow-run-control.ts`（控制面加 `fillHole` / `openHoles`）
- `bootstrap/src/app/dynamic-workflow-run-observation.ts`（`RunRegistryEntry.holes` /
  `phaseNames`、快照 `holes[]` 投影）
- `bootstrap/src/app/dynamic-workflow-run-introspection.ts`（详情面 `holes[]`）
- `bootstrap/src/app/dynamic-workflow-run-service.ts`（端口 `fillHole` + `fillQueues`）
- `bootstrap/src/app/dynamic-workflow-run-submit.ts`（`run-launched.holes`、条目 `holes` /
  `phaseNames`、resume 从事件读回阶段表）
- `bootstrap/src/app/dynamic-workflow-run-launch.ts`（`CompiledDynamicWorkflowScript` 新字段）
- `contracts/src/tools/create-workflow.ts`（`CreateWorkflowOutput.fill`）
- `core/src/tool/handlers/get-workflow-run.ts`（模型面 `holes[]`）
- `core/src/tool/handlers/{workflow-path-source,workflow-drafts,workflow-draft-read-state}.ts`
  与 `core/src/tool/read-file-state-metadata.ts`（导出补全需要的路径/铸名函数，登记
  `FillWorkflowHole` 为作者工具）、`core/src/tool/handlers/index.ts`（注册工具）、
  `core/src/runtime/methods/dynamic-workflow-run-progress.ts`（接上留白通知）
- `core/src/runtime-task/workflow-notification-copy.ts`（`formatWorkflowHoleNotification`）

**P2 时点与上游的历史偏差（以下保留当时快照，非当前 TODO）：**

当前已删除 bootstrap 重复投影并复用分析层公共接口（含 actor 盖戳），阶段下标、通知 manifest、
fill 文件/权限/完整审批预览与 strict display.fill/phase/step fill 已接通（1–7 的本地能力偏差
已收尾）。第 6 项的 model_bindings 检查与第 8 项的上游 hole 数据依赖完整图未做，仍属非目标；
不把这些排除项写成 parity 已完成。原始条目保留如下：

1. **`collectSitePhases` / `collectPhaseNames` 已在 P3a 落于分析层**
   （`dynamic-workflow/src/analysis/site-phases.ts`）。但 bootstrap 的宿主等价投影
   `collectSitePhasesOf` / `phaseNamesOfFlow`（`dynamic-workflow-run-compile.ts`）**本期保留**：
   P3a 的允许改动目录只含 `dynamic-workflow` 与 shared v4，不含 `bootstrap`。两者规则一致
   （`collectSitePhasesOf` 现在还会漏 actor 站点——P3a 已给 `ActorEvent` 补 `phase`，切到
   `collectSitePhases` 后 actor 站点也会被盖戳）；切换与删除重复实现留给 P3b / 后续。
2. **`ActorEvent` 已由 P3a 补上 `phase` 字段**（上游形状）并接入 `walkCall`，所以
   `collectSitePhases` 对 issue 与 actor 都盖戳；bootstrap 的 `collectSitePhasesOf` 只盖 issue
   是旧实现的偏差，不是分析层的。
3. **分析层留白集成已落，`openHoleIndexes` 对现有脚本能返回真实下标**：`flow.phases` 现含留白名，
   `flow.holes` 由 `collectFlowHoles` 给出，`collectPhaseNames` 据此算 `holes` 下标。
   `run-launched.holes` / `hole-filled.holes` 从「暂时缺席」变为真实生效。
4. **`CreateWorkflowOutput` 只加 `fill` 块，不加 `holes[]` / `Step.fill` / `phaseStreams`。**
   图展示面（display 契约）属 P3b。
5. **通知只发模型可见文本，不带 `workflowNotification` manifest。** manifest 的 `kind: "hole"`
   要 UI 与 shared v4 schema 同步（属 P3b）；P2 只落 `formatWorkflowHoleNotification` 文本。
6. **fill 文件落地、权限确认窗与 `model_bindings` 检查未落。** P2 的 `resolveInput` 只归一 `script`
   / `path` 与 `hole` 事实块、拼确认窗预览；内联提交写 fill 文件、`fill_unchanged` 之外的 fill 文件
   生命周期、`allScriptModelsBound` 与权限 owner 放行留到 P3b（见报告）。
7. **`run-launched.holes` 由提交方按编译产物与声明表算出**（`openHoleIndexes`），与上游同规；
   resume 的阶段表从 `run-launched` / 最后一条 `hole-filled` 读回。
8. **P3a 按上游最小子集移植，不搬 `holeData` / `hole-flow` 数据边与站点图 hole 节点。**
   `CoreFacts.holeData`、`graph.ts` 的 `hole` 站点节点、`causality-graph.ts` 的 `hole` step 与
   `Step.fill`、mermaid / serialize 的 hole 行都**未搬**：它们服务的是数据依赖图与展示，不是
   本期的阶段表 / v4 归约。`collectFlowHoles` 只读 `core.sites.holes`，与这些无关。

**P2 测试：**

- `bootstrap/test/dynamic-workflow-run-holes.test.ts` — 补全成功路径、`run_not_found`、
  `hole_not_waiting`（未知 id / 已补 / not live）、`compile_failed` 草稿不动、`checkSiteStability`
  的 `fill_ids_unstable` 判据、快照 `holes[]` 两态与 32 条上限、`compiledHolesOf`。
- `core/test/dynamic-workflow-run-hole-notification.test.ts` — 每条 `hole-reached` 恰好一条通知、
  `hole-filled` 不发、端口缺席时通知照发。

### P3a 移植记录（与上游 `aac47556` 对照）

**整文件移植（内容与上游一致）：**

- `dynamic-workflow/src/analysis/site-phases.ts` — `collectPhaseNames` / `collectSitePhases`。
- `packages/shared/src/zcode-protocol-v4/workflow-runs-holes.ts` — `WORKFLOW_HOLE_SITE_ID_PATTERN`、
  `readPhaseHoles` / `readPhaseNames`、`reduceHoleReached` / `reduceHoleFilled`、`withoutWaitingHoles`。

**hunk 合并（只取留白相关改动，其余本仓库自有改动保留）：**

- `analysis/causality-order-types.ts`（`PhaseInfo.fill`、`ActorEvent.phase`）
- `analysis/causality-order-state.ts`（`holeByCall` / `holePhases` / `fillStack`、开放留白进
  `realSteps` / `callByStep`、`phaseIdOf` 的 `.size` 编号与 `fill` 盖戳）
- `analysis/causality-order-calls.ts`（`walkHole` / `mintHolePhase`、actor 事件盖阶段）
- `analysis/causality-order.ts`（`stepSites` 纳入开放留白）
- `analysis/core.ts`（`CoreHoleSite` / `CoreSites.holes`、`isActorSite` 按最后一段判种类、
  core 文本的 `hole` / `fill=` 行）
- `analysis/interpret.ts`（开放留白站点铸造）
- `analysis/flow-phase.ts`（`collectFlowHoles`、`FlowPhase.fill` 传播）
- `analysis/flow-graph.ts`（`FlowHole`、`FlowPhase.fill`、`ControlFlowGraph.holes`）
- `analysis/core-json.ts`（老样例包缺 `holes` 时按空表解码）
- `dynamic-workflow/src/index.ts` / `projections.ts`（导出新符号）
- `packages/shared/src/zcode-protocol-v4/workflow-runs.ts`（`WorkflowRunHole`、上限、`phaseHoles` / `holes` 字段）
- `packages/shared/src/zcode-protocol-v4/workflow-runs-phases.ts`（`run-launched` 搬 `phaseHoles`）
- `packages/shared/src/zcode-protocol-v4/workflow-runs-reducer.ts`（两个分支 + 终态剥 `waiting`）
- `packages/shared/src/zcode-protocol-v4/workflow-runs-started.ts`（新一世剥 `waiting`）
- `packages/shared/src/zcode-protocol-v4/index.ts`（导出 holes 模块）

**P3a 测试：**

- `dynamic-workflow/test/site-phases.test.ts`（`node:test`）— 阶段表含留白名与 `holes` 下标、
  P2 `openHoleIndexes` 规则复算相等、空词汇表、已补全留白、嵌套留白与 `fill`、`collectSitePhases`
  的 issue / actor / 开放留白 / 跨阶段 helper。
- `packages/shared/src/zcode-protocol-v4/workflow-runs-holes.test.ts`（vitest）— `readPhaseHoles`
  的越界 / 非整数 / 重复 / 截断、`reduceHoleReached` 的 upsert / 上限 / prompt 截断 / 纯函数、
  `reduceHoleFilled` 的 filled 翻转 / `phaseAlongside` 右移 / 越界下标、`withoutWaitingHoles`、
  以及 `reduceWorkflowRunsState` 全链路的 `run-launched` → `hole-reached` → `hole-filled` /
  `run-settled` / `run-started`。
