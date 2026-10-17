# 手机远程控制

## 所有者与连接路径

- 手机配对客户端拥有 WebSocket、鉴权状态、RPC 序号/分片缓冲与 bridge 代际；桌面 Main 拥有窗口级远控运行时及当前 bridge；Host 持有会话和服务状态。
- 手机选中任务后先确认 bridge，再订阅 `web-remote-replayable` 事件流并读取权威快照。手机发出的 RPC 经 Main 透明转发到当前窗口已有 Host；Main 不代理业务服务，也不创建 Agent、Host 或会话。
- 桌面 Main 只接受当前 `bridgeSessionId` 的帧。一个 bridge attachment 的 Host scope 包含 remote session、workspace path 与 identity；手机侧 bridge 复用也必须匹配 workspace key 和 remote session id。
- 手机收到 `workspace-bridge-ready` 时，descriptor 的 `kind` 与 `remoteSessionId` 必须匹配请求目标：远端目标要求 `kind: "remote"` 且 session id 相等；本地项目与对话工作区接受 `kind: "local" | "conversation"` 且 session id 缺席。scope 不匹配按握手失败处理，不能标记 bridge 已就绪。
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
5. 请求 `remote-A` 却收到 `remote-B` 的 ready descriptor 时，手机拒绝该 bridge；本地项目与对话目标接受 `kind: "local" | "conversation"` 且没有 `remoteSessionId` 的 descriptor。
6. Host attachment port 在 `Initialize` 前关闭时，Main 发出匹配当前 bridge 的 `bridge-degraded`；手机使代际失效并拒绝挂起的 Promise RPC，不保留等待中的 service client。

## 任务清单与历史读取修复

- 当前窗口 Root 是手机清单同步的唯一 UI 编排者，二维码弹窗只控制配对。远控运行期间即使关闭弹窗、切换工作区或打开设置，仍同步窗口内全部工作区。Hook 只保存最近收到的完整远控状态 snapshot，`running` 与 `sessionId` 从该 snapshot 派生。
- 任务清单复用 Host Controller 的 `active` 查询及共享订阅，包含未归档的置顶任务；运行状态来自 Controller `liveStatus`，不使用持久化任务的历史状态猜测。手机协议暂把 `waiting` 显示为运行中。
- 同步保留 workspace identity 与 remote session；Controller 仍拥有跨 source 路由和状态，Main 只转发清单。并发更新串行发送，读取期间发生更新须在当前读取结束后补读，停止运行或 scope 换代后丢弃迟到结果。
- 窗口最后一个 workspace 关闭时，Hook 仍向 Main 发送 `workspaces: []` 和 `tasks: []`，清空该窗口的手机清单。空清单 IPC scope 使用当前远控状态 snapshot 自带的 `workspacePath` / `workspaceIdentity`；不缓存最后一个 workspace scope。Main 按 `windowId` 路由这些更新，schema 仍要求 `workspacePath` 非空。
- 手机进入任务：bridge ready → Host Initialize → `resumeTask`（复用已有 session）→ replayable 订阅 → `readSessionMessages`。历史读取不能依赖 session 已常驻，恢复不得另建 task、Host 或 Agent。
- `IZCodeTaskService.resumeTask` 增补可选 `remoteSessionId`，本地调用保持现有缺省；remote session 同时用于 bridge 与请求关联，仍由当前 scoped facade 执行。恢复调用本身不选择 delivery 语义，后续订阅固定使用 replayable；`sendTaskPrompt` 保留现有 `clientMode`。
- `resumeTask` 的 `session/resume` 若命中旧 Claude 导入历史恢复，及成功恢复后发现导入正文缺失而回填时，后续 `session/create` 都必须沿用同一 `remoteSessionId`；不能因转入导入修复 helper 而退回 path/identity-only target。
- replayable 订阅也保留 `remoteSessionId`，从手机 RPC 贯穿 task facade 与 Agent 服务；不能在恢复后的订阅中把 remote session 从 target 覆盖掉。
- CLI `session/messages` 必须用既有 `mapMessageWithParts` 输出协议消息（`messageId/sessionId/partId`）；不能直接返回含 `id/sessionID/messageID` 的存储对象。先按存储消息 ID 应用 after/limit 和活动分支投影，再映射协议对象。
- 手机清单更新不重启同 scope 会话；只有 workspace key、path、identity、remoteSessionId、taskId 或连接代际变化才释放订阅重建。重连总是重拉 bootstrap，恢复成功清除旧同步错误。

```mermaid
sequenceDiagram
    participant R as 桌面窗口 Root
    participant H as 已有 Host / Controller
    participant M as Main 转发
    participant P as 手机
    R->>H: active 清单查询 + 共享订阅
    H-->>R: 全部工作区任务及 liveStatus
    R->>M: 同步清单（弹窗关闭仍持续）
    M-->>P: workspace-list-updated
    P->>M: workspace-bridge-open
    M->>H: 附加已有 Host 的 replayable port
    H-->>P: Initialize
    P->>H: resumeTask
    H-->>P: 复用 / 恢复同一 session
    P->>H: replayable 订阅 + 消息快照
    H-->>P: 映射后的协议消息 + 后续事件
```

新增验收：最后一个 workspace 关闭后，Main 收到带当前远控状态 snapshot scope 的空 `workspaces` 与 `tasks`，且不依赖已关闭 workspace 或独立的最后 scope 缓存；非空用户/助手消息及工具 part 通过消息 schema；afterMessageId 与 limit 保真；冷历史恢复后可读、已有运行任务不重建；legacy Claude session 缺失和恢复快照缺失两条导入修复路径的 `session/create` 都保留传入的 `remoteSessionId`；恢复后的订阅使用 replayable，`sendTaskPrompt` 仍保留 client mode；置顶与其他 workspace 的运行任务可见；清单状态更新不打断流；浏览器中进入任务、收增量、发消息、断线重连后恢复历史且无红字；Windows ESM 测试入口使用 file URL。

## 验证入口

- 使用 `mise.toml` 指定的 Node 24.14.0。`corepack pnpm typecheck`、`corepack pnpm lint`、`corepack pnpm architecture:check --changed` 通过，架构新增及基线违规均为 0。
- 11 个 Vitest 文件共 110 项通过：手机目录、共享 RPC transport、桌面 service pipe/LAN transport、清单投影与目标复用、桌面 conversation projection。
- `node --test scripts/ci/mobile-session-messages.test.mjs` 共 3 项通过；干净工作区先执行 `node apps/zcode-cli/packages/dynamic-workflow/scripts/generate-libs.mjs` 准备 CLI 源码读取所需的类型库。
- `node --import tsx --test packages/desktop/src/host/windowHostControllerAutoArchive.test.ts` 的本地/远端 Controller 时序回归共 2 项通过。
- `node scripts/ci/web-remote-control-mobile-smoke.mjs` 与 `node scripts/ci/web-remote-control-window-sync-smoke.mjs` 通过。浏览器使用已有 Chromium，必要时设置测试已有的 `ZCODE_TEST_CHROMIUM_EXECUTABLE`；前者用真实手机入口、LAN 端点与 Channel RPC，服务由 fixture 提供；后者用真实窗口同步 hook 和 Controller fixture。未验证用户实体手机与当前安装包。
