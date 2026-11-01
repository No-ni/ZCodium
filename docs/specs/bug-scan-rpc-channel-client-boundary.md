# Bug 扫描：RPC 通道客户端事件订阅/释放、错误传播与取消边界

## 扫描范围与结论

本轮逐条审计 `packages/rpc/src/channelClient.ts`、`channels.ts`、`channels.shared.ts`，并按需核对 `buffer.ts` 与对端 `channelServer.ts` 的帧语义。审计对象是三类简单边界：事件订阅与释放、错误传播、取消终结。

结论：在上述三个可写文件内未发现可复现缺陷，本轮不改实现代码。已确认的边界行为按 `docs/specs/rpc-client-lifecycle.md` 的唯一 requests 表契约固化为回归用例。另确认一个属于 `channelServer.ts`（本轮不可写范围）且需要协议决策的缺陷，移交父代理，不在客户端加兜底分支掩盖它。

## 已核对的边界规则

- 第一个监听只登记等待请求；未收到 Initialize 前不发帧。等待期内退订或连接释放都不得让该请求上线，也不发取消或 dispose 帧，因为没有对端可通知。
- 同一个 `listen()` 返回的 Event 上多个监听共用一条订阅，只在最后一个监听离开时发一次 EventDispose；不同 `listen()` 调用是各自独立周期，各自分配新 id，退订只结束自己那条，不能替对端结束别人的周期。
- 连接释放后调用方再 dispose 自己的句柄不产生第二个退订帧；终结后的 Event 不接受新监听。
- 对端通知失败（PromiseCancel 或 EventDispose 发送抛错）不复活已终结的请求，也不阻塞后续帧。
- 成功与失败结局都必须解除取消订阅句柄，表归零；订阅即同步取消时迟到返回的句柄立即释放，且不留下请求帧或取消帧。
- 已终结请求的取消回调迟到触发不得改写结局，也不得登记第二份存活。
- 错误传播按既有字段集交付：`PromiseError` 还原 message、name、stack 与 code、kind、status、retryAfterMs、data、detail、details、taskId、traceId；`PromiseErrorObj` 原样交给调用方，不做二次包装。
- 重复 Initialize 只重排仍处 waiting 的请求，已在途请求不重复发送。
- `buffer.ts` 只做帧编码支撑：`writeUInt32BE`/`readUInt32BE` 往返、零长 buffer、`concat`、`slice`、`wrap`、空帧 `deserialize` 容错均符合现有语义，无边界缺陷。

## 移交父代理的确认缺陷（非本轮可写范围）

`channelServer.ts` 的 `dispatch` 对 `channel.call` 同步抛错走 `promise = Promise.reject(error)`，最终产出正常错误响应；但对 `channel.listen` 同步抛错是 `this.finish(record); throw error;`，把异常重新抛回入站消息分发链。两侧后果不同：

- 同步内存协议下，异常沿 `protocol.send` 回灌进客户端自己的 `dispatch` catch，事件订阅被当作发送失败就地终结，调用方拿到一个已订阅句柄但永不收到事件，也收不到任何错误。
- 生产异步协议（MessagePort 或 socket）下，按代码路径推断异常发生在服务端自己的消息循环里，客户端的请求仍在唯一表内、emitter 存活，形成静默的永久空订阅。本轮只在受控同步协议上实际复现，未执行异步传输与真机验证，该推断需由后续轮次或父代理确认。

现有 wire 对事件没有错误响应类型，因此修复需要协议或生命周期决策（例如让事件订阅失败可被对端观察，或明确 `listen` 抛错的服务端策略），不是客户端可单方面补的兜底分支。已用受控同步协议复现：服务端 `listen` 抛错后服务端活动请求归零、调用侧观察不到任何错误。该项未在本轮修改，也没有对应的常驻断言，避免把未修复的设计问题写成通过用例。

## 验收与执行边界

`packages/rpc/test/bugScanChannelClientBoundary.test.ts` 直接导入真实 TS 导出，在受控内存协议上覆盖上述 12 项边界，断言以唯一 requests 表与真实帧序列为准。入口为 `scripts/ci/bug-scan-rpc-channel-client-boundary.test.mjs`，经 `runSourceTests` 在 `project-test-sandbox` 隔离环境内执行，使用项目内固定 Node 24.14.0（路径已由 `assertProjectPath` 校验），不接触真实 HOME、TEMP，不建 socket 或 Electron。

本轮为纯内存框架验证，不代表真实设备或既有业务入口曾出现故障；根 typecheck、lint 与统一扫描记录由父代理负责。
