# Bug 扫描：RPC 通道客户端在真实异步传输上的生命周期

## 为什么还要扫这一层

前两轮都在自建同步协议（`send` 直接在当前栈里把帧回灌给对端）上验证，`ChannelClient` 的握手批次用的是微任务发送，而真实传输是宏任务投递。握手前排队的请求、在途退订、跨端口取消这些交错，在同步协议下不可能出现错序，所以那两轮的“无缺陷”结论对异步形态并不成立。本轮把同一个 `ChannelClient` 接到仓库真实传输实现上重扫，补齐这个验证面。

覆盖的传输形态：`MessagePortProtocol` 配 `node:worker_threads` 的真实 `MessageChannel`；`createQueuePair()`（`setTimeout` 投递）；`SocketProtocol` 配真实装帧、写入改到宏任务。每种形态都跑同一组用例，服务端用真实 `ChannelServer`，夹具自行统计监听挂载数、释放数与服务端 token 的取消次数。

## 已核对的异步边界行为

- 订阅上线后对端挂载一次；退订帧确实抵达对端并释放该订阅；重订走新周期，旧周期 id 的迟到事件在两侧都被丢弃，不会串台。
- 取消令牌跨传输生效：客户端本地立即拒绝 `Cancelled`，服务端 token 收到一次取消，其后的服务端错误回包因请求已从唯一表摘除而被忽略，不产生二次 settle。
- 握手前撤回的订阅完全不抵达对端（对端挂载与释放均为零），握手后同一 tick 内的“订阅即退订”按序送达，对端不残留活动请求。
- 握手前排队的订阅与调用在对端就绪后补齐，之后可正常退订与释放。
- 客户端释放同步排空唯一表；在途调用以 `ChannelClient disposed` 终结一次；排空产生的终结帧抵达对端后服务端活动请求表归零。
- 并发压力（25 条即时调用 + 25 条挂起调用 + 20 条订阅，中途取消 15 条、退订 10 条，再整体释放）后，每条调用恰好 settle 一次，两侧资源精确归零，无半终结状态。

结论：本轮仍未在 `channelClient.ts`、`channels.ts`、`channels.shared.ts`、`buffer.ts` 内发现可复现缺陷，未改动实现代码。

## 写用例时踩到的两个坑（避免后人据此误报缺陷）

- 客户端 `dispose()` 同步排空唯一表，但 Promise 的 reject 回调要等一个微任务才执行。在 `dispose()` 返回后立即断言“调用已按预期拒绝”会拿到空数组，看起来像“挂起未终结”，实际是用例没等微任务。表是否排空应当同步断言，settle 结果必须在 await 之后断言。
- 并发用例的存活计数必须按“即时调用已完成、挂起调用与订阅仍存活”分别累加。把 25 条挂起调用误记成 20 条会把唯一表大小断言写成假阳性，看起来像客户端多留了表项。

## 执行边界

`packages/rpc/test/bugScanChannelClientAsyncTransport.test.ts` 共 6 项，每项内部遍历三种传输形态。入口 `scripts/ci/bug-scan-rpc-channel-client-async-transport.test.mjs` 经 `runSourceTests` 在 `project-test-sandbox` 隔离环境内执行，使用项目内固定 Node 24.14.0；真实 `MessageChannel` 端口在沙箱权限模型下可用，用例内每端都显式 `disconnect()`，不留悬挂端口。

这仍然是进程内框架验证：`MessagePortProtocol` 走 Node 的 `MessageChannel`，不是 Electron 渲染进程与主进程之间的真实端口；`SocketProtocol` 用内存假 socket，不是真网络。因此可以声明客户端与 `ChannelServer` 在异步时序下行为一致，不能据此声明真机或真实网络下原先存在或不存在故障。第 1 轮移交的 `channelServer.ts` 服务端 `listen` 同步抛错一项仍未处理。根 typecheck、lint 与统一扫描记录由父代理负责。
