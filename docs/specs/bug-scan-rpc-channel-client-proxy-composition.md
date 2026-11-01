# Bug 扫描：RPC 通道客户端与代理层组合路径（第 5 轮收口）

## 本轮扫描面

前四轮把 `ChannelClient` 单独放在受控协议上验到见底，本轮按真实消费方式组合验证：服务端用 `ProxyChannel.fromService` 包装普通 service，客户端用 `ProxyChannel.toService` 拿到代理对象，中间是真实 `ChannelClient` 与 `ChannelServer`。这条路径的特征是每个属性读取都会新建一个订阅周期，而服务端的同名事件在 `fromService` 里被缓存成一个共享的缓冲事件，因此“客户端多周期”和“服务端单源监听”必须各自收敛。

已核对的组合行为：

- 同一服务属性的两次读取是两个独立周期，各发一次 EventListen；服务端共享的源监听只挂一次。
- 周期各自结束时各补一帧 EventDispose；仍有其他周期存活时源监听保持；全部结束后源监听归零、两侧请求表归零。
- 已结束周期不再收事件；重订使用新周期 id。
- 代理方法往返保留返回值与错误字段（`code`、`status`），已完成的调用不占唯一表。
- 释放时：已完成调用保持结果不被改写，同一同步块内发起的在途调用各以 `ChannelClient disposed` 终结一次，唯一表同步排空，退订帧抵达对端后服务端归零，释放后再撤销句柄不产生第二帧。
- 释放后代理方法在本地直接拒绝，不上线，也不产生取消帧。

结论：组合路径仍未暴露 `channelClient.ts`、`channels.ts`、`channels.shared.ts`、`buffer.ts` 内的可复现缺陷，实现代码未改动。

## 本轮新发现的两个范围外能力缺口

两者都在 `packages/rpc/src/proxy-channel.ts`（本轮不可写），且需要设计决策，不在客户端补兜底：

- `ProxyChannel.toService` 的方法包装只调用 `channel.call(propKey, methodArgs)`，从不传 `cancellationToken`；`fromService` 的 `call` 也接收不到令牌。结果是走代理的远程 service 方法在结构上无法取消，即使调用方持有 `CancellationTokenSource`。已实测代理调用期间 `PromiseCancel` 帧数为 0，客户端始终用 `CancellationToken.None`。这是代理层的能力缺口，不是客户端缺陷：客户端的直接调用路径取消语义已在第 1、2 轮验证。
- `fromService` 的注释声称“把事件 buffer 化：即使没人订阅，事件也不会丢失”，但 `bufferEvent` 只有在下游出现订阅者时才向源挂载监听。实测：首次客户端订阅之前触发的源事件不会补发；退订窗口内触发的事件在重订后同样不补发，只从重订之后开始收。本轮把这个真实契约写成了断言，避免后续有人为了让注释成立而让客户端缓存事件——那会在客户端引入第二份状态。

## 前五轮累计结论

扫描范围：`packages/rpc/src/channelClient.ts`、`channels.ts`、`channels.shared.ts`，并按任务允许核对 `buffer.ts`，以及作为对端语义参照的 `channelServer.ts`。方法依次为：手写边界用例、随机操作不变量模型、真实异步传输、分片装帧、代理层组合。

- 范围内未确认到可复现缺陷，因此五轮均未修改上述源文件，也没有为“凑数”改动实现。累计常驻用例 30 项（边界 12、不变量模型 3、异步传输 6、分片装帧 5、代理组合 4），外加既有 vitest 套件 55 项在固定 Node 下全绿。
- 仍未处理的范围外缺陷一项：`channelServer.ts` 的 `dispatch` 对 `channel.listen` 同步抛错执行 `this.finish(record); throw error;`，把异常重新抛回入站消息分发链，而同名的 `call` 同步抛错则被转成正常错误响应。同步内存协议下实测表现为订阅被当作发送失败就地终结、调用方既收不到事件也收不到错误；异步传输下的后果按代码路径推断为客户端订阅静默长期存活，尚未实测。修复需要协议或生命周期决策（事件方向目前没有错误响应类型）。
- 夹具约束一条，四轮里踩到两次：同步投递下必须先建 `ChannelClient` 再建 `ChannelServer`，否则构造期发出的 Initialize 被丢弃；`ChannelClient` 没有超时或重新索取握手机制，此后所有请求停在 waiting 阶段表现为永久挂起。生产传输都是异步投递，不受此顺序影响。

## 执行边界

`packages/rpc/test/bugScanChannelClientProxyComposition.test.ts` 共 4 项，入口 `scripts/ci/bug-scan-rpc-channel-client-proxy-composition.test.mjs` 经 `runSourceTests` 在 `project-test-sandbox` 隔离环境执行，使用项目内固定 Node 24.14.0。既有 vitest 套件用同一 Node 直接执行，`packages/rpc/test` 下这些用例不读写文件系统或环境变量。本轮仍是进程内框架验证，不构成真机、真实网络或完整产品验收；根 typecheck、lint 与统一扫描记录由父代理负责。
