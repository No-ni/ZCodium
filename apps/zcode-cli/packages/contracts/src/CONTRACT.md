# Agent 公共契约 SDK

本模块对应现有 `@zcode/contracts` 源码，拥有 Agent 的公共 DTO、端口、schema 及公共
计算/技术上下文工具。登记不改变这些实现，也不把 CLI/runtime 或 Host 状态移入 SDK。

- 公共入口按当前 package.json exports 登记；不向调用方开放实现叶文件。`contract.ts`
  仅作为架构阅读入口，转发既有 `index.ts`，不会增加包的 exports。
- CLI 仍独占会话事实、runtime admission 和 journal 写入；Host 仍独占组织态、未读 CAS、
  分组与跨窗口路由。SDK 只定义端口和值，既有通用内存/trace 辅助保持原语义。
- 身份使用 workspaceIdentity 与路径 fallback 的既有契约；cwd、CLI 时间和恢复语义不由
  SDK 登记重算。原有类型与 runtime schema 必须保持一致。
- 依赖 shared 的公开协议，以及独立的 agent-protocol-values；不引用 Agent Runtime、
  Service、Repo 或平台 UI 的具体实现。Node 技术上下文工具不拥有应用业务状态。
- 拆分 SDK 类型须保持旧公共导入路径；消费者依赖按实际源码登记，不能靠 baseline 豁免。
