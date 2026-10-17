# 第九轮性能扫描与修复

保留开工前全部未提交修改；freshness 确认 main 与 origin/main 同步，架构初检 baseline 0/new 0。用户授权扫描后自行修复，最多使用两名子代理，分别处理 UI 与 services，主代理处理 RPC 与统一验证。各项先规格、旧实现失败证据，再实现与回归。

本轮检查剩余重复派生与连接生命周期问题。具体产品规则、状态所有者、事件顺序和验收分别记入 `performance-round9-rpc.md`、`performance-round9-ui.md`、`performance-round9-services.md`。最终验证使用 mise.toml 指定的 Node 24.14.0、corepack pnpm 与 pwsh 7。

## 修复与证据

| 热点                         | 修复前的受控证据                                                                                                            | 修复后                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| RPC 惰性事件与初始化等待泄漏 | 1,000 个未订阅 Event 留下 1,000 个 handler；500 次初始化前订阅/退订留下 500 个远端监听；300 个取消调用留下 300 个初始化监听 | 无订阅即无 handler；终结立即释放等待；迟到初始化不复活订阅               |
| RPC 重订与连接终结           | 重订丢事件、dispose 后后台监听存活；初次修复又由独立 review 复现本地 callback 残留                                          | 周期独立 id 和接收 handler；旧周期迟到帧忽略；终结释放远端订阅与本地回调 |
| 多轮分享预检反复扫描窗口     | 64 个选择、1,024 行的 turn ID 读取 65,536 次                                                                                | 一次分桶，读取至多 1,024 次，原指纹字节不变                              |
| 公开分享引用逐条扫描名称     | 32 条 citation、256 个结果物，名称迭代读取 8,192 次                                                                         | 每调用惰性索引，读取至多 256 次；同名歧义与完整正文输出保持              |
| 存储批量删除逐项 shift       | 2,048 个目标对应 2,096,128 次逻辑后缀引用移位                                                                               | 快照游标消除该移位；8 个并发 worker、错误隔离和父目录清理顺序保持        |

生产修改只涉及 rpc、storage、ui 三模块、五文件，+119/-62、净增 57 行；SessionPane 只计本轮两个分享入口，不包含开工前的 turn directory 修改。新增五个测试文件、两份旧输出快照和四份规格。原有工作区改动保留。

## Review 与验证

- 本轮 24 个新回归通过：RPC 11、分享 8、存储 5。七项初始 RPC 回归、两项分享工作量预算、一项存储预算均在生产修复前确认失败；独立 review 的本地 emitter 释放回归也先失败再修复。
- 主代理及 services 子代理独立 review UI，UI 子代理独立 review storage，services 子代理独立 review RPC；修复本地 emitter 残留后再次 review 与独立复跑，无新增可操作问题。UI 对照 27 组指纹与 8 组完整 Markdown 旧输出快照，保证 scope、解析根、顺序和歧义规则不变。
- 全部 performance 回归、row sharing、mobile protocol/lifecycle/window sync、Host 手机 servicePipe、客户端 sampling、shared workflow holes 共 44 文件、293 项通过；再运行 shared 原始 RPC transport 与现有两个 UI workflow holes 文件 49 项通过。合计 **47 个独立 Vitest 文件、342 项通过**，重复运行不重复计数。
- 既有四个 performance 浏览器入口串行运行，**5 组真实 Edge 场景通过**：搜索代际与虚拟化/局部时钟/懒加载、DOCX 迟到渲染、文件索引取消与 identity 切换、会话查找、文件树真实 Worker 搜索。浏览器使用受控服务夹具，未启动用户 Agent。
- 根 `corepack pnpm typecheck` 通过，`corepack pnpm lint` 0 warning/error；`architecture:check --changed` baseline 0/new 0。本轮 helper、RPC、storage、测试和规格的定点格式检查通过，`git diff --check` 无 whitespace error。保留 SessionPane 既有未格式化的其他本地修改。

## 计量边界

属性读取、迭代次数及逻辑数组后缀整理是受控工作量指标，不代表实际 CPU 指令或整机提速比例。订阅测试驱动真实 ChannelClient/ChannelServer，但使用受控同步传输；存储测试使用可控 IO，并未测量真实大目录磁盘吞吐。没有运行完整 Electron/Agent 长期会话、真实手机联调或长期堆采样。

没有提交、推送、打包或触发 Actions。
