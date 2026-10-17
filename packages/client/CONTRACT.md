# 客户端连接契约

RemoteServiceAccess 只提供服务代理。创建连接的 adapter 持有 ChannelClient 与 transport：WebSocket 的 close/error、MessagePort 的 attachment/generation dispose 通过既有 owner 同步终结请求，再释放协议与底层资源。WebSocket 对外 onClose 发生在请求终结之后。

不将临时 socket 断开统一解释为所有 transport 的最终关闭，不在 UI 保存另一份已发送请求，不增加重试/超时来掩盖资源所有权缺失。详细规则见 [RPC 连接所有权](../../docs/specs/rpc-connection-ownership.md)。
