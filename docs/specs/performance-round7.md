# 第七轮性能扫描

## 基线与范围

保留开工前全部未提交修改，包括前六轮性能修复和手机远控。freshness 检查 main 与 origin/main 同步；架构初检基线 0、新增 0。使用 pwsh 7、mise.toml 对应的 Node 24.14.0 和 corepack pnpm 10.33.2。

本轮用户授权扫描并自行修复，最多两个子代理。分别扫描 UI 和 services，主代理扫描 RPC 并统一 review 和验证。优先修复能复现的重复扫描/搬移，不扩展产品或协议，不提交、推送或打包。

具体规格见 `performance-round7-ui.md`、`performance-round7-services.md`、`performance-round7-rpc.md`。先写规格和回归，用原实现复现预算失败，再实现并保留行为对照。合成操作计量不能视为整机提速比例。

## 修复与 review

| 热点                      | 修复与验证                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Agent stdio 长帧重复查 LF | transport 保存已扫描偏移，帧消费/EOF 清空时归零；约 2 MiB 分片输入的候选字符范围 2,150,629,412 → 2,097,188 |
| RPC 一帧逐碎片 shift      | 单次 read 按下标拼接后批量删除前缀；2,048 碎片加 8 片尾巴，逻辑后缀整理量 2,112,512 → 8                    |
| RPC 累计 ACK 逐帧 shift   | 保留原顺序扣减后一次删除确认前缀；确认 2,000 帧中的 1,600 帧，逻辑后缀整理量 1,919,200 → 400               |
| 工作流详情逐站扫描边表    | 单次派生建立首见入边/出边索引；生产上限 32 阶段的端点读取 1,054 → 62，其他轨道绘制不变                     |

四项都先在原实现观察预算失败。stdio 经 UI 子代理 review，RPC 经 services 子代理 review；主代理核对 UI 的 find 首见规则、独立 kind 过滤、空模型/分支及完整参考输出。review 未发现本轮新增正确性问题；RPC review 提出的空片和 drained 同步重入已正式补测。

本轮生产改动为 rpc/services/ui 三模块、四个此前未改动的源文件，+36/-12，净增 24 行；另新增四份规格和三个回归文件。没有新公共接口、业务状态所有者、持久缓存或异步投递路径。原有本地修改保留。

## 验证

- 本轮目标最终 17/17 通过（stdio 6、RPC 8、工作流主轨 3）。其余性能和相邻投影/文件树/workspace scope/工作流 UI 回归合计 33 个独立文件、221 项通过；分批运行，重复的 RPC 复跑只计一次。
- mobile protocol、taskConversationLifecycle、webRemoteControlSync 三文件 32/32 通过，覆盖既有 replayable 客户端与恢复生命周期；加上上项共 36 个独立文件、253 项通过。
- 现有四个 performance 浏览器入口串行运行，共 5 组真实 Edge 场景全部通过：搜索代际/目录虚拟化/局部时钟/懒加载、DOCX 迟到完成、索引取消与身份切换、会话查找、真实 Worker 文件树搜索。浏览器使用受控 Host/服务夹具。
- Node 24.14.0 下根 `corepack pnpm typecheck`、`corepack pnpm lint` 通过，Lint 0 warning/error。架构 baseline 0/new 0。四个生产源、三个新测试和四份规格执行定点格式检查，`git diff --check` 无 whitespace error。

## 限制

上述计量分别为 UTF-16 LF 查找范围、删除前缀时的逻辑后缀长度、属性读取，不代表真实 CPU 指令、V8 搬移内存或整机提速百分比。stdio 的字符串追加/flatten 和 JSON/schema 解析成本仍存在。工作流阶段上限为 32，没有用超界模型夸大收益。

Node streams/ISocket 使用受控输入；未运行完整 Electron/Agent 长期会话、真实手机远控或长期堆采样。本轮没有提交、推送、打包或触发 Actions。
