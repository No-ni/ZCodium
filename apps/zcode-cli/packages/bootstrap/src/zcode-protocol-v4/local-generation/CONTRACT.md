# 本机生成数值派生

由真实 live SessionEvent 派生 extension-host-protocol 的严格 LocalGenerationFact。只对白名单主轮请求和无父工具的文本/思考 delta 生成数值；不发送正文、配置、URL、headers、工具输入或原始错误。无状态、无队列、无写盘、无网络。调用方 Gateway 只负责发通知，当前 chat client 验证后交 Window Host 唯一聚合；不进入 snapshot/手机回放。规格见 docs/specs/official-3.18.2-integration.md 的扩展本地生成速率。
