# 手机重连 bridge 换代回归

## 边界与所有者

- `MobileRemoteControlClient` 仍是 WebSocket、鉴权状态、bridge 代际、RPC 序号和订阅清理的唯一所有者；Host/runtime 继续持有任务与会话状态。
- 手机任务流固定使用 `web-remote-replayable`；`desktop-continuous` 不进入本回归。远端重连仍复用同一窗口 Host 与既有 runtime，不新建业务队列或第二 Agent。
- `WorkspaceBridgeLifecycle` 串行化 bridge open；`ensure/invalidate/releaseBridge` 继续负责拒绝挂起 open、旧订阅、旧 `ChannelClient` 和旧 service accessor。

## 失败语义

浏览器可能在旧 socket 的 `close` 回调派发前允许 UI 触发加速重连；此时 socket 可能处于 `CLOSING` 或其 `CLOSED` 尚未被回调观察。创建新的 socket 前必须先作废旧 bridge。旧 socket 的迟到 close、message 和 error 回调仍不得驱动新连接状态。

事件顺序如下：

```text
旧 socket error → retryNow 换代 socket
→ 旧 bridge invalidate/release
→ 新 socket open → auth → matched
→ ensure(workspaceKey, remoteSessionId) 重新 open bridge
→ Host Initialize → replayable 重新订阅/读快照
```

没有新 bridge open 时，新 socket 的 `matched` 不得让旧 bridge 保持 ready；旧 `ChannelClient`、旧 RPC 序号和旧事件回调也不得被新任务视图复用。

## 验收

1. 已 ready 的 bridge 在加速重连换代 socket 后，新 socket 完成 `matched`，下一次 `ensureWorkspaceBridge` 必须发出新的 `workspace-bridge-open`。
2. 旧 socket 的迟到 close 不重复作废新连接，也不改变新 socket 的 `matched` 状态。
3. 远端目标的完整 scope 仍由既有 `WorkspaceBridgeLifecycle` 和 Host descriptor 校验负责；本回归只固化 socket 换代必须先于 bridge 复用。

## 交互验收场景

测试按真实握手顺序驱动：

```text
旧 bridge ready → 旧 readTaskSnapshot 挂起
→ 旧 socket error → retryNow 创建新 socket
→ 旧挂起 RPC 被拒绝
→ 新 socket open/auth/matched
→ 旧 socket 迟到 close/error/message 不改变新状态
→ start ensureWorkspaceBridge → 新 open
→ 新 stream Initialize → workspace-bridge-ready
→ await ensure resolve
→ 旧 stream bridge-degraded 不触发新降级或新 open
```

该场景使用 fake WebSocket 与真实 `ChannelClient` 序列化验证客户端换代边界；不是浏览器、真实 LAN/relay 或实体手机 E2E。上述边界不得在 spec 或报告中记作 E2E 已验收。

## 浏览器回归入口的 fork 标题

接续任务运行现有真实 mobile UI + LAN endpoint smoke 时，已通过畸形载荷拒绝与 waiting/matched 恢复，但返回首页检查等待旧标题 `ZCode 远程控制` 而超时。当前 `MobileApp.tsx` 和本次真实浏览器 `home.png` 均显示 `ZCodium 远程控制`，这是测试定位器未同步 fork 身份；将三个活动定位器更新为当前标题，不恢复旧产品名称。先记录失败，再重跑原回归；浏览器与构建夹具均在新建项目内沙箱，固定本地 Windows Chromium，不下载额外浏览器或编码器。

## 接续最终验证

- 固定 Node 24.14.0，协议套件 43/43 通过：包含 42 个既有用例和 1 个换 socket 前退役 bridge 的新增回归。整合进会话 Store 等五个套件后的 89 项也全部通过。
- 修正标题定位器后，真实 Chromium mobile UI + LAN/Channel RPC smoke 整条通过；实际覆盖重连投影、草稿保留、晚 ACK、同 ID 重试、跨目标隔离和远端 session 换代。结果与截图位于 `.run-logs/project-only-validation/five-rounds-mobile-e2e-QExbi5/`。
- WebKit 没有安装，明确 skipped；没有实体手机/完整 Electron/真实 Agent 联调，不能据此声称这些平台已验收。
- 测试入口使用项目内 `five-rounds-mobile-e2e.mjs` 受控包装，固定 HOME/TEMP/浏览器 profile、输出与清理路径；不推荐在未绑定沙箱环境时直接运行旧 bare smoke 命令。
