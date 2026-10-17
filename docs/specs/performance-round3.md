# 第三轮性能扫描、修复与 review

## 范围

本轮使用两个子代理协助。开工时 main 与 origin/main 同步；架构检查基线 0、新增 0。前两轮已有的 74 个未提交文件全部保留，经内容对比没有改写。

扫描侧重当前源码中的重复处理和无效缓存：会话搜索与归约、文件树派生、服务 IO 与归档。选择能用回归复现、保持现有产品规则的改动；未新增依赖或修改 CLI、协议、持久化、owner/lease 及平台构建范围。

## 修复与证据

| 问题                               | 改动与验证                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| 空搜索仍处理正文                   | 先判断空查询，只统计行数；1,000 个轮次正文读取 2,000 → 0                                        |
| 已完成轮次搜索缓存过期             | 以不可变 unit 作弱键；同 ID 快照替换后匹配即时更新，历史前插后重新定位，稳定历史仍复用          |
| 文件树批量删除反复排序             | 每目录一次路径索引、一次复制与排序；1,000 个删除项比较次数 499,500 → 少于 12,000 的验收上限     |
| 仅改动目录筛选重复扫描 Git         | 单次调用建立祖先目录 Set；1,000 个目录 × 1,000 个变更的 Map 访问 1,000,000 → 1,000              |
| 解压队列反复搬移与跳过内容全量缓存 | 一次清理消费前缀，跳过数据按块消费；合成输入引用搬移 530,970 → 4，跳过载荷峰值缓冲 1,025 → 1 块 |

数字来自相同合成输入的访问/操作计数，不是整机耗时或真实堆字节。详细所有者、边界、时序和验收见 `performance-round3-conversation.md`、`performance-round3-frontend.md`、`performance-round3-services.md`。

## 验证与 review

- 使用 `mise.toml` 指定的 Node 24.14.0、`corepack pnpm`。
- `vitest run --config packages/ui/vitest.config.ts`：全部 performance 测试，另加 rowSharing、useConversationProjection 和 sidebarFileTreePath，最终 18 文件、121 项通过。
- `node --test scripts/ci/performance-browser.test.mjs scripts/ci/performance-find-browser.test.mjs`：3 组真实 Edge 回归通过，含前两轮搜索、导航、局部时钟、懒加载、DOCX，以及本轮会话查找。
- 根 `typecheck`、`lint` 通过，Lint 0 warning/error；`architecture:check --changed` 基线 0、新增 0；变更格式检查及 `git diff --check` 通过。
- 变更模块仅 `ui`、`services`。生产代码共 4 个文件，新增 105 行、删除 46 行，净增 59 行；其余新增为规格、回归和受控浏览器夹具。
- 主 review 核对文件树稳定排序、路径等价、输入不可变，归档跨块/padding/截断/尾部错误，查找缓存内容身份、功能开关和位置重定位；由两个子代理交叉 review 归档和查找改动。
- 补充目录筛选经独立只读 review，祖先 Set 与原严格 descendant 查询等价，保留根路径、Windows/UNC、大小写及 ignored 语义；未发现剩余可操作问题。最终全仓检查与 121 项回归均通过。

## 限制

浏览器使用真实 React hook 与 DOM、受控 Host/文档引擎或 render units，不代表完整桌面 Agent/PTY/Office 联调；本轮未做长期堆采样或整机性能基准。完整归档文件仍按原接口收齐后写入，本轮降低队列操作与跳过载荷的额外缓冲。

未提交、推送、打包或触发 Actions。
