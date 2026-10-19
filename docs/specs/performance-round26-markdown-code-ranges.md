# 第二十六轮性能优化：Markdown 代码区间查询与复用

## 范围与基线

保持产品功能、Markdown 解释规则与交互不变，只优化 `ui` 模块内的纯文本派生计算。保留工作区既有手机远控及工作流改动，不提交、推送或打包。

freshness 的 fetch 因 GitHub 连接重置失败；`--no-fetch` 显示本地 main 相对缓存 origin/main ahead 0 / behind 0，不能据此确认远端最新状态。架构初检 violations / baseline / new 为 0 / 0 / 0，已读取 ui 与 services 受控上下文。Node 24.18.0，与 mise.toml 的 24.14.0 不同，不调整本机环境。

## 已确认开销

`findMarkdownCodeRanges` 已顺序提取有序、不重叠的围栏范围，却在逐字符处理行内反引号时，对每个候选起点和终点用 `some` 遍历所有围栏。围栏和反引号同时增加时，范围比较可达平方级；围栏内部也会重复逐字符扫描。调用方包括代码评论、文件引用、Gen UI 和分享 Markdown。

`projectAssistantCodeComments` 的流式路径先在提取完整评论时计算代码区间，再为未闭合指令计算相同文本的代码区间，同一次同步调用重复解析两次。

## 设计和兼容性

- 文本事实仍由既有会话投影提供，解析器只返回派生区间；不增加 store、跨调用缓存、异步任务、公共接口或跨包依赖。
- 原有围栏识别和 HTML code/pre 识别完全保留。行内扫描用原生 `indexOf` 跳到反引号，围栏有序且不重叠，扫描起点用单向游标跳过已知围栏的剩余内容；候选闭合点用二分查找判断是否落在围栏内。
- 保留 LF、CRLF、CR 的原始 UTF-16 下标、0–3 空格缩进、反引号/波浪线类型、围栏长度、关闭行尾空白、未闭合围栏一直保护到末尾的规则。
- 行内代码仍按原 `indexOf` 找第一个包含相同长度反引号的候选；即使旧行为允许较长闭合串、跨行或跨短围栏，也不在性能任务中调整 Markdown 语义。首个闭合候选位于围栏内时，仍跳过本次起始标记，不继续寻找下一个候选。
- HTML 区间保持原扫描规则，再与围栏和行内范围按原方式排序、合并。区间端点继续是左闭右开，重叠和相邻区间合并。
- 同次代码评论投影只解析一次代码区间，完整评论与流式尾部处理共享该局部结果；新文本每次重新解析。卡片创建入口仍独立解析自己的输入。
- 指令参数、隐藏规则、代码评论卡片字段和路径、文件引用、分享的图片处理均不变。没有状态所有权、协议、owner/lease、Desktop continuous 或 mobile replayable 的变化，不新增交互场景。

## 验收

先保存旧解析器为仅测试使用的参考实现，在修改生产代码前执行正确性测试和合成性能基线。

1. 固定种子生成混合 Markdown，并检查流式前缀；新旧区间逐项相等，包含不同换行、缩进、围栏类型/长度、HTML、未闭合标记、跨围栏行内匹配与 Unicode。
2. 用明确期望验证围栏边界、内部指令保护、完整/未闭合代码评论和 citation；保存修改前的评论投影快照，比较流式和终态完整输出。
3. 对短正文、240 围栏长回答和 2,000 围栏压力输入测量同进程新旧解析耗时，并核对完整区间结果。耗时只记录观测，不作为容易波动的 CI 断言，不推算整机提速。
4. 执行既有引用路径、分享、Gen UI 和性能回归，根 typecheck、lint、架构检查及本轮格式检查。纯计算等价优化不启动真实应用或模型，不修改 DOM/交互，无新增应用 E2E 场景。

## 验证结果

- 修改前新增正确性测试 **9/9 通过**，生成原有代码评论完整输出快照；旧实现与参考实现的性能一致。此任务不改变产品行为，因此等价测试在修改前本就应通过。
- 修改后本轮 **10/10 通过**，其中新增工作预算断言验证流式代码评论只调用一次区间解析，完整评论及未完成尾部仍正确。与引用路径、分享 Markdown 和 Gen UI 引用回归合计 **54/54 通过**，旧快照未更新。
- 1,500 份固定种子混合文本、定向边界样例和逐字符流式前缀的新旧区间全部一致。保留较长闭合标记、跨短围栏的行内匹配、首个候选落入围栏等既有规则，没有顺带改成另一套 Markdown 语义。
- 最终同进程 Vitest benchmark 对照如下。每组先核对完整结果；数值为单次函数调用平均耗时，输入为合成文本，不能换算应用整体收益。

| 输入                                      |   旧解析器 |    优化后 |
| ----------------------------------------- | ---------: | --------: |
| 128 UTF-16 字符普通正文                   |  0.0013 ms | 0.0005 ms |
| 240 个围栏、69,729 UTF-16 字符            | 10.0727 ms | 0.3202 ms |
| 2,000 个围栏压力输入、582,889 UTF-16 字符 |  645.06 ms | 2.8220 ms |

短正文处于亚微秒至微秒量级，容易受 JIT/调度影响，仅用于确认没有明显回退。范围查询从逐候选全表扫描改为单向游标及二分查询；这不代表整个 Markdown 解析器对任意畸形输入都有线性复杂度保证。

- 生产改动仅 `ui` 模块两个原本未修改的文件：`assistantDirectiveParser.ts` 与 `assistantCodeComment.ts`，**新增 33 行 / 删除 9 行 / 净增 24 行**。没有新增公共接口、持久化、状态所有者或依赖。
- 根 `corepack pnpm typecheck` 通过；Lint **3,089 文件、0 warning / 0 error**；架构复检 violations / baseline / new 为 **0 / 0 / 0**，生产 diff 空白检查通过。
- 最终性能整合回归 **60 文件 / 421 项全部通过**，单 worker 耗时 **42.86 秒**，包含此前性能回归、引用路径和 Gen UI 引用测试。本轮六个手写文件的格式检查通过；快照由 Vitest 生成并验证。

可重跑命令（仓库根目录，PowerShell 7）：

```powershell
corepack pnpm exec vitest run --config packages/ui/vitest.config.ts --maxWorkers=1 packages/ui/test/performance packages/ui/src/lib/assistantFileReferenceRoot.test.ts packages/ui/src/gen-ui/domain/references.test.ts
corepack pnpm exec vitest bench --config packages/ui/vitest.config.ts --run packages/ui/test/performanceRound26MarkdownCodeRanges.bench.ts
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm architecture:check --changed
```

没有进行应用 CPU/内存或真实会话端到端测量；未打包、启动真实 Agent、操作现用业务数据、提交或推送。Node 和远端基线限制见范围段。
