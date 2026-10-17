# 本轮性能扫描与修复结果

本轮确认并修复了代码高亮按主题重复保留引擎的问题。保留开工前已有的性能优化与其他未提交改动；本轮生产代码只修改 `packages/ui/src/lib/shikiHighlighter.ts`，相对开工内容增加 30 行、删除 20 行，净增 10 行。

## 结果

使用真实 Shiki 4.0.2、无头 Edge 155.0.4283.45、12 种语言及 GitHub 明暗主题，修改前后各在新建浏览器上下文运行一次。先完成模块导入并强制 GC，随后高亮 24 组内容，再强制 GC 读取 CDP `Runtime.getHeapUsage.usedSize`。样本只包含合成源码。

| 指标                           |                      修改前 |                      修改后 |
| ------------------------------ | --------------------------: | --------------------------: |
| 高亮器实例数                   |                          24 |                          12 |
| 高亮阶段 JS 堆增量             | 9,983,336 bytes（9.52 MiB） | 6,522,384 bytes（6.22 MiB） |
| 首次 24 组高亮耗时             |                   1336.4 ms |                    839.2 ms |
| 再运行 3 轮后的 token 缓存项数 |                          96 |                          96 |
| 再运行 3 轮后的 token 数       |                        1696 |                        1696 |
| 完成后在途高亮任务             |                           0 |                           0 |

此样本的 JS 堆增量减少 **3,460,952 bytes，约 3.30 MiB**。24 组完整 token、原文、颜色的 SHA-256 全部一致；修改后另验证了 72 个并发新输入，在主题交错时原有行的 token/颜色仍一致，主题加载在途记录回到 0。纯文本旁路、别名、完整源码键和原有 token 缓存预算保持。

这里的堆增量包含语法模块和高亮相关 JS 对象，不包含整棵 Electron 进程树、GPU、所有原生/WASM 分配。时间包含按需模块加载，仅各测一次，不能作为稳定 CPU 加速比例；也不能把约 3.30 MiB 的局部收益说成解决了应用的总体高内存占用。原始数据见 `before.json`、`after.json`。

## 兼容性决策

高亮模块继续拥有引擎、token 缓存和在途表。每个规范化语言保留一个引擎，各主题按需加载；并发请求共享同一初始化/主题加载 Promise。初始化失败只清理对应语言，主题失败只清理相应加载记录，后续请求可重试，不自动重试、不新增定时器。每次 tokenize 同步传入明确的语言和主题。

跨语言共享单一引擎的候选方案曾测得更少实例，但真实对照发现 Markdown 的 lazy embedded grammar 会因先加载 TypeScript 等语言而改变围栏颜色，两组 Markdown 哈希不一致。因此未采用跨语言共享，证据保留在 `single-engine-probe.json`。最终按语言隔离的实现通过全部输出比对，不用例外分支掩盖差异。不同语言的语法仍会按需常驻，没有宣称高亮器有固定字节上限。

## 扫描范围

- 复核了现有性能规格与整机测量记录，并检查高亮、会话行池、会话数据层、行高与时间标签缓存、附件 Object URL、分享导入导出缓冲、终端关闭和进程等待、Host API 连接池及若干服务 Map 的生命周期。
- 已存在的 token 预算、行池弱引用、URL 撤销、导入导出槽位限制、终端关闭检查和进程回收路径继续保留，不把这些旧改动记作本轮成果。
- 终端 profile 的同步系统探测、代码片段离屏后仍可能完成的在途高亮等仍是候选，本轮没有受控负载证据证明其在用户当前环境的贡献，未追加推测性修改。
- 这属于本轮源码扫描与局部实测，不是所有功能、长会话、安装版 Electron 或所有平台的完整性能审计。

## 验证

| 检查                                         | 结果                                                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 高亮专项 Vitest                              | 2 文件 / 15 项通过；新增 5 项覆盖主题并发、失败重试、语言隔离、迟到初始化及缓存复用                       |
| 整合 Vitest                                  | 64 文件 / 392 项全部通过；含现有性能、RPC/server/client、终端、浏览器生命周期、会话结构共享及手机协议回归 |
| 真实 Shiki 浏览器对照                        | 通过；24 组输出一致、72 个并发新输入一致、0 页面错误、0 外站页面资源请求                                  |
| 真实 MessageResponse 浏览器回归              | 通过；240 围栏，桌面/手机宽度、复制、选择、折行、明暗主题、查找 Range、离屏释放、流式结束及迟到结果       |
| 根 `corepack pnpm typecheck`                 | 通过                                                                                                      |
| 根 `corepack pnpm lint`                      | 通过；3046 文件，0 warnings / 0 errors                                                                    |
| `corepack pnpm architecture:check --changed` | 通过；0 violations / 0 baseline / 0 new，未调整 baseline                                                  |

MessageResponse 回归运行后段与全仓静态检查短暂重叠，其耗时不用于提速结论。新的 Shiki 前后对照采样没有同时运行这些检查。首次新浏览器夹具因 Vite 中间件注册位置错误返回非 200，修正夹具并收窄依赖扫描入口后重新采样；此失败不算产品问题。

复现当前版本的专项检查：

```powershell
corepack pnpm exec vitest run --config packages/ui/vitest.config.ts packages/ui/test/performanceShikiEngine.test.ts packages/ui/test/performanceFrontendHighlight.test.ts
node scripts/ci/performance-shiki-browser.test.mjs --compare=docs/performance/shiki-2026-10-17/before.json
node scripts/ci/performance-chat-code-browser.test.mjs
```

浏览器脚本的 `--baseline` 只放宽优化后的实例数断言，用来在修改前采集基线；它不会切换源码，不能在当前源码上借此重新生成“修改前”数据。

## 环境与清理

远端 freshness fetch 因网络连接重置失败；`--no-fetch` 显示本地记录 main 与 origin/main ahead 0 / behind 0，无法据此确认远端实时状态。运行时 Node 24.18.0，与 `mise.toml` 固定的 24.14.0 有差异；pnpm 为 10.33.2，未安装或切换持久运行时。

测试只使用 mock、合成数据和临时浏览器 profile/cache。浏览器与 Vite 在测试的 finally 中关闭，临时 cache 已删除。未启动已安装 ZCodium、真实 Agent 或模型 API，未读写用户业务配置，未停止用户已有进程；没有构建安装包、下载 artifact、触发 Actions、提交或推送。保留的 JSON 仅是小型测试测量证据，不是构建产物。
