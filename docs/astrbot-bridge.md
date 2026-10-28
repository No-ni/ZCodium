# AstrBot 桥接

ZCodium 的 AstrBot provider 接入现有 BotsService，由外部 AstrBot connector 对接聊天平台；不是代码上游或官方云服务依赖。

## 本地连接

在机器人设置中配置 AstrBot、允许的工作区并启用桥接。连接参数由本机运行时文件 `.zcodium/v2/bots-bridge.runtime.v2.json` 提供；使用设置页的绑定码完成绑定。桥接采用本地 loopback WebSocket 和 Bearer token，不应将 token、运行时文件或完整配置公开。

ZCodium 持有机器人配置、绑定和会话状态；connector 负责平台消息接收及转发。对话按用户选择的机器人平台和模型 Provider 传输，平台的存储与数据规则由其自身决定。设置页打开本文档不会自动安装、拉取或启用任何第三方服务。

## 外部 connector 来源

已有配套 connector 的历史来源是 [axiom-desu/astrbot-zcodium-plugin](https://github.com/axiom-desu/astrbot-zcodium-plugin)。这是独立第三方项目，不是本仓维护的仓库，也不是 ZCodium 的同步源。安装前自行核对源码、许可证、AstrBot 版本及 bridge v2 兼容性；本次维护清理未验证该仓库最新版本的安装或真机连通。

协议、鉴权、轮次序列与有限回放的实现边界见 [桥接 spec](../.agents/specs/bots-astrbot-bridge.md)。
