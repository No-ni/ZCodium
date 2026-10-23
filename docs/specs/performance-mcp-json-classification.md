# 性能扫描：MCP 结果同次展开只分类一次 JSON

## 问题与设计

MCP renderer 的展开回调对同一 resultText 分别为紧凑结果判断、CodeBlock enableSyntaxHighlighting 和 language 调用 looksLikeJson，短合法 JSON 会完整 JSON.parse 三次，长合法 JSON 两次。只需一个布尔分类，解析出的对象并未消费。

已读取 ui 受控上下文、现有 MCP renderer、ToolLayout/CodeBlock 调用和 DESIGN.md。此为 ui legacy 模块内同次同步渲染派生优化；不新增公共接口、跨包边、缓存或状态所有者。

- JSON 分类只在现有 renderContent 被调用时计算；折叠、summary-only、无 presentation 的结果不提前解析。
- visibleError 分支优先，错误展示时不解析被遮挡的结果；无结果不解析。
- 保留 trim、仅 `{` / `[` 开头尝试 JSON.parse、完整严格解析成功才标记 JSON 的规则。
- compact 仍要求去空白后 1–160 字符、无 LF 且不是有效 JSON；JSON primitive、畸形 JSON、空白、CR 与原门禁相同。
- 同一局部 boolean 同时决定 compact、高亮和 language，CodeBlock code、DOM 结构、文案、theme、copy/wrap、参数二级折叠、pending/stopped summary-only 均不变。
- 没有会话/owner/lease/identity、Desktop continuous/mobile replayable 或 accepted queue 变化。

## 验收

以真实 McpToolCallBlock 的 renderContent 回调为测试对象，仅替换 hooks 与叶组件，计数 JSON.parse 并检查输出元素的 code/language/highlight、compact/error/status 分支。先在旧实现执行，复现短 JSON 3 次、长 JSON 2 次解析；新实现至多 1 次。隐藏和错误结果不解析，新旧元素输出对照。此为纯分类等价优化，不改变交互/布局，无新增 UI E2E 场景；相关既有 UI/插件回归及根 typecheck/lint、架构、格式检查另跑。

## 结果

- 旧实现本轮 6 项测试中正确性 3 通过、解析预算 3 失败：11 字符合法 JSON 解析 3 次，5,011 字符和含换行 JSON 解析各 2 次。
- 新实现 6/6 通过，以上均解析 1 次；compact、畸形 JSON、primitive、空白、CR、160 字符边界、原始 code/highlight/language 与隐藏/error 门禁一致。
- 已纳入 106 文件 / 737 项整合回归（包含 plugin-ui），全部通过；这是真实 renderer 的元素/回调测试，不是 GUI E2E。最终门禁见 `performance-scan-verified-improvements.md`。
