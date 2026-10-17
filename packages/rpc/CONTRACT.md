# RPC 所有权契约

RPC 负责连接级调用、订阅和二进制分帧，不持有业务 accepted-input、workspace identity、Host lease、快照或重放状态。

- ChannelClient 的 requests 是客户端请求存活的唯一事实，所有终结经过 finish。
- ChannelServer 的 requests 是服务端等待/活动请求的唯一事实，所有终结经过 finish；正常完成不取消业务 token，迟到结果不编码或发送。
- ChunkStream 与未确认帧复用一个内部 FIFO，消费立即释放引用，整理工作量摊销线性。
- serialize 仅产生可由 deserialize 读取的帧；不可编码根值在本地抛错，不用空 Object JSON 把错误推迟到对端。
- 连接 adapter 持有 Client/Server 和 Protocol；终结先释放请求，再释放协议。SocketProtocol 不拥有 socket；PersistentProtocol 按既有重连契约拥有 socket，当前无产品调用方。

行为、顺序与验收统一维护于 [客户端生命周期](../../docs/specs/rpc-client-lifecycle.md)、[服务端生命周期](../../docs/specs/rpc-server-lifecycle.md)、[字节队列](../../docs/specs/rpc-byte-queues.md)、[连接所有权](../../docs/specs/rpc-connection-ownership.md)。此前按轮次的性能规格保留为历史记录，后续修改更新上述契约与对应测试。
