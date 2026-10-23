# Services 局部只读计算的等价优化

## 已确认调用链与范围

1. `botsService.ts` 的成功终态处理获取原完整任务 snapshot，调用 `readLatestAssistantTurnChangeSummary`，再把摘要交给原 streaming card 或完成回复。该读取函数仅使用最新有 turnIndex 的 assistant 对应摘要，却先通过 `buildPerTurnChangeSummaries` 对全部历史轮次逐文件计算行级 LCS。
2. `ProviderRegistryService` refresh → `ProviderConfigService.read` → `NodePersonalProviderConfigRepository.read` → `#readCurrent`。规范文件读取在规范形态比较和 `snapshotFromUpdate` 中两次编码/序列化同一 decoded update。每次显式读取原始文档一次、规范文档两次；轮询已有的独立读取不在此次优化范围。

只修改上述两个当前 clean 的生产文件，不修改 CI、既有 dirty 优化、RPC Emitter、队列、远端连接或状态时序。不访问用户配置，不提交、推送或构建。

## 所有者与等价边界

- Bot snapshot 仍由原任务服务提供；摘要只是同步调用内的纯投影。保留原 snapshot 获取次数、终态事件队列、正文 flush、回复模式、卡片收口及 Bot continuous 投递规则。Desktop continuous/mobile replayable 不作变更。
- 仅在调用原 `buildPerTurnChangeSummaries` 前按既有目标 turnIndex 筛选；不能只取首项/最后一项，因为重复 turnIndex 的最后非空项覆盖前项，末尾空项不覆盖。保留逐轮同路径聚合、首次 before/最终 after、writeCount、路径排序、LCS 阈值、无改动及 null 语义。输入不修改，不缓存结果。
- Personal 文件仍是唯一配置事实，Repository 是读取、规范化、写入和 observedRevision 的 owner。只在 `#readCurrent` 的规范快路复用当次已经计算的规范字符串给 SHA-256 revision；不缓存到下一次调用，不改变原始文档比较、严格 decode 或编码边界校验。
- 非规范文件仍走原锁内重读/迁移路径；缺失文件、legacy import、非法文件原样保留与恢复回调不变。`#readLocked`、`#writeLocked`、轮询、writeGeneration、事件及文件锁均不修改。revision 格式和 UTF-8 字节完全相同，未声明 providerOrder 仍保持 undefined。

```text
Bot 原成功终态队列 → 原 getTaskSnapshot → latest assistant turnIndex
                                             → 本次匹配轮次 → 原摘要函数 → 原回复/卡片
Personal read → 原异步 readFile/JSON parse/严格 decode
                  → 原始/规范比较（规范字符串一次）
                      ├─ 相等 → 同字符串 SHA-256 → 原 snapshot
                      └─ 不等 → 原文件锁 → 重读/规范化/写入 → 原 snapshot
```

## 回归与工作量

先新增 `packages/services/test/performanceLocalReadWork.test.ts`，在旧实现运行。完整结果、缺失/重复 turn、输入保持、真实临时 Personal 文件读写/错误/规范化断言必须通过；只有历史 diff 次数和规范文档序列化预算失败。

- 100 历史轮次，每轮一个 500×500 行差异文件：diff 调用应由 100 次降为 1 次；LCS 内层工作由 25,000,000 cell 降为 250,000 cell。该输入未超过原 400,000 cell 阈值。
- 规范 Personal 文件每次 read：完整 JSON stringify 从 3 次降为 2 次（原始 1 + 规范 1），ProviderConfigMap.toJSON 从 2 次降为 1 次。真实磁盘读取仍为一次；不宣称减少磁盘 IO。
- 用确定性合成 snapshot 与原全历史算法差分，覆盖重复、非单调 turnIndex、空轮次、多次同路径、null before、Unicode 及缺失 assistant turn。
- Personal 使用自己的 OS 临时目录；验证 revision 与独立规范字节 SHA-256 相同，重复 read、新文件内容、update/read 对齐、非规范键顺序写回、缺失/坏文件和 dispose；finally 清理自己的文件和 Repository。

PowerShell 7 / 仓库根验证入口：

```powershell
corepack pnpm --use-node-version=24.14.0 exec vitest run --config packages/ui/vitest.config.ts --maxWorkers=1 packages/services/test/performanceLocalReadWork.test.ts packages/services/test/performanceProviderNormalization.test.ts packages/services/test/botRemoteBridgeLifecycle.test.ts
corepack pnpm --use-node-version=24.14.0 exec tsx --test packages/services/test/providerConfigMigration.test.ts scripts/ci/local-provider-runtime.test.mjs scripts/ci/personal-provider-provisioning.test.mjs
corepack pnpm --use-node-version=24.14.0 architecture:check --changed
```

根 typecheck/lint 由协调代理统一执行。本任务执行定点 lint/格式、实际回归及架构复检并报告真实结果；不把合成计算预算换算成整机或所有输入的墙钟提速比例。

## 实际结果

- 旧生产实现运行新增回归：3 项功能通过、2 项工作预算失败。Bot 实际 `computeLineChangeStat` 为 100 次；256 Provider 的规范文件 read 实际编码 2 次、完整文档 stringify 3 次。没有改输出、超时或预算来使其通过。
- 最小生产改动只涉及两个文件，共 +13 / -5、净增 8 行。Bot 保留原摘要函数；Personal 仅规范读取分支传递当次字符串，保留原始 stringify 在规范编码前的求值顺序。
- 新回归扩展到 6 项，全部通过：500 组完整摘要差分、重复/空/缺失轮次、同路径聚合、相同内容及原大文件 LCS fallback；真实临时配置核对 revision、重读/编辑、规范化写回、默认选择与缺省排序、坏字节原样保留、更新通知和 dispose。
- Bot 100 次 diff → 1 次，所用 500×500 行输入的 LCS 内层工作为 25,000,000 → 250,000 cell；Personal 规范 read 编码 2 → 1、整份 stringify 3 → 2，真实文件读取和 hash 次数不变。两项均不新增跨请求缓存。
- 新回归加既有 Provider normalization、Bot bridge/runtime 共 4 文件 37 项通过；原生 Provider migration、local runtime、provisioning 共 3 文件 15 项通过。原生用例包含失败回滚、并发编辑、重复分发及无账号网络依赖。
- 新测试额外严格 TypeScript 检查 0 个目标诊断；定点 lint 0 warning/error，架构 violations / baseline / new = 0 / 0 / 0，生产 diff 空白检查通过。根 typecheck/lint 交协调代理执行，不把定点结果报告成全仓通过。
- 未运行完整 Bot provider/真实桌面手机 E2E、付费模型、用户配置或整机性能采样。只清理测试自己的临时目录；未修改 CI、已有无关 dirty 文件，不提交、推送、打包或触发 Actions。
