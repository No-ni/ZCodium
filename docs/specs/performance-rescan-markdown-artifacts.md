# Markdown artifact 图片定向替换与无引用快路径

## 范围与现有契约

- 唯一实现位于 `packages/shared/src/markdown-artifact-images.ts`，共享纯字符串转换由消息渲染复用；不引入状态、IO、缓存或新跨模块接口。
- `extractMarkdownArtifactImageRefs` 保留文档顺序去重；代码围栏中的伪图片保持忽略。
- `rewriteMarkdownArtifactImageSources` 仅替换图片目标里的 `zcode-artifact://` 引用，保留 alt、title、空白、尖括号以及围栏原文。
- 现有协议、合法 Markdown 图片识别范围、解码失败返回 null 的行为保持不变；不触及调用方的路径权限校验。本轮不扩展 Markdown 语法支持。

## 确认问题与决策

图片匹配后再次对整个图片文本执行 `image.replace(ref, ...)` 会误替换 alt 中更早出现的相同引用，实际目标反而不变。修复使用正则目标捕获的明确位置，仅替换目标，不用在整个匹配文本里二次搜索。

回归还确认 Windows CRLF 行尾的 `\r` 导致围栏正则不匹配，代码示例中的图片被意外重写。围栏匹配只新增对末尾 `\r` 的兼容，输出保留原始行尾，不改变其他开闭规则。

普通消息不包含 `zcode-artifact://` 时仍逐行 split/map/join，流式刷新会重复分配行数组。两个公开入口先做精确协议标记检查，缺席时直接返回原文/空结果，不进入围栏扫描；有标记时语义保持一致。不引入持久缓存；无标记文本的快路径为 O(n)，有标记文本沿用原有匹配算法，不宣称对任意输入都具有线性复杂度。

## 验收

1. alt 中引用与目标完全相同时，alt 保持原样，仅目标编码。
2. alt 中包含目标作为子串、以及 title 中重复引用，仍只替换目标。
3. 普通目标、尖括号目标、多个引用及首见去重正确。
4. 反引号/波浪号围栏、CRLF、现有围栏开闭规则保持原样。
5. 无协议标记的大文本直接返回原文/空列表，调用计数证明不执行逐行 split；普通外部图片不变化。
6. 解码的 round-trip、无关源、损坏编码保持原行为。

## 验证边界

采用共享纯函数的确定性回归，测试只使用内存字符串，经项目内隔离 source test runner 执行，11/11 项通过。主代理整合后实际执行 corepack pnpm typecheck、corepack pnpm lint 与 architecture:check --changed：类型检查通过，Lint 为 0 错误及 2 条开工前已有警告，架构违规为 0。未改变 UI 交互或异步状态；不声称真机端到端、整体帧率或堆内存实测收益。
