# 默认模型提示中的内置内容声明

## 产品规则

- ZCodium 的默认系统提示不再注入原有的内置安全声明，包括授权安全测试说明、拒绝条款和双用途工具授权说明，整段移除。
- 普通交互会话、启用 Output Style 的会话和动态工作流子代理遵循同一规则；terminal 与 zcode_desktop 使用同一上下文组装逻辑。
- 身份介绍、Harness、工作流契约、环境、memory、skills 和项目指令继续按当前契约组装。界面与工具权限行为不变。
- 调用方显式提供的 customSystemPrompt、persona、Output Style 和项目指令按原契约保留，不做文本过滤。
- WebFetch 的辅助提取模型不再额外注入四条内置内容限制：引用限长 125 字符、固定逐字引用/改写规则、法律回答限制和禁止复现歌词。普通 URL 继续要求基于页面内容简要回答，预批 URL 继续使用现有提取文案。
- DOCX 合同场景不再一概禁止法律意见、诉讼结果预测或条款效力/合法性结论；其事实准确性、不得编造法律依据或已获授权、信息不足时使用占位符等写作要求继续适用。未指定管辖区时避免具体法律结论的既有信息不足规则保留。

## 所有者与接口

- `apps/zcode-cli/packages/core/src/context/` 是默认系统提示的唯一组装所有者，属于架构策略中的 `zcode-cli` 模块。
- `buildIdentitySection` 负责普通会话身份，`buildWorkflowActorIdentitySection` 负责工作流子代理身份；二者继续共用 `buildHarnessBlock`。
- 删除原安全声明常量及仅用于返回该常量的 `buildSecurityNotice`，不新增替代声明、配置开关或跨模块接口。
- `ContextBuilder.build()` 继续返回现有的 sections、systemMessages 和 metaUserAttachments；不增加状态、持久化或异步事件。
- `tool/handlers/webfetch-processing.ts` 是 WebFetch 辅助模型请求的唯一组装所有者，仍属于 `zcode-cli` 模块；通过现有 `processFetchedContent` 接口执行，不增加接口、配置或文本过滤。调用方 prompt 保持原样；抓取正文沿用既有截断逻辑，本次不额外过滤或改写。
- WebFetch 的预批 URL 标记继续由现有调用链传入；短 Markdown 的直接返回、输入截断、请求追踪、取消及错误传播按现有契约执行。工具权限、网络访问和网页信任边界不属于本次内容声明变更。
- DOCX 合同提示由 `apps/zcode-cli/packages/documents-plugin/skills/docx/scenes/contract.md` 所有，通过主技能现有场景路由按需加载；只删除两条主题限制并调整列表编号，不改变插件启用、技能发现或文档生成接口。

## 生效与迁移边界

- 源码与本地 core 编译输出保持一致；更新后的上下文组装会立即采用新文案。
- 已安装的桌面程序需要后续发布新版才能获得变更；本改动不触发安装包构建或发布。
- 历史记录和调用方提供的文本不作迁移。现有配置校验及失败语义不变。

## 验收场景

1. terminal 与 zcode_desktop 普通会话生成的 systemMessages 不含原声明，身份介绍与 Harness 正常存在。
2. Output Style 的 keepCodingInstructions 为 true 或 false 时，输出风格文案正常保留，原声明均不出现。
3. 匿名和具名工作流子代理的 systemMessages 均不含原声明，persona、Harness 与工作流契约正常保留。
4. 调用方主动提供包含原声明片段的 customSystemPrompt 或 persona 时，原文仍保留，证明此次变更只取消内置注入。
5. 普通和预批 URL 的 WebFetch HTML 提取请求均不再追加上述四条内容限制；页面正文、调用方 prompt 和现有简要回答要求仍存在，返回提取结果。
6. WebFetch 调用方 prompt 或页面正文包含被移除条款时，原文仍保留；预批短 Markdown 继续直接返回且不调用模型，普通 Markdown 仍经辅助模型处理。
7. 合同场景不含上述两条一概禁止的主题限制，其余事实准确性条目、管辖区缺失时的谨慎规则完整，列表编号连续；通过提示资源 diff 核对，不增加仅复述文案的测试。

验证入口：`apps/zcode-cli/packages/core/test/context-system-prompt.test.ts` 与 `apps/zcode-cli/packages/core/test/webfetch-processing.test.ts`，使用该包现有的 Node test runner 与 tsx 执行。
