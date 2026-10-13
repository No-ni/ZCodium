# 手机远程控制

## 所有者与连接路径

- 手机配对客户端拥有 WebSocket、鉴权状态、RPC 序号/分片缓冲与 bridge 代际；桌面 Main 拥有窗口级远控运行时及当前 bridge；Host 持有会话和服务状态。
- 手机选中任务后先确认 bridge，再订阅 `web-remote-replayable` 事件流并读取权威快照。手机发出的 RPC 经 Main 透明转发到当前窗口已有 Host；Main 不代理业务服务，也不创建 Agent、Host 或会话。
- 桌面 Main 只接受当前 `bridgeSessionId` 的帧。一个 bridge attachment 的 Host scope 包含 remote session、workspace path 与 identity；手机侧 bridge 复用也必须匹配 workspace key 和 remote session id。
- 手机收到 `workspace-bridge-ready` 时，descriptor 的 `kind` 与 `remoteSessionId` 必须匹配请求目标：远端目标要求 `kind: "remote"` 且 session id 相等；本地目标要求 `kind: "local"` 且 session id 缺席。scope 不匹配按握手失败处理，不能标记 bridge 已就绪。
- `workspace-bridge-ready` 只表示 Main 已创建对应 bridge；Host attachment 的服务可用性以该 Host 通过 attachment port 发出的 `Initialize` 为准。Main 必须监听 Host attachment port 关闭，并为当前 bridge 转发 `bridge-degraded`；手机收到匹配的通知后使 bridge generation 失效并 dispose `ChannelClient`，令等待 `Initialize` 的 Promise RPC reject，旧 generation 不得再发送 RPC。
- 同一 remote session 的 RPC 出站与入站分别维护连续序号、ack 和重传缓冲。接收方只在完整装配和校验后交付；手机连接或 bridge 代际失效时，旧 RPC 与事件回调必须失效，恢复后重开 bridge、重订阅并重读快照。
- 远端 session 路由属于创建它的窗口 Host。Main 按窗口选择 Host，Host 再验证 remote scope；连接状态不能替代窗口归属校验。

## 事件顺序

```text
手机任务视图
  → ensure(workspaceKey, remoteSessionId)
  → workspace-bridge-open(bridgeSessionId, generation)
  → Main 当前窗口 Host attachment(remote scope)
  → workspace-bridge-ready（Main bridge 已创建）
  → Host Initialize（服务可用）
  → replayable 订阅 + 权威快照
```

远端重连可以保留同一 workspace identity/key，但会产生新的 `remoteSessionId`。桌面推送的 workspace 清单更新后，手机必须使旧桥失效，并为新 session 重开桥；旧 Host attachment、迟到 Initialize 和旧事件不得被新任务视图采用。

## 失败语义与边界

- bridge open、Host attach 或握手失败时，不把旧桥标成新 scope 已就绪；Host 拒绝 attachment 或关闭 port 时 Main 必须发出当前 bridge 的 `bridge-degraded`，不能让手机静默等待 `Initialize`。手机失效该代际、dispose `ChannelClient` 并拒绝挂起的 Promise RPC，调用方显示错误并可重新尝试。
- RPC gap 或装配超时会使当前 bridge 代际失效；手机重开 bridge、重建订阅并读取权威快照，旧代际的 RPC 与事件回调不得继续生效。
- 鉴权拒绝、配对过期或设备被踢是终态；普通网络关闭允许退避重连。
- 手机页面只连接当前二维码对应的桌面窗口；remote session 缺失、未连接、identity 不匹配或不属于该窗口时拒绝 Host attachment。
- 本协议复用当前桌面窗口 Host 与 `web-remote-replayable` 通道；不引入第二 Host、手机专用 Agent、独立业务队列或对 `~/.zcode` 数据的迁移。

## 验收场景

1. 同一 workspace key 的 remote session 从 `remote-A` 换为 `remote-B` 后，手机发出新的 bridge open，旧桥上的迟到响应不能进入新 RPC client。
2. workspace key 或手机 socket 变化时，旧代际事件订阅与 RPC 均失效；新桥完成 Initialize 后重新订阅并读取快照。
3. 旧 `bridgeSessionId` 的消息、ack、分片和重传帧不进入当前 Host；当前会话的双向序号和 ack 独立推进。
4. remote Host attachment 携带完整 scope，跨窗口或失效 session 不得连接到本地 Host 服务。
5. 请求 `remote-A` 却收到 `remote-B` 的 ready descriptor 时，手机拒绝该 bridge；本地目标只接受 `kind: "local"` 且没有 `remoteSessionId` 的 descriptor。
6. Host attachment port 在 `Initialize` 前关闭时，Main 发出匹配当前 bridge 的 `bridge-degraded`；手机使代际失效并拒绝挂起的 Promise RPC，不保留等待中的 service client。
