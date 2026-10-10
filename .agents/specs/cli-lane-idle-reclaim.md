# CLI 控制面泳道的空闲回收

## 范围与产品规则

- `chat` 泳道承载活跃会话，**永不回收**：会话在飞时回收会打断用户正在进行的对话。
- `plugin` 与 `mcp-status` 是控制面泳道，**按需拉起、空闲回收**：二者都只为响应用户的偶发操作而存在，空闲时没有理由常驻。
- 回收对业务透明：下次 `getClient` 发现进程已退出就重新拉起，调用方不需要感知。
- 空闲回收是**预期行为，不是崩溃**：归因为 `idle-timeout`，监控与稳定性遥测不得计入崩溃率。
- 泳道标签（`lane`）同时决定资源遥测的角色归属：`chat` → `cli_chat`，其余 → `cli_aux`。不传 `lane` 会被缺省判成 `chat`，属于遥测误分类。

## 所有者、接口与事件顺序

`ZCodeAgentService` 拥有三条泳道的进程管理器配置；`ZCodeAgentProcessManager` 拥有回收时机判定，不拥有策略。

三条泳道的配置形状必须一致——同一种"按需控制面"用同一套参数，不允许一条治了一条没治：

| 泳道         | lane 标签    | idleTimeoutMs                     | 存在理由                      |
| ------------ | ------------ | --------------------------------- | ----------------------------- |
| `chat`       | `chat`       | 无（不回收）                      | 活跃会话                      |
| `plugin`     | `plugin`     | `PLUGIN_LANE_IDLE_TIMEOUT_MS`     | 插件安装/卸载/更新/校验       |
| `mcp-status` | `mcp-status` | `MCP_STATUS_LANE_IDLE_TIMEOUT_MS` | `mcp/list` 慢握手不堵串行队列 |

回收判定（`ZCodeAgentProcessManager.scheduleIdleReclaim`）已实现的语义保持不变：

- 每次在飞请求归零即重置计时，到点时仍无在飞请求才回收；
- 到点时有新请求在飞、或 `storageStartup.isWaiting` 未结束，则本次不回收，等下一次归零重新计时；
- 只回收"当前活跃实例"，已被替换的旧实例到点不做任何事；
- 回收整棵进程树，含挂在其下的 MCP 子进程；
- 空闲计时器 `unref()`，不把 host 进程钉在事件循环里。

## 不变量

- 常驻的 Node CLI 进程数 = 1（`chat`，仅在打开 workspace 后存在）+ 0（控制面泳道空闲即回收）。
- 任一控制面泳道的 `idleTimeoutMs` 缺省时，必须有显式的注释说明为什么不回收；不允许静默缺失。
- 三条泳道必须都带 `lane` 标签，保证 `resolveCliProcessResourceRole` 的分类与 `PROCESS_RESOURCE_CLI_LANES` 契约一致。

## 失败语义

- 回收失败不抛给调用方：`cleanupManagedProcessWithRetry` 内部重试，最终失败只记日志。
- 回收后首次调用走正常 spawn 路径，spawn 失败的语义与首次启动完全相同（不引入新的失败模式）。
- 回收时机不会打断在飞操作：在飞请求持有期间计时器不触发回收。

## 验收场景

1. 打开应用但未打开 workspace：常驻 CLI 进程数为 0；空闲超过阈值后 `plugin` / `mcp-status` 进程树被回收。
2. 打开 workspace 并保持会话空闲：仅剩 1 个 `chat` 进程，且**不会**被回收。
3. 连续执行插件操作（安装/卸载/更新）期间，进程不被回收；操作结束后重新计时。
4. 插件操作进行到一半（在飞请求未归零）到达空闲阈值：不回收，等请求结清后重新计时。
5. 资源遥测里 `plugin` 与 `mcp-status` 的样本都归入 `cli_aux`，不落入 `cli_chat`。
6. 单进程空闲 RSS 的实测基线为 276.6 MiB（PSS 230.2 MiB）；回收一条控制面泳道即回收约 276.6 MiB。
