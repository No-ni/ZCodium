# 本轮性能扫描与已验证修复

## 结论与范围

扫描当前 Desktop、UI/Web、共享协议、服务/Provider/RPC/Server 与 CLI 的性能热点，选择不改变功能逻辑且有明确工作量证据的七项优化。所有生产文件在开工时均无本地改动，保留工作区原有的改动；不提交、推送、构建、发布、调用模型或操作现用业务数据。最多同时两个子代理；子代理完成候选交接后遇到模型服务阻断，后续实现和验证由主线程完成，未继续派发。

## 已修复项

以下为同一合成输入的可复现工作量，不是整机 CPU/内存、端到端延迟或提速百分比。

| 问题                                   | 测试输入                         |                    原工作量 |                                 修复后 |
| -------------------------------------- | -------------------------------- | --------------------------: | -------------------------------------: |
| Gen UI 上下文反复序列化已选前缀        | 100 条有效小状态                 |          5,150 次输出项访问 |                                 100 次 |
| 浏览器恢复窄查询复制所有历史           | 80 页 × 200 history，读一个 page |      16,000 次 history 访问 | 200 次；读 shell/列 shell/缺失查询为 0 |
| Controller 搜索逐项重建并排序全投影    | 96 条搜索结果                    |               96 次全表排序 |                                   1 次 |
| 工作流邻接数组逐边复制前缀             | 800 条星形边                     |        321,200 次字符串迭代 |                               1,600 次 |
| 工作流 collection frontier 逐成员 find | 800 节点全成员                   |     320,400 次 node ID 访问 |                                 800 次 |
| MCP 展开重复解析同一 JSON              | 短 JSON / 长或多行 JSON          |      3 次 / 2 次 JSON.parse |                                   1 次 |
| 手机首页逐工作区重扫任务               | 48 workspace / 1,440 task        | 69,120 次 workspaceKey 访问 |                               1,440 次 |

每项均先更新独立 spec，添加测试并在旧实现复现工作预算失败，再修复。原正确性断言在旧实现本就通过，不把工作预算失败数量冒充功能 bug 数量。

## 不变量与架构

- 修改模块：managed `gen-ui-protocol` 的 domain 实现，以及 legacy `desktop`、`ui`、`web`、`zcode-cli`。无新增依赖边、公共协议、持久化格式或状态所有者。
- 本轮 8 个生产文件（含新建 taskGrouping.ts）新增 114 行 / 删除 68 行，净增 46 行；另有契约说明、8 份 spec 和 8 个测试/参考文件。未将开工时已有改动计入本轮统计。
- Gen UI 保留完整 state/privateContent 校验、100 条预截取、64 KiB UTF-8 原预算、首个超限项停止与原输出文本。
- BrowserTabRecoveryStore 仍拥有 snapshot/mutationQueue；只复制查询命中项，保留原浅复制深度、写队列等待与原子持久化。未改变 ensureLoaded 的初始化策略。
- Controller 搜索索引在每份响应返回后建立，仅本次同步处理有效。保持最新投影、严格 workspacePath/identity/remoteSessionId 匹配、fallback、snippets、分页与source失败边界。
- 工作流保留邻接顺序、dependsOn 拷贝、最终首次去重、重复 ID 的原规则（调度投影初始化取末项，frontier 查询取首项）、终态依赖和dispatch语义。
- MCP 分类仍在原展开回调内，隐藏/error 分支不提前解析，原 compact/高亮/语言和 DOM 输出不变。
- Mobile 分组保留 memo 依赖、排序稳定性、精确 key、空/重复组与独立数组；不触碰会话生命周期或accepted command路由。
- owner/lease、stale run、跨 Host 路由、Desktop continuous 与 mobile replayable 均未修改。

## 验证

- 整合 Vitest：106 文件 / 737 项全部通过（含 Gen UI、Plugin UI、既有性能、RPC/Server、手机协议/生命周期和 servicePipe）。
- contracts 实际包 test：26/26 通过；contracts 与 core 独立 typecheck 通过。
- 既有 Controller 本地/远程归档刷新及路由：3/3 通过。
- 工作流 frontier：3/3；既有 edge expansion 回归：12/12；该套中的 benchmark 1 项显式跳过。
- 手机历史布局/消息 schema：4/4 通过。
- 首次根 typecheck 在本轮 Controller 测试报 5 个类型错误（this 缺类型、meta 不含 searchSnippets），已修正；重跑根 typecheck 通过。Lint 0 warning / 0 error，架构 violations / baseline / new = 0 / 0 / 0。
- 本轮定点格式与 `git diff --check` 通过。所有测试使用自己的临时文件/合成输入，不访问真实业务数据。

## 限制与未盲改项

使用预装 Node 24.18.0，mise.toml 固定 24.14.0；未找到固定版本或 mise，没有修改环境或下载工具链。未运行安装包、真实 Agent/模型、Electron guest、实际手机 GUI E2E 或应用端到端 profile。此次 UI 改动是纯派生等价计算，没有修改布局或交互；元素/协议/生命周期测试不冒充 GUI E2E。

其他扫描命中没有直接改：React 全局订阅/聚合加载需确认真实渲染或 bundle profile；Provider schema 重复校验受 revision gate 约束，暂无高频收益证据；readTextFileRange 超长行需要完整 decoder/换行/截取边界验证，不能直接改变读文件语义；共享 preview 引用范围扫描涉及多轮优先级和重叠规则，未据简单搜索替换算法。以上不能认定已证明有可安全实施的修复，也不声称仓库不存在其他性能空间。

## 最终整体审查与修复验收

对后续未提交修改的整体复核已修复 MCP 启动/关闭资源边界、租约失效同步重入、过期 caller 的迟到重连拒绝、旧 client 错误重复触发恢复、hello/ACK 到 RPC 的字节交接与关闭清理、私有配置原子替换的 0600 权限，以及测试夹具的代理/CA隔离和缺失 Tooltip 根上下文。都使用原有 owner、接口和 single-flight 完成结果，关键失败时序先红后绿；没有通过增加延时、删除重试、全局未处理拒绝兜底或刷新架构 baseline 放行。

- 固定 Node 24.14.0 / PowerShell 7：根 typecheck、CLI 官方 typecheck、根 lint、fmt:check、verify:pre-push 与 architecture:check 通过；架构 violations/baseline/new 为 0/0/0。
- CLI 官方 lint 仍有与原 HEAD 相同的 56 warnings / 79 errors，主要是既有超长文件和未使用项；逐文件对照没有新增规则诊断。本轮新模块和测试定点 lint 为 0，不能把 CLI 总 lint 写成通过。
- 完整非浏览器 CI 为 537 通过 / 9 平台或 benchmark 跳过 / 0 失败；最终 MCP 四文件 66 项通过，远端/RPC/mobile/UI 关联 33 文件 335 项通过。此前整体 UI/性能/GenUI/服务回归 106 文件 804 项通过；各组重叠，不相加为唯一测试总数。包工程之外的新 fixture 另做严格类型检查，目标诊断为 0。
- 官方 IAB 验证真实组件和受控服务：Git 服务代际四场景、分享默认全选与关闭零扫描、命令中心订阅/搜索/选择/重开/卸载。宿主指针点击超时、Enter未确认生效，事件通过唯一已观察 locator 的页面 click 完成；不报告真实指针/完整键盘、真实 Host/Electron 或实体手机 E2E 已通过。
- 不执行推送、GitHub Actions、安装包打包、安装或真实模型请求；POSIX 正式文件权限 stat 分支未在 Windows 执行，测试已验证私有 writer 的实际创建 mode，通用默认 mode 保持不变。源代码和自动回归通过不代表所有平台或所有未来输入绝对无 bug。

## 重跑入口

```powershell
corepack pnpm exec vitest run --config packages/ui/vitest.config.ts --maxWorkers=1 packages/desktop/src/host/windowHostControllerSearchWork.test.ts packages/desktop/src/main/browserView/browserTabRecoveryReadWork.test.ts packages/shared/src/gen-ui packages/services/src/gen-ui/adapters packages/ui/src/gen-ui packages/ui/src/ToolCallBlocks/mcpJsonWork.test.tsx packages/ui/src/plugin-ui packages/web/src/mobile packages/ui/test/performance packages/rpc/test packages/server/test packages/desktop/src/main/webRemoteControl/servicePipe.test.ts
corepack pnpm --dir apps/zcode-cli/packages/contracts test
corepack pnpm --dir apps/zcode-cli/packages/contracts typecheck
corepack pnpm --dir apps/zcode-cli/packages/core typecheck
node --import tsx --test --test-isolation=none apps/zcode-cli/packages/core/test/performance-workflow-frontier.test.ts apps/zcode-cli/packages/core/test/performance-workflow-edge-validation.test.ts packages/desktop/src/host/windowHostControllerAutoArchive.test.ts packages/desktop/src/host/taskAutoArchiveRouting.test.ts
node --test scripts/ci/mobile-remote-layout-fixture.test.mjs scripts/ci/mobile-session-messages.test.mjs
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm architecture:check --changed
```
