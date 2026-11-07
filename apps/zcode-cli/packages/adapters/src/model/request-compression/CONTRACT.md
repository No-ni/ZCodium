# model-request-compression

把模型请求的上传正文按渠道压缩（brotli/gzip），不改变响应处理。

不变量：

- `off` 时直接返回内层 transport：不读 body、不加请求头、不加载压缩实现。
- 只处理 JSON 文本正文；FormData、二进制与流式正文原样发送。
- 压缩层必须位于 option map 与协议兼容层之外：它们要读写明文 JSON 正文，先压缩会让其 fail-closed。
- brotli 被网关拒绝（400/415）时用 gzip 重发一次，并在当前进程内记住该渠道，之后直接走 gzip。
- 「brotli 被拒」是运行时事实，不落盘、不进配置；重启后允许重新尝试。

产品规则与验收场景见 `docs/model-provider-request-compression.md`。
