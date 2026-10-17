# 第二轮续扫（仓库性能记录第四轮）

## 精简交接

- 前轮已完成扫描、自行修复、review。五项结果：空查询不读正文、会话搜索以不可变 unit 弱键失效、批量 deleted 行一次排序、changed-only 祖先目录集合、解压队列一次前缀清理与按块 skip。
- 前轮最终 Node 24.14.0 下 121 项 Vitest、3 组 Edge 回归，以及根 typecheck/lint/架构/格式检查通过。详细证据见 `performance-round3.md`。
- 工作区仍有此前所有未提交改动，不得恢复或覆盖。没有提交、推送、打包或触发 Actions。本轮开始 main 与 origin/main 同步，架构基线 0、新增 0。
- Node 固定运行路径为本机 pnpm 的 24.14.0 安装；命令使用 pwsh、corepack pnpm。模块上下文由 architecture:context 生成；先 spec 与回归，再实现。
- 事实仍归 CLI/runtime owner，UI 只维护派生投影和局部状态。workspaceIdentity、owner/lease、stale run、Desktop continuous 与 mobile replayable 边界继续适用。Windows/macOS 构建规则不变。
- 最新授权：继续第二轮扫描，自行决策修复与 review，最多三个子代理协助。本文件承接前轮结果，避免重复读取完整过程；不推断授权提交或推送。

## 本轮方法

扫描新的高频算法、首屏依赖与重复 IO，先证明调用次数、无界保留或可复现问题。优先减少无效工作，不为未证实热点添加跨请求缓存，不为小操作扩大协议或状态所有者。

每项实现前补充对应规格，保留产品规则、排序、错误和取消语义；状态或时序变更画出所有者及顺序。目标回归先失败后修复，最终统一检查并交叉 review。

## 实施与验证

本轮完成四项修复，详细规则与验证分别记录在 `performance-round4-frontend.md`、`performance-round4-io.md`、`performance-round4-conversation.md`、`performance-round4-file-search.md`。

| 路径             | 修复与操作计量                                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 工作区列表提取   | 按当前请求 scope 分桶；48 scope / 2,880 行的身份字段读取 138,240 → 2,880                                                                        |
| 模型轨迹窗口映射 | 完整 delta 展开后限量再映射；250 条记录、limit 3，工具 JSON 解析 250 → 3                                                                        |
| 会话 flush 合并  | 调用内候选集合排除无目标回扫；2,000 条纯 upsert / 混无关 delta / 不同 run 的属性读取约 1,000 万 / 1,000 万 / 1,200 万 → 11,997 / 12,000 / 6,000 |
| 文件树搜索搬运   | Host packed 原样交给 Worker；10,003 条索引初次查询主线程 pack/unpack 各 2 次 → 0                                                                |

计量为受控合成数据的访问量，不能换算为整机延迟或堆字节。合并器微基准详见会话规格；有目标的原回扫仍保留。

## Review 与范围收敛

- 工作区分桶经交叉 review，身份 fallback、重复/空 scope、数组隔离、行顺序、tasks-index 左表 join 和 stale 提交边界保持原语义。
- 模型轨迹 direct-read 候选被 review 撤回：Windows 大小写不敏感读取与原 readdir 精确字符串选择不同。公共大小写回归先失败后恢复原选择，仅保留限量映射。
- 文件树 packed 直传经交叉 review，唯一生产消费方与 scope/version/Worker 打分及销毁语义均保留。
- 合并器 review 发现相邻状态 patch 显式 undefined 消除屏障的边界，已先失败后修复，补充此前真实状态屏障和同 run 删除的恢复回归，独立复审 9/9 通过，无新增问题；不缩窄公开 schema 接受的输入。该边界保留原合并器的 wire/apply 行为，未扩大到旧算法的次序设计修复。

## 验证记录

- Node 24.14.0、corepack pnpm。根 typecheck、lint 和 architecture:check --changed 通过，Lint 0 warning/error，架构基线 0、新增 0。
- 全部 performance Vitest，加 rowSharing/useConversationProjection/sidebarFileTreePath/useWorkspaceServicesScope：最终 22 文件、148 项通过，包含合并器 review 补充的 3 项边界回归。
- 真实 Edge 4 组回归串行通过：前两轮搜索/导航/时钟/懒加载、DOCX、会话查找以及本轮文件树真实 Worker。
- 并行浏览器运行首次为 3/4，一项 Worker 初始化等待超时；该项单独重跑通过，整组串行重跑 4/4。保留真实结果，不将首次失败写为通过。
- 额外源码 wiring 检查为 67/68，失败项依赖 CommandCenterDialog 旧 fetchWorkspaceFileEntriesPacked 字符串，属于此前工作区 hook 替换；本轮文件树两项 wiring 通过，未改该既有静态断言。
- 最终边界修复后根 typecheck/lint/architecture 再次通过，变更文件格式及 git diff --check 通过。修改模块为 ui/services/shared，生产源共 6 文件，新增 125 行、删除 40 行、净增 85 行（包含 44 行局部纯分桶 helper）。其余新增为 spec、对照参考、单测和受控浏览器夹具。
- 本轮开始已存在的源码和规格经内容对比均未改写；精简交接文档 `performance-round4.md` 在本轮更新为最终结果。

## 限制与保留

浏览器使用真实 React/hooks/Worker 与受控 FileService/Host/文档引擎，未启动完整桌面 Agent/PTY 或真实 Office 排版联调。没有做长期堆采样。文件树 Worker 仍接收完整 packed 索引，只消除主线程重复编解码。

本轮不提交、推送、打包或触发 Actions。
