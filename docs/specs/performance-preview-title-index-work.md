# 预览卡片标题查询的调用内索引

## 已确认问题与授权范围

`packages/ui/src/lib/assistantPreviewCards.ts` 的 `buildAssistantPreviewCardsFromReferences` 遍历正文中全部 localhost URL。没有匹配本轮变更文件的 URL，会逐项调用 `getWebsiteTitleFromMarkdownLink`，从头 `matchAll` 同一正文的 Markdown 链接；最终 15 张候选上限在排序和去重后应用，不能限制此前的重复扫描。

真实调用链为 `ConversationTurnGroup` 的普通 `ConversationTurnFlow` / 后台 `ConversationBackgroundResultWork` → `useAssistantPreviewCardsForAssistantTextRow` → 此纯函数。hook 已按终态正文、文件引用、解析根与文件变更 memo；本次只消除一次有效派生内的重复标题查询，不重复计算第八轮已修复的 changed-path 索引，也不改变 hook、JSX、订阅、布局或 UX。

协调方单项授权仅覆盖原本 clean 的该生产文件、新性能回归文件、固定参考算法 fixture 和本规格。参考算法从新测试中独立保存，便于保持每个测试文件的职责与规模；它只用于对照，不成为生产依赖。保留所有已有本地改动及既有测试；不改 CI，不提交、推送、构建、运行浏览器或发布外部内容。开工前 `architecture:check --changed` 为 violations / baseline / new = 0 / 0 / 0；legacy `ui` 的受控上下文没有独立 module/contract 文件，规则以当前公开共享入口、现有性能规格及实际源码为准。

## 所有者与严格等价边界

- 会话投影与原 hook 继续拥有事实、异步请求和失效；标题表只是本次同步纯函数调用的局部派生，不保存于模块、React state 或永久缓存，不增加第二条事实写入路径。
- 首次实际需要 Markdown 标题时创建调用内 `href → 首个有效 title` Map 和单向链接迭代器。只扫描到当前 URL 的首个有效标题；沿途标题保留在索引，后续查询继续迭代而不从头重扫。单 URL 的前部命中保持原提前停止，扫描耗尽后负查询不再扫描。未出现合法 localhost URL、远控抑制、或所有 URL 已命中 changed file 时，不创建迭代器或扫描 Markdown 标题。
- `cleanMarkdownLinkTitle`、原 Markdown 正则、`normalizeMarkdownHref` 和 `normalizeTrailingUrlText` 不改。标签的空白折叠、trim、80 字符上限、格式符号/纯标点/URL 标签拒绝以及中文字符规则保持原样。
- Map 键按规范化后的 href 精确字符串比较，不做 URL 重新序列化、大小写折叠、percent decode 或新增代码保护。同 href 保留第一个通过原标签校验的条目；前面的无效标签不阻止后续有效标签。相同标题/URL 重复仍按原规则处理。
- 文件路径命中仍优先以 leaf 作为标题；未找到合法 Markdown 标题仍调用原 URL fallback。URL 校验、localhost/HTML 优先级、文件引用解析、changed-path 首见和 leaf 歧义规则均不变。
- 保留完整候选的 position、稳定排序、seen key、去重与 15 张上限，以及返回对象形状、空结果和冻结输入不变。下一次调用重新读取本次正文，不能沿用前次标题。
- 不触碰协议、持久化、workspaceIdentity/path、owner/lease、stale run、Desktop continuous 或 mobile replayable 语义。

```text
原终态正文 / 原文件变更事实 → 原 hook memo → 单次 builder
                                            ├ 命中文件 / 被抑制 → 不建标题表
                                            └ 首次需标题 → 局部首个有效 href 索引
                                                        → 原 fallback / 排序 / 去重 / 15 张截断
```

## 验收与证据

1. 新测试使用 `packages/ui/test/fixtures/performance-preview-title.reference.ts` 固化改动前的完整 builder 和标题查询函数，仅复用未修改的路径/卡片 helper；内存转译当前模块并替换为固定原 builder，禁止依赖修改后的 HEAD 或维护第二套索引算法作为 oracle。
2. 先跑旧生产函数：所有完整输出对照应通过，重复扫描工作预算应失败。输入正文是不可变字符串，引用与 options 冻结；用实际生产函数的 Markdown `matchAll` 次数及迭代命中数计量，不用墙钟阈值判断通过。
3. 覆盖重复 href 首个有效标签、空/非法/超长/URL 标签、大小写与 query/hash 精确匹配、角括号和尾标点、Unicode、旧代码区域匹配、filePath 优先、HTML/Office/PDF 混合、空正文、远控抑制、无标题 fallback、候选排序/重复/超过 15 张、替换正文和跨调用不缓存。
4. 多 URL/多链接正文最多进行一次标题扫描；不需要标题的分支为零次。计量仅代表此调用内工作，单 URL 前部已命中的旧查询可能更早停止，不宣称所有小输入或整体应用一定更快。
5. 使用 Node 24.14.0、PowerShell 7 和 `corepack pnpm`，在现有 `packages/ui/vitest.config.ts` 下执行新测试与既有 `performanceRound8PreviewCards.test.ts`、`assistantFileReferenceRoot.test.ts`；执行本轮四文件定点格式与定向 lint。根 typecheck/lint/architecture 最终由主代理统一报告真实结果。

## 实施与实测

- 旧生产函数初次新增回归 **6 通过 / 2 预算失败**；主代理追加单 URL 前部早停和负查询后的已知标题重用，旧实现 **7 通过 / 3 预算失败**。全部完整输出对照通过，失败仅为重复扫描预算。
- 最终实现不是首次查询就完整扫描正文，而是惰性创建同一次调用内的单向迭代器。查询只推进到当前 URL 的首个有效标题，沿途保存其他首见合法标签；耗尽后返回已保存标题或 null，不重扫。没有更改 regex、清理 helper、候选顺序或返回字段。
- 32 个 URL、512 个无关链接和 32 个目标链接：Markdown `matchAll` **32 → 1 次**，遍历匹配 **16,912 → 544 次**；64 个未命中 URL 与 512 个无关链接：**64 → 1 次**、**32,768 → 512 次**。输出、标题、15 张上限和最新优先顺序与固定旧算法完全相同。
- 单个 URL 的第一个合法标题位于正文前部时，两版均只遍历 **1 个链接**，不扫后面的 512 个无关链接。没有合法 URL、远控抑制及文件标题已命中的分支仍 **0 次标题扫描**。
- 新文件包含 **10 项功能/预算 + 1 项无速度阈值的局部基准**，最终新文件 **11/11 通过**；连同既有两文件合计 **22/22 通过**，不重复计算各次重跑。固定参考算法独立于当前 HEAD，不从优化后的 builder 推算预期。

### 局部基准

真实前后 builder，Windows / Node 24.14.0；4 对预热、前后交替 15 对采样取每次调用中位数，合成数据，不包含 hook 渲染/服务 IO/网络。最终复验如下：

| 合成正文                            | 旧实现 ms | 当前实现 ms |
| ----------------------------------- | --------: | ----------: |
| 单 URL 前部标题，512 个后续无关链接 |  0.014496 |    0.014706 |
| 32 个后部标题，512 个前部无关链接   |  8.047420 |    0.428920 |
| 64 个负查询，512 个无关链接         | 16.101660 |    0.538160 |

单 URL 差异约 0.00021ms，不据此声称小输入一定更快；新迭代器避免了初始整表方案会带来的全文扫描退化。微基准没有时间通过阈值，不能换算整体应用提升。

### 最终验证

- 本轮生产只改该文件 **+23 / -8，净增 15 行**；测试、reference fixture 和 spec 不进入运行时依赖。
- 根 typecheck/lint/architecture 全通过；本轮三 TS 文件定向 lint **0 warning / 0 error**。UI 工程不包含 test 目录，另外使用现有 tsconfig/别名/ambient declarations 的内存 CompilerHost 严格检查新测试及参考 fixture：**752 文件、0 diagnostics**。初次发现 spy 隐式 this 注解，已只补该新测试 `this: string`，没有放宽类型规则。
- 四文件格式与全仓格式、diff 空白检查通过；性能 / V4 / RPC / Server / mobile 整合回归 **91 文件、707/707 通过**。原有 **135 个本地 changed 文件 SHA-256 全部保持**。
- 没有修改 hook、JSX、订阅、交互、默认配置、协议或持久化；没有浏览器 GUI / 真实应用 E2E / macOS / 实体手机或整机 CPU、heap 采样。源码派生与组件既有回归不能描述为完整 GUI 验收。没有提交、推送、打包、安装、改 CI 或触发 Actions。
