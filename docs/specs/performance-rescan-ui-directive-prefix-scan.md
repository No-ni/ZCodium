# 流式 directive 前缀探测的回扫窗口收窄

## 问题与边界

`findAssistantDirectivePrefixStart`（`packages/ui/src/lib/assistantDirectiveParser.ts`）用于在流式输出中把"刚打出一半的 directive 名"从正文里暂时隐藏。它从正文最后一个字符开始逐字符反向扫描，每遇到一个冒号就 `content.slice(index)` 取剩余全文，再对每个 directive 名做若干次 `startsWith`。

- 工作量与「正文长度 × 冒号数量」成正比：每个冒号都要做一次 slice（取剩余全文）并对每个 directive 名做若干次 startsWith。因此**累计 slice 覆盖的字符范围**对正文长度是平方级（确定性的操作计数可证明）；但 V8 的 `String.prototype.slice` 可能以共享底层字符数据的方式返回子串，**墙钟耗时与内存占用并不保证同比例平方增长**，本 spec 只用累计 slice 范围 / slice 次数 / startsWith 次数作为工作量证据，不把合成输入的操作计数换算成整机提速比例。
- 长回答（数万字符、上千冒号）里单次调用的 slice 次数与 startsWith 次数都在万级——其中 startsWith 次数只随冒号数量线性增长（每个冒号对每个名字做固定次数的比较），平方级的是累计 slice 覆盖范围；流式期间调用方在**正文文本更新时**重算（不是每个 token 都必然触发，取决于该 token 是否改变了 `rawMarkdown` / `row.text`），累积处理量随消息变长持续上升。
- 调用方（均在依赖正文文本的 `useMemo` 内）：
  - `projectZCodeFileCitations` → `packages/ui/src/components/ai-elements/message.tsx` 的 `MessageResponse`（`projectedCitationMarkdown`）；
  - `projectAssistantCodeComments` → `packages/ui/src/v4/ConversationRowView.tsx` 的 `AssistantTextRowView`（`visibleText`）。
- 本次只改这一个纯函数内部的反扫策略。它是无状态纯函数：不持有状态、不做 IO、无缓存、无异步、无第二条事实来源，因此不涉及 owner/lease、workspaceIdentity、desktop/mobile 语义或任何状态机；本 spec 不画事件图（无状态、无异步变更）。
- 不改交互、不改组件结构、不改可见文案、不改 `DESIGN.md` 相关的任何渲染规则；不触碰 `workspace-file-tree/model.ts`、services/shared/rpc/desktop/server。

## 语义契约（必须逐位保持）

设 `content` 为正文，`index` 为某个「前一个字符不是冒号」的冒号位置，`suffix = content.slice(index)`。旧实现在 `directiveNames.some(...)` 中按名判定以下四类，任一命中即返回**从右往左第一个**命中的 `index`（都没有则 `null`）：

1. 三冒号（仅 `tripleColonNames` 内的名）：`suffix.startsWith(":::")` 且（`":::" + name` 以 `suffix` 为前缀，或 `suffix` 以 `":::" + name` 为前缀且其余字符全是空白）；
2. 双冒号：`suffix.startsWith("::")` 且（`"::" + name` 以 `suffix` 为前缀，或 `suffix` 以 `"::" + name` 为前缀且其余字符全是空白）；
3. 单冒号兼容（仅 `singleColonNames` 内的名，且 `suffix.length >= minimumSingleColonPrefixLength`）：`":" + name` 以 `suffix` 为前缀，或 `suffix` 以 `":" + name` 为前缀且其余字符全是空白）；
4. 候选 `index` 若与 `protectedRanges`（Markdown 代码范围）中的 `[index, index + 1)` 相交则整格跳过；前一个字符是冒号的位置也跳过（冒号串只认最左那个）。

「其余字符全是空白」的判定口径是 `/^\s*$/`（空串也算），与 `\s` 的 Unicode 口径一致。公开参数不约束 `directiveNames` 非空、不去重、不要求名字非空白，因此以下推导对空名、空白名、重复名、名字带内部或尾部空白都成立。

## 修复依据：回扫窗口的下界

记 `maxPrefixLength = 3 + max(len(name))`（三冒号加最长的名），`lastNonWhitespace` 为正文最后一个非空白字符的下标（全空白时为 `-1`）。

**命题**：若旧实现在 `index = p` 命中，则 `p >= lastNonWhitespace + 1 - maxPrefixLength`。

- 情形 A（`suffix` 是某个 `":"×k + name` 的**真前缀**）：此时 `suffix.length <= k + len(name) <= maxPrefixLength`，于是 `p = content.length - suffix.length >= content.length - maxPrefixLength >= lastNonWhitespace + 1 - maxPrefixLength`。
- 情形 B（`suffix` 以完整的 `":"×k + name` 开头且其余全空白）：名之后不再有非空白字符，故 `lastNonWhitespace <= p + (k + len(name)) - 1`（名字本身可以带空白，所以这里只能取 `<=` 而不能写等号），代入得 `p >= lastNonWhitespace - (k + len(name)) + 1 >= lastNonWhitespace + 1 - maxPrefixLength`。

两类都满足同一下界，因此从 `content.length - 1` 回扫到 `max(0, lastNonWhitespace + 1 - maxPrefixLength)` 不会漏掉任何命中位置；又因为旧实现返回的是**最靠右**的命中位置，收窄窗口后返回值逐位相同。

窗口内仍按原顺序、原判定逐格检查（含 `protectedRanges` 与「前一个字符是冒号」两条跳过规则），只把字符串操作换成等价的位置式形式：

- `suffix.startsWith(X)` → `content.startsWith(X, index)`（位置式，不产生中间子串）；
- `X.startsWith(suffix)` → 仅在 `content.length - index <= X.length` 时做 `content.slice(index)`（此时长度已被 `X.length` 封顶），否则 `suffix` 比 `X` 长、判定恒为否；
- `suffix.startsWith(X) && /^\s*$/.test(suffix.slice(X.length))` → `content.startsWith(X, index) && lastNonWhitespace < index + X.length`。「`index + X.length` 及其后全是空白」的充要条件正是「正文最后一个非空白字符的下标小于 `index + X.length`」；该写法不假设名字本身非空白，对带尾空白的名字与全空白名字同样成立。

## 设计与不变量

- 唯一所有者不变：`assistantDirectiveParser.ts` 仍是 directive 语法解析的唯一实现；调用方（`zcodeFileCitation.ts` / `assistantCodeComment.ts`）的入口、参数与返回形状完全不变。
- 不新增模块级缓存、不跨调用留存索引、不引入 debounce/超时/重试；每次调用都从当次输入重新派生。
- `findMarkdownCodeRanges`、`findUnclosedAssistantDirectiveStart`、`extractAssistantDirectives` 本次不改（前者已由 `performanceRound26MarkdownCodeRanges` 专项收敛，后两者是线性扫描且触发条件稀少）。
- 空正文、全空白正文、无冒号正文、`protectedRanges` 全覆盖、空名字列表、空白名、空名、重复名等边界都必须与旧实现一致。

## 验收方案（先红后绿）

1. 先新增回归 `packages/ui/test/performanceDirectivePrefixScanWindow.test.ts`：
   - **行为等价**：把当前实现原样固化为测试内参考实现（oracle，不进入生产代码），与生产函数在结构化边界 + seeded 随机文档 + **代表性正文的每一个流式前缀长度**上逐一比对返回值（differential 随机对照旧函数）。
   - **边界清单**：空名字数组、空白名字、空 directive 名、重复名字、全空白正文、Unicode 空白（含 U+FEFF、NBSP、表意空格、行分隔符）、长尾空白（命中位置被空白推离文末数千字符）、代码范围保护恰好覆盖/部分覆盖冒号串、单冒号最小长度阈值、多个冒号串与多个名字的回扫优先顺序、名字带内部/尾部空白。
   - **工作量预算**：按仓库既有口径计数一次调用内的 `startsWith` 与 `slice` 次数及累计 slice 覆盖字符范围（`packages/ui/test/performanceFileTreeSearchExpansion.test.ts` 同款原型打点法），预算与「最长 directive 名长度 × 名字个数」成正比（两名配置下为 276）。旧实现在 4K/16K/64K 合成正文上分别实测 startsWith 978 / 3,920 / 15,683 次、slice 196 / 784 / 3,137 次，**修复前必须失败**。
   - 投影层不变量：`projectZCodeFileCitations` 与 `projectAssistantCodeComments` 在流式/非流式下的 `visibleText` 与旧实现一致（同一 oracle 口径）。
2. 旧实现上执行：等价项全部通过（证明参考实现忠实）；预算测试在首个 4K 输入即失败（1 项测试覆盖 3 种尺寸，但断言失败会中止循环，不能记为 3 项失败）。独立操作计数另外覆盖 4K/16K/64K，证明问题可复现且不是功能 bug。
3. 最小实现只替换 `findAssistantDirectivePrefixStart` 的回扫与判定，用中文注释说明累计 slice 范围平方级的原因、窗口下界证明与等价依据。
4. 修复后：新回归全绿；既有 `performanceRound26MarkdownCodeRanges.test.ts`（含快照）不回归；`architecture:check --changed` 无新增违规。
5. 全量 typecheck / lint 由主代理统一执行，本代理不重复跑。

## 复现与修复结果（2026-10-31）

- 先红：在未修复的实现上执行专用入口，14/15 通过，唯一失败正是处理预算项（size=4000 startsWith=978 > budget=276）；4 项等价测试在旧实现上全部通过，证明测试内冻结的 oracle 忠实，失败不是功能 bug。
- 后绿：最小实现只替换 `findAssistantDirectivePrefixStart` 的回扫与判定后，同一入口 15/15 通过（新回归 5 项 + 既有 `performanceRound26MarkdownCodeRanges.test.ts` 10 项；入口以确切计数 15 断言，并逐文件校验套件确有执行记录）。
- 操作数（同一组合成输入，确定性打点，不是墙钟）：

  | 正文长度 | 冒号数 | startsWith 旧 → 新 | slice 次数 旧 → 新 | 累计 slice 范围 旧 → 新 |
  | -------- | -----: | -----------------: | -----------------: | ----------------------: |
  | 4,000    |    196 |            978 → 3 |            196 → 0 |             390,823 → 0 |
  | 16,000   |    784 |          3,920 → 5 |            784 → 1 |          6,269,173 → 10 |
  | 64,000   |  3,137 |         15,683 → 3 |          3,137 → 0 |         100,370,819 → 0 |

  旧实现的累计 slice 范围随尺寸放大约 16× / 16×（平方级）；新实现与正文长度脱钩。预算 276（slice 范围 6,072）在回归中锁住该量级。

- 端到端投影中位数（同机 Node 24.18.0，预热后 25 次采样，仅辅助证据）：`projectZCodeFileCitations` 总时长 0.082 / 0.237 / 0.508 / 1.084 ms → 0.013 / 0.019 / 0.043 / 0.066 ms（4K / 16K / 32K / 64K）；其中前缀探测本身 0.068 / 0.228 / 0.493 / 1.021 ms → 0.004 / 0.001 / 0.002 / 0.002 ms，剩余开销主要来自本次未改动的 `findMarkdownCodeRanges`。
- 架构复检 `corepack pnpm architecture:check --changed`：violations / baseline / new = 0 / 0 / 0。
- 唯一生产文件 `packages/ui/src/lib/assistantDirectiveParser.ts`；另新增本 spec、`packages/ui/test/performanceDirectivePrefixScanWindow.test.ts` 与 `scripts/ci/ui-directive-prefix-scan-regression.test.mjs`。无状态所有者、跨模块依赖、公共接口或持久化变更。

## 验证边界

- 回归经专用入口 `scripts/ci/ui-directive-prefix-scan-regression.test.mjs` 在 `project-test-sandbox` 内以真实 vitest 运行；沙箱把 HOME/TEMP/APPDATA/数据目录全部限制在 `.run-logs/project-only-validation/` 内，无链接越界，不读真实用户数据。本测试为纯内存计算，不产生任何文件写入。
- 预算断言用确定性的操作计数，不依赖墙钟；同机合成输入的局部耗时不作为验收条件（Node 24.18.0，本机与 `mise.toml` 固定的 24.14.0 存在偏差，按父代理要求仅报告不改环境），也不能换算成整机提速比例。
- 未执行浏览器 / 桌面 / 手机 E2E：本修复不改变交互与渲染输出，元素与投影层测试不冒充 GUI 验收。
