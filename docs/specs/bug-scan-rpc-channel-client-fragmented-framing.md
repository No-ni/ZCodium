# Bug 扫描：RPC 通道客户端在分片装帧下的字节与生命周期

## 本轮新增的扫描面

前三轮的协议端都是整帧投递。`SocketProtocol` 的 13 字节帧头 + 变长 body 可以被 socket/stdio 任意切片，而 `ChannelClient` 只保证收到“整帧”，这两者之间的拼接由 `ChunkStream` 与 `VSBuffer` 承担，正是 `buffer.ts` 在客户端路径上唯一真正起作用的地方。本轮把真实的 `ChannelClient` + `ChannelServer` + `SocketProtocol` 接到按字节切片投递的假 socket 上，检查分片是否会破坏往返或生命周期。

分片尺寸覆盖 1、2、3、5、7、12、13、14、64、1024、65536 以及整帧一次投递，其中 12/13/14 专门跨在帧头边界上（头前一字节断开、正好断开、头后一字节断开）。

## 已核对的边界

- 载荷边界矩阵（ASCII 127/128/129、UTF-8 三字节字符凑出的 126/129/16383 字节、整数 0/-1/127/128/16384/2097152/负数、浮点、布尔、null、undefined、数组、嵌套对象、顶层 `Uint8Array`、对象内嵌 `Uint8Array`）在每种分片尺寸下都原样往返，两侧请求表归零。
- 210000 字节文本、65540 字节二进制、以及文本与二进制混合的嵌套对象，在单字节分片下字节内容不变，末字节仍正确。
- 40 条并发调用与 6 条订阅混跑：回包按各自请求回收，不串号；每周期各收一次事件；全部退订后对端释放数与挂载数相等。
- 服务端错误（含 `code`、`status`、`retryAfterMs`、`details`）与 `Promise.reject(new Error(...))` 在分片传输上按既有字段集传播，两侧表归零。
- 事件在大载荷分片下按序送达；退订后对端释放一次，之后的事件在两侧都被丢弃。

结论：本轮仍未在 `channelClient.ts`、`channels.ts`、`channels.shared.ts`、`buffer.ts` 内发现可复现缺陷，未改动实现代码。分片拼接与 `VSBuffer` 读写在这些边界上成立。

## 扫描过程中确认的一个夹具陷阱

`ChannelServer` 在构造函数里就发出 Initialize。若同步投递的测试夹具先建服务端再建客户端，握手帧会在 `ChannelClient` 订阅 `onMessage` 之前被丢弃；`ChannelClient` 没有超时或重新索取握手的机制，之后所有请求都会停在 waiting 阶段，表现为调用永久挂起而不是报错。这不是产品缺陷：生产传输（MessagePort、socket、stdio）都是异步投递，构造顺序不会丢帧；本轮把它写成夹具约束并在用例里注明，避免后续扫描把它误判为客户端挂起 bug。

顺带加固了用例本身：每个用例带 15 秒超时，握手顺序写错时表现为明确的超时失败，不再把隔离 runner 挂死。

## 执行边界

`packages/rpc/test/bugScanChannelClientFragmentedFraming.test.ts` 共 5 项，入口 `scripts/ci/bug-scan-rpc-channel-client-fragmented-framing.test.mjs` 经 `runSourceTests` 在 `project-test-sandbox` 隔离环境执行，使用项目内固定 Node 24.14.0。socket 为内存假实现（写入即切片同步投递），不是真实网络；因此结论限于装帧与分片拼接层，不能当作真机网络验证。第 1 轮移交的 `channelServer.ts` 服务端 `listen` 同步抛错一项仍未处理。根 typecheck、lint 与统一扫描记录由父代理负责。
