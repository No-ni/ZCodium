# model-request-compression

把模型请求的上传正文按渠道压缩（brotli/gzip），不改变响应处理。

不变量：

- `off` 时直接返回内层 transport：不读 body、不加请求头、不加载压缩实现。
- 只处理 `init.body` 中可确认的 JSON 字符串；FormData、二进制与 `Request` 自带的流原样发送。
- 压缩层位于 option map 与协议兼容层之内、transport 之上：明文正文改写完成后才压缩。
- brotli 固定 quality=4。只有 415 才用同一正文快照的 gzip 重发一次；2xx 才记录成功降级，
  400 或 gzip 仍失败不污染记忆。
- 执行器按渠道、Base URL 和协议持有记忆；换网关/协议的新绑定不沿用旧结果。
- 捕获正文、头部和 signal；取消后立即结束等待，不发送迟到压缩结果、不再重发。
- 「brotli 被拒」是运行时事实，不落盘、不进配置；重启后允许重新尝试。

产品规则与验收场景见 `docs/model-provider-request-compression.md`。
