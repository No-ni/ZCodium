# Agent 协议值契约

该模块由 Agent contracts 拥有，集中浏览器动作、工作流事件观察面的 JSON 有界化、
模型标识/错误构造、消息/网络 JSON schema、Provider 用量计算与工作流定义/图/事件 schema
和 scheduler 纯派生。它不持有会话、
浏览器、journal 或请求 admission 状态，不执行 IO 或发出事件。

- 原 `browser-control.port.ts` 与 `dynamic-workflow-run.port.ts` 通过本模块公开入口
  `contract.ts` 再导出；`model-contract.ts` 只过滤模型原有公开面，避免将浏览器和工作流
  名称新增到 model 导出。包消费者保留原有导入路径。
- 裁剪只影响观察面，原始事实仍由既有 journal 保存；保留字符串、数组、键数和深度上限、
  非有限数规范化及 UTF-16 代理对边界。
- 浏览器结构保持与 shared 协议镜像的既有约定；不引入 shared/Runtime 依赖或第二套 schema。
- 模型枚举、错误 class、schema 允许值及 input/cache 计数沿用原规则；原 `model/index.ts`
  通过唯一公开入口再导出。模型值文件只按显式依赖引用同模块叶文件，不反向导入原 barrel。
  content block 的 `oneOf` 为每个 kind 提供唯一分支，合法 `tool_reference` 与混合块必须
  可通过实际 JSON schema 验证；空工具名与额外字段继续拒绝。
- `workflow-contract.ts` 保留原工作流公开值；schema 默认值、校验及节点/边的顺序不变。
  snapshot、存储端口和 session link 投影由原入口处理。scheduler 的临时 Map/数组只属于本次
  纯派生调用，不建立跨调用缓存或新的状态所有者。
- 新增范围需要先说明其协议规则，不能将 IO 或业务 owner 放入本模块。
