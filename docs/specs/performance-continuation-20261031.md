# 2026-10-31 性能与缺陷扫描续查

## 范围与基线

继续「排查并优化项目性能与修复缺陷」中断后的扫描；原任务尚未交付新一轮补丁。保留工作树内此前已完成的修复，本记录只说明续查实际新增的工作，不覆盖前序验收记录。

- 开始时 main 与 origin/main 同步，freshness 通过；HEAD 保持 `187232e2fd04090a00f26ead73e9f00a0bf472f3`。
- 开始时有 133 个未提交文件，全部记录 SHA-256 与 Git 状态；本轮新增代码只改开始时 clean 的文件。
- 根 typecheck 基线 exit 0；根 lint 基线 exit 0、4 warnings / 0 errors；架构检查 violations 0 / baseline 0 / new 0。
- 使用项目内已有 Node 24.14.0、Corepack 与 pnpm 10.33.2。测试 HOME、TEMP、数据、缓存、日志全部绑定经真实路径核查的项目隔离目录；没有工具下载或真实用户目录测试。
- 不提交、推送、打包或触发 Actions；不改版本、依赖、审计边界、数据根或桌面发行平台范围。

## 新增修复

### RPC 单次事件的同步订阅

源 `Event` 在订阅期间同步投递时，旧 `Event.once` 读取未初始化句柄，身份握手失败；原始回归 8 项中 7 项失败，包含同步投递、`toPromise`、真实 `IpcConnectionScope` 接纳以及重复释放/迟到通知。

[foundation.ts](../../packages/rpc/src/foundation.ts) 让单次订阅持有唯一幂等释放入口：先终结通知资格，源句柄返回后立即回收；异步正常路径仍先解绑再通知。公开签名、同步通知、首值和异常传播保持。

独有回归 8/8 通过；既有 IPC scope/路由 31 项与 delayed subscription 15 项通过。规格与所有者时序见 [同步单次事件](rpc-once-synchronous-subscription.md)。

### WebSocket 初始化回调主动关闭

真实 loopback server 与 Node 标准 WebSocket 复现：`onOpenSocket` 内调用 `close()` 后状态已为 `CLOSING`，旧 adapter 仍 resolve 服务代理，并推迟本地连接资源释放。

[websocket.ts](../../packages/client/src/websocket.ts) 在回调返回后复核 `OPEN`；已开始关闭时复用原连接 owner 同步释放资源，由原生 close/error 入口按既有字段拒绝。没有新的超时、重试或错误协议。

原实现 3 项中 1 项失败，修正后 3/3 通过；正常回调与回调异常均保留。当前 Web bootstrap 不传该可选回调，因此这里报告公开 adapter 的已确认边界。规格见 [open 回调生命周期](websocket-open-callback-lifecycle.md)。

### Token 数字格式化的重复准备

[tokenNumberFormat.ts](../../packages/ui/src/lib/tokenNumberFormat.ts) 复用相同 locale、记法和小数位配置的格式化器，最多保留 64 项；只改纯计算辅助函数，不改 React 交互、hook/store 或平台接口。

同一 6,000 次格式化 / 4 个配置负载，构造次数由 6,000 降至 4；输出、小数位、非法参数错误以及 64 项 FIFO 淘汰均通过真实源码回归。只报告重复准备工作次数，不换算整机耗时收益。详见 [数字格式化规格](performance-continuation-ui.md)。

## 未采纳的候选

- 文件服务缓存、忽略规则和分词搜索未确认新缺陷。现有文件扫描 2 项由隔离 runner 执行通过；合成路径排序的计时线索不作为本轮性能成果。
- 任务栏叠加按标签去重会改变原来每次未读投影同步都重写原生图标的行为，本地标签缓存无法反映系统是否仍持有该图标。审查后撤回该候选的生产补丁、spec、测试与入口；还原的相邻 badge 测试 4/4 通过。它不计入本轮修复或提速成果。
- 其它未复现的扫描线索不记为已确认 bug，不据此扩大实现。

## 验证记录

| 验证                                | 实际结果                                  |
| ----------------------------------- | ----------------------------------------- |
| 新增 once / WebSocket 回归          | 8 + 3 项通过                              |
| 既有 IPC / delayed 订阅回归         | 31 + 15 项通过                            |
| RPC 与连接传输矩阵                  | Vitest 9 文件 / 63 项通过，无失败或跳过   |
| 数字格式化等价 / 预算 / 异常 / 淘汰 | 6 项通过；无失败或跳过                    |
| 最终根 typecheck                    | exit 0                                    |
| 最终根 lint                         | exit 0，4 warnings / 0 errors，与基线一致 |
| 最终 architecture --changed         | exit 0，violations 0 / baseline 0 / new 0 |
| 本轮文件格式                        | 13 个改动文件通过；未宣称全仓 fmt 通过    |
| 原有改动保护                        | 133 项内容哈希与状态保持，HEAD 未变       |

最终相关源码回归共 126 项：新增 once 8、WebSocket 3、数字格式化 6、既有 IPC 31、delayed 15，加传输矩阵 63。五个入口的嵌套结果与日志逐项复核为 63 项、失败 0、跳过 0；Vitest 矩阵 JSON 另确认 63 项全部执行。重复执行不重复累加到该总数。

本轮实际修改模块为 rpc、client、ui，沿用既有公开边界；生产代码 51 行增加 / 6 行删除，净增 45 行。单次订阅、连接 adapter、格式化器模块分别持有其本地资源；没有接管业务队列或改变远程恢复所有权。

隔离日志位于本工作树 `.run-logs/project-only-validation/`：最终类型检查 `continuation-final-typecheck-i9Nea7`，lint `continuation-final-lint-7qeYxB`，架构 `continuation-final-architecture-ZD2mlA`，最终五入口回归 `continuation-final-regressions-CE42bo`，传输矩阵 `continuation-transports-SaJOA5`。记录使用已实际核实的 Node 24.14.0、pnpm 10.33.2。

传输矩阵包含 direct、真实 MessageChannel、SocketProtocol、真实 loopback WebSocket，以及受控远程 backend 和 stdio 入口。节点单测与本机回环验证不等于真实 Electron、真实远端、实体手机或浏览器 E2E；未测整机帧率、内存或端到端延迟。CLI 未由本轮修改，未重跑其独立 lint/typecheck；前序 CLI lint 欠账仍查原记录。
