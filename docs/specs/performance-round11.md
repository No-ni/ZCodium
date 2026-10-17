# 第十一轮性能扫描与修复

本轮用户授权扫描、自行修复并本地测试，使用三个 `gpt-6-luna / max` 子代理并行处理 UI 纯计算、services IO 和 RPC 解码，随后交叉只读 review。保留开工前第 1–10 轮性能、手机远控与其余本地改动。未提交、推送、打安装包或触发 Actions。

freshness 确认 main 与 origin/main 同步（ahead 0 / behind 0）；架构初检 baseline 0/new 0。PowerShell 7，最终验证使用 mise.toml 固定的 Node 24.14.0 和 corepack pnpm 10.33.2，仅在测试命令进程中选定运行时路径，没有修改持久环境。

## 确认的修复

| 问题                                           | 修复前受控证据                                                        | 修复方式                                             |
| ---------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------- |
| 同段搜索高亮按每个命中重建全部 Range           | 500 个命中创建 250,500 个 DOM Range                                   | 单次 apply 按已挂载行共享扫描结果，500 个 Range      |
| 搜索片段定位和两个 effect 重复处理同一正文     | 1,000 个命中的 resolver 处理 7,013,000 字符；hook 处理同正文 5,001 次 | 调用内去重；effect 共享定位结果，resolver 7,013 字符 |
| optimistic 任务列表覆盖反复线性查缓存          | 512 条缓存、256 个覆盖读取 taskId 98,944 次                           | 调用内保留首见基底与原 Map 后写顺序，只读 512 次     |
| RPC 解码为每个标签/VQL 字节分配短切片          | 真实 Channel RPC 往返 1,024 个小整数复制 4,130 字节                   | BufferReader 直接读单字节，复制预算 ≤256 字节        |
| 技能目录统计递归 Promise.all 同时提交宽目录 IO | 最终宽目录夹具原峰值 522 个 lstat，请求预算 8                         | 每次完整遍历最多 8 个 worker，错误停派并等待在途结束 |

各项先写领域规格与回归，在旧生产实现确认失败后修复。细节、所有者与事件图见 `performance-round11-find.md`、`performance-round11-ui.md`、`performance-round11-transport.md`、`performance-round11-services.md`。没有新的会话事实 owner、持久缓存或协议字段；workspace identity、owner/lease、desktop continuous/mobile replayable 保留原边界。

## 验证与边界

测试使用合成投影、受控文件系统、内存协议和临时浏览器 profile。没有启动用户 Agent 或已安装 ZCodium，没有读取用户数据库/技能目录，没有调用外部模型或写入用户配置。上述数字都是指定输入的工作量指标，不能换算成整机提速比例。

当前既有 Electron 测量还指出 Markdown streaming/static 与 live-tail 迁移时的重挂成本。本轮修复搜索中的可证明重复工作，没有改变这些渲染设计边界；没有重新进行完整 Electron 长会话 CPU/堆或真实手机性能测量。

## 最终检查与 review

- 最终串行 Vitest：**59 个文件、408 项全部通过**。范围包括全部 performance 回归、投影行引用共享、mobile 协议与生命周期、shared 原始 RPC、桌面手机 servicePipe，以及 rpc/server 的全部现有生命周期回归。本轮新建 4 个 Vitest 文件共 13 项。
- 首次并发 2 worker、与根 typecheck 同时运行的扩大回归是 405 通过 / 1 超时（当时共 406 项）。超时位于 `servicePipe.test.ts:344` 的 stale 旧帧与 900 KB 往返场景，5 秒预算超出；单文件复跑 9/9 通过，最终上述完整串行复跑也通过。没有修改测试 timeout。源码检查未发现与单字节解码的因果证据，资源竞争只是待验证假设，不把初次失败改写为通过。
- 既有四个 performance 浏览器入口加本轮 find 入口串行执行，**7 组真实 Edge 场景通过**（TAP 含一个父测试共 8 项通过）。包括搜索代际与目录虚拟化/局部时钟/懒加载、DOCX 迟到完成、文件索引取消/identity 切换、会话查找、真实 Worker 文件树搜索，以及新 DOM Range 和片段定位两组。最终 Range 实测 500，长正文片段规范化实测 3 次。
- 全部代码收口后根 `corepack pnpm typecheck` 再次通过，根 `corepack pnpm lint` 0 warning / 0 error，`corepack pnpm architecture:check --changed` baseline 0 / new 0；本轮 18 个规格/源码/测试文件定点格式检查与全工作区 diff whitespace 检查通过。没有更新架构 baseline。
- UI 子代理只读 review RPC 游标、EOF、通用 IReader 和二进制契约并独立跑目标 3 项；transport 子代理 review 搜索三个生产 diff 并跑目标 3 项；services 子代理 review 任务 selector。主代理复核所有生产改动与服务最终旧代码对照，未发现新增可操作问题。

生产变更归属 ui、rpc、services 三模块的六个文件，按开工快照/干净文件 diff 合计新增 169 行、删除 82 行，净增 87 行；不把此前未提交内容计入本轮。另新增五份规格、四个单测文件和一个由 HTML/TSX/Node 脚本组成的浏览器夹具。没有新增生产文件、依赖或并行业务写入路径。测试 Vite/Edge 已按 finally 关闭，未结束或调整用户已有进程。
