# 第十轮性能扫描与修复

用户授权扫描后自行修复，使用两名子代理分别处理 UI 与 services，主代理处理 RPC、交叉复核和统一验证。保留开工前全部未提交性能和手机远控改动；未提交、推送、打包或触发 Actions。

两次 freshness 远端 fetch 均因 GitHub 连接重置失败；`--no-fetch` 按本地缓存确认 main 与 origin/main 同步，不能据此确认远端最新提交。架构初检 baseline 0/new 0。使用 pwsh 7、mise.toml 指定的 Node 24.14.0、corepack pnpm；没有调整架构 baseline。

## 修复与受控证据

| 热点                           | 原实现                                                                                        | 修复后                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| RPC 小帧消费反复复制未读后缀   | 32 KiB 输入分 1,024 次 read，累计复制 16,793,568 字节；两个协议解析粘包各复制 17,843,196 字节 | 队首偏移推进，仅复制返回字节；对应预算 ≤32,768 / ≤34,816 字节，skip 无复制          |
| 时间线插件裁决逐行扫描成员数组 | 2,000 个普通回合去重读取 1,999,000 次；同 surface 1,000 次成功读取 502,498 次                 | 调用内字符串索引，消除这两类数组回扫；旧完整输出黄金快照一致                        |
| 长会话去重窗口每条事件 shift   | 10,000 个 CUA 完成事件触发 9,760 次；12,000 个兼容 session 事件触发 6,000 次                  | 固定容量环形顺序存储，无 shift；原精确容量、FIFO、重复不刷新与 replay/live 隔离保持 |

各项均先写规格与回归，在原生产代码确认失败后修复。详见 `performance-round10-rpc.md`、`performance-round10-ui.md`、`performance-round10-services.md`；图中明确字节队列、会话事实和派生裁决各自所有者与事件顺序。没有新公共 API、协议、持久缓存或第二份业务事实。

## 复核与验证

主代理复核 UI 的首见次序、原 slice 选项语义、特殊字符串键及重复 ID/对象行为，以及 services 环形 FIFO 与旧 Set/Map 去重路径；UI 子代理独立复核 services。services 子代理复核 RPC 的字节顺序、输出隔离、块释放和协议边界，并独立复跑相关 22 项。未发现新增可操作问题。

- 本轮三个新 Vitest 文件共 20 项通过：RPC 6、UI 6、services 8。旧生产代码已复现 RPC 5 项、UI 3 项、services 2 项失败；其余用于行为等价、窗口边界和生命周期验证。
- 既有全部 performance、row sharing、移动协议/lifecycle/window sync、shared raw RPC 与桌面手机 servicePipe 共 42 文件、300 项通过；新 RPC/UI 加全部 plugin-ui 共 10 文件、42 项通过；新 services 1 文件、8 项通过。合计 **53 个独立 Vitest 文件、350 项通过**，复跑不重复计数。
- 四个现有 performance 浏览器入口串行执行，真实 Edge 的 **5 组场景全部通过**：搜索代际/目录虚拟化/局部时钟/懒加载、DOCX 迟到完成、索引取消/identity 切换、会话查找、真实 Worker 文件树搜索。
- 根 `corepack pnpm typecheck` 通过，`corepack pnpm lint` 0 警告/0 错误，`architecture:check --changed` baseline 0/new 0；本轮文件定点格式检查及 diff whitespace 检查通过。`zcodeAgentService.ts` 保留开工前已格式化/未格式化的其他本地修改，仅格式化本轮签名。

生产修改归属 rpc、services、plugin-ui 三模块，五个文件相对开工状态新增 106 行、删除 74 行，净增 32 行；包含一个同模块私有顺序 helper。另新增四份规格、三个回归文件和一份旧输出快照。已修改过的 protocol/service 均以开工快照区分本轮 diff，其余本地改动保留。

## 计量边界

复制字节、数组元素读取、shift 调用是受控输入的工作量指标，不表示整机加速比例；UI 微基准仅为合成纯函数。浏览器使用现有受控服务夹具，没有启动用户 Agent。没有完整 Electron 长会话 CPU/堆剖析或真实手机联调。
