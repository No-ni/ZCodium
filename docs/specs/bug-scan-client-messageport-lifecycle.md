# Bug 扫描：client messageport 与 RemoteServiceAccess 生命周期（第 1 轮）

## 范围与结论

- 扫描对象：`packages/client/src/messageport.ts`、`packages/client/src/remoteServiceAccess.ts` 的连接、重连换代、事件订阅与 dispose 语义。
- 结论：五轮扫描（第 1 轮基线钉定、第 2 轮对抗场景、第 3 轮换代 churn、第 4 轮并发批量、第 5 轮覆盖终审）**均未确认这两个源文件存在需要修改代码的缺陷**，未改动任何源文件；以 16 项 mock-port 定点回归固化现有契约，供后续 rpc/传输层改动时兜底。
- 写范围：仅新增本 spec、`packages/client/test/bugScanMessageportLifecycle.test.ts` 与 `scripts/ci/bug-scan-client-messageport.test.mjs`；未触碰 `websocket.ts` 与 `packages/rpc` 源。

## 生命周期契约（现状，已由回归钉住）

- 唯一所有者：每个 `MessagePortServiceConnection` 持有自己的 `ChannelClient` 与 `MessagePortProtocol`；dispose 路径固定为 `client.dispose(reason)` 先向 peer 发终结帧并本地 settle，再 `protocol.disconnect()` 摘除 port 监听并 `close()`。
- 幂等与 settle：dispose 重入只关闭 port 一次；挂起与排队中的 Promise 调用分别以传入 reason 或 `ConnectionClosed` 拒绝；server 从未出现（无 Initialize）时 dispose 同样能 settle 排队调用。
- 事件订阅：最后一个监听者释放或连接 dispose 后，旧订阅者不得再收到投递；EventListen 帧到达 server 前 fire 的事件不保证送达（见边界）。
- 换代重连：新旧连接使用各自 port 对；dispose 旧连接后新连接的调用与事件不受影响。这钉住了 messageport.ts 头部注释声称的「换代必须释放 ChannelClient 和底层 port，否则旧挂起 RPC 无法 settle」。
- 映射面：`RemoteServiceAccess` 全部 45 个 proxy 的 channelName 与字段语义一一对应且无重复（静态扫描 + 运行时唯一性断言双重验证）；`attachWindowProjectDirectory` 幂等，重复 attach 不重建代理、不再次 `getChannel`；`providerProvisioningTargetService` 保持不可枚举但对 Host 可用。

## 第 2 轮对抗性场景（同一对象，深化未改码）

- 同一远程事件的多次订阅：每次 `on*` 属性访问生成独立 `EventListen` 请求，退订其一不得影响其余订阅的投递（两条链路独立 settle）。
- dispose 与事件 fire 同轮交错：事件帧仍在 mock port 微任务队列时 dispose，`ChannelClient` 的 `isDisposed` 守卫必须丢弃在途帧，监听者不得收到迟到回调。
- `dispose(reason)` 仅首次生效：重复 dispose 不改写拒绝原因，也不重复 close port。
- 组合选项（`sourceServerManagementService` + `windowProjectDirectory`）：source channel 恰好装配一次，全部名称唯一，装配面可枚举。
- `connectViaMessagePort`：返回装配完成的 `RemoteServiceAccess`，默认不装目录服务。
- 取消令牌路径评估：`ProxyChannel.toService` 不把 `CancellationToken` 透传给 `channel.call` 第三参数，服务代理面上不存在按调用取消的入口；这是 rpc 代理层的能力边界而非这两份文件的缺陷，client 侧修补会伪造取消语义，本轮不动，记录待 rpc 侧决策。

## 第 3 轮：换代 churn 与重订阅

- 12 代连接完整周期（连接→初始化→订阅→事件→挂起调用→dispose）逐代断言：每代只收到本代事件、挂起调用以 `ConnectionClosed` settle、port 恰好 close 一次、`ChannelServer` 活动请求表在 flush 后归零（经内部字段诊断读取，验证 dispose→终结帧→server 回收的完整闭环）。
- 退订后空窗期 fire 的事件不得被回放给重新订阅者：`bufferEvent` 在最后一个监听者释放时清空缓冲并退订源，新订阅只收新事件。

## 第 4 轮：并发批量 dispose

- 同一同步块内发起 10 条 echo、1 条事件订阅并立即 dispose（无任何 microtask 空隙）：全部调用必须以 `ConnectionClosed`/disposed 拒绝，事件监听者不得收到在途帧回调，port 只 close 一次。这模拟旧 attachment 换代时上层不等待任何回包直接释放的路径。

## 第 5 轮：覆盖终审

- `messageport.ts`（59 行）与 `remoteServiceAccess.ts` 的每条运行时路径均已被 16 项回归中的至少一项覆盖：构造装配（选项组合 × 默认路径）、`attachWindowProjectDirectory` 幂等、proxy 面 channelName 唯一性、Host-only 属性不可枚举、Initialize 前/后 dispose、reason 传播与首次生效、事件订阅/多订阅/退订/重订阅、在途帧丢弃、换代互不串扰、`connectViaMessagePort` 装配面。
- 两文件 `git diff` 为空；`tsc -b packages/client` 与 `architecture:check --changed` 通过。

## 越界观察（只报告，未修改）

1. （第 1 轮误报，第 5 轮撤销）曾报告 `packages/web/src/mobile/protocol.ts` 换代不 dispose 旧 `ChannelClient`。复核 `WorkspaceBridgeLifecycle.ensure()` 后确认：所有 `open` 回调之前都同步执行 `invalidate() → releaseBridge()`，其中 `channelClient?.dispose(new Error("连接已中断，请连接后重试"))` 并清空 accessor 与单槽 `onRpcMessage`；socket close 同样先 `bridge.invalidate()`。旧代挂起 RPC 会 settle，不构成缺陷。此处记录以正视听，撤销对父代理的该项转报。
2. 订阅上线窗口丢事件是 `@zcode/rpc` `ProxyChannel.fromService` 的 `bufferEvent` 固有语义：server 侧对源事件的订阅始于 EventListen 帧到达，之前 fire 的事件无人缓冲（第 3 轮回归已把「空窗期事件不回放」钉为预期行为）。客户端两文件无法在不引入第二份缓存/状态所有者的前提下修补；如需消除该窗口应在 rpc 侧对 descriptor 声明「订阅即缓冲」的服务做首帧缓冲设计，本轮不动。

## 验证

- 固定 Node `24.14.0`（`.run-logs/project-only-validation/main-toolchain-6g2BTX/node-v24.14.0-win-x64/node.exe`，路径经 `assertProjectPath` 校验）运行 `node --test scripts/ci/bug-scan-client-messageport.test.mjs`：内层 TAP 16 项全部通过（`# tests 16`），外层入口断言执行数为 16。
- `pnpm architecture:check --changed`：0 违规。`oxlint test src`（packages/client）：0 错误 0 警告。
- `tsc -b packages/client`：通过（两源文件零改动，新增测试不在项目 `include` 内，与既有 `packages/*/test` 约定一致）。
- 复现与调试均在项目工作树与 `project-test-sandbox` 内进行，探针与临时脚本已删除；未执行真机 Electron MessagePort 验证。

## 边界与欠账

- mock port 用微任务投递消息，与真实 MessagePort 的异步投递顺序一致，但未覆盖 flow-control（`sendFlowState`）帧、结构化克隆与真机 backpressure。
- 静态 channelName 扫描覆盖 `createServiceDescriptor` 声明模式；未来若出现非该模式的 descriptor，需以运行时唯一性断言为准。
- 根全量 typecheck/lint 与统一扫描记录由父代理负责；本轮新增文件不进入包 tsconfig `include`，与既有 `packages/*/test` 回归同一约定。
- `serverActiveRequests` 诊断读取依赖 `ChannelServer` 私有字段名；rpc 侧重命名时该断言会显式失败，需同步改为公开诊断接口而非放宽断言。
