# Bug 扫描：RPC 通道客户端不变量模型验证

## 扫描范围与方法

本轮继续扫 `packages/rpc/src/channelClient.ts`（`channels.ts`、`channels.shared.ts` 无逻辑，`buffer.ts` 第 1 轮已核）。第 1 轮用的是手写用例，覆盖面取决于我能想到的交叠；本轮改成模型驱动：一个参考模型记录每个请求的 id、是否已发出、是否已终结、是否已发过终结帧，再对同一个 `ChannelClient` 跑随机操作序列，逐步对比模型不变量。种子确定（80 个种子 30 步），保证可重复。

被检查的不变量：

- requests 表大小在任何一步都等于模型中未终结请求数（抓订阅/退订泄漏与重复登记）。
- 每个请求 id 至多一次请求帧；终结帧（PromiseCancel/EventDispose）只在真正试发过的请求上出现，且每请求至多一帧。
- 握手前排队的 waiting 请求在收到 Initialize 后按原插入顺序补发，不重复发送。
- EventFire 只投递给当前仍存活且已上线的周期的在册监听；数量精确等于该周期在册监听数。
- 回调内撤销自己或撤销全部监听：本轮事件按快照投完，之后不得再投；退订只发一帧；重订走新 id。
- 令牌取消订阅句柄注册数与释放数相等；每个 `call` 恰好 settle 一次；连接释放后表归零且不再产生任何帧。

## 结论

未发现 `channelClient.ts` 内的新缺陷，本轮不改实现代码。首轮暴露的两个失败都是我的模型自身写错，不是产品缺陷，记下来避免后人重复误判：

- 令牌已取消时客户端在分配 id 之前立即拒绝。我原先仍为该调用预占 id，导致后续所有 id 预测整体偏移，表现为连续的表大小不符。修正为“不占 id、不入表、不发帧”后全部消失。
- 收尾时我把“断开后不得再有帧”的基线写成断开前的帧数，于是把合法的终结帧批次误报成迟到帧。基线应为断开前帧数加本次排空帧数。

## 已核对但判定为设计的行为

- 握手后同一 tick 内新建的请求会抢先同步发送，排在 Initialize 微任务批次之前。既有 spec 只承诺“waiting 请求按原插入顺序安排到微任务发送”，协议本身不承诺跨请求顺序，实测该批次内部确实保持创建顺序。要严格全局有序需要引入第二条队列，属于本仓禁止的重复状态，因此不改，只把实测行为写成断言。
- `dispose(reason)` 保留调用方的错误身份，只有无 reason 的释放才命名为 `ConnectionClosed`。该分层在 `docs/specs/bug-scan-client-messageport-lifecycle.md` 与本仓既有测试里都是明确契约。需要按名字判断断线的消费方（如 runner-stream 的 compact 重试）只能覆盖无 reason 路径，本轮未改动。
- 传输层过滤已核对：`MessagePortProtocol` 只把真实 `Uint8Array` 交给 `onMessage`，流控对象与伪造 control 消息一律丢弃，不会进入 RPC 解码；`SocketProtocol` 只投递整帧 Regular。零长 Regular 会让 `deserialize` 返回 undefined 并在 `header[0]` 抛错（客户端与服务端同形），但本仓写入端每次至少输出一个类型标签字节，合规对端产不出该帧，故按观察记录、不按缺陷修。

## 仍未处理项

第 1 轮移交的 `channelServer.ts` 服务端 `listen` 同步抛错穿透入站消息循环一项仍未处理，需要协议或生命周期决策，不在本轮范围，也没有为它写常驻断言。

## 验收与执行边界

`packages/rpc/test/bugScanChannelClientFuzz.test.ts` 共 3 项：随机不变量用例加两项针对性交叠（回调内撤销自己、回调内撤销全部监听后重订）。入口 `scripts/ci/bug-scan-rpc-channel-client-model-fuzz.test.mjs` 经 `runSourceTests` 在 `project-test-sandbox` 隔离环境执行，使用项目内固定 Node 24.14.0。全程受控内存协议，不接触真实 HOME、TEMP、socket 或 Electron，不代表真实设备曾出现故障。根 typecheck、lint 与统一扫描记录由父代理负责。
