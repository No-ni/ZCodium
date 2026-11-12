# 原生上下文压缩：参数目录

2026-11-12。关联 [产品方案](native-context-compression.md)、[趋势页面](native-context-compression-trends.md)、[实施契约](native-context-compression-implementation.md)。配置 schema、正式表单及 Runtime 接口已落地，关键端到端缺陷修复与验收收尾中。

用户已要求适用的各种参数可调。下面同时定义可调范围、固定正确性规则、已有状态所有者，以及不移植的宿主功能；不能把「配置文件接受了字段」当作「字段实际生效」。初值为实现时待验收的建议。公开 90 个 descriptor 的当前消费者与验证边界见[参数实现映射](native-context-compression-parameter-mapping.md)。

## 1. 同一参数源，两个保存目标

任务详情「参数」与常规设置「调整默认参数」复用同一字段 schema 和分组表单。完整配置编辑器使用同一 schema，覆盖普通表单与各组高级字段；不存在仅靠环境变量调整的产品参数。

详情四页签中的「趋势」使用已冻结的实际策略版本，只读范围、模型分段和系列选择不写入压缩参数。切换趋势/记录、关闭再打开时，表单草稿与尚未校验的 JSON 文本均按当前任务/新任务默认分别保留；只有「保存参数」改变目标策略。修改阈值、图片尺寸或提示词不会重估历史曲线。

- 新任务默认：Local Host 的既有配置服务保存 mode 与完整参数快照；创建意图捕获后由目标 CLI 固化。当前任务与远端 General 配置不随之修改。
- 默认保存完成后通过同一 `useSettings` cache key 的 `readFresh()` 从 Local Host 读取实际完整配置及递增版本，并发布到既有共享快照后再确认成功。确认读取等待 ACK 前的在途刷新结束并启动新的读取，不能合并到旧响应；读取失败或候选不一致时保留草稿与错误状态，不能把旧设置缓存当作提交证明，也不能只更新表单版本而留下旧配置缓存。
- 当前任务：AgentRuntime 校验完整候选，按 expectedPolicyVersion 经 CLI admission 原子提交到 SessionStore。下一安全请求检查点使用新版本。
- 字段来源：显示「创建时默认」「当前自定义」与只读的「实际生效值」。采用全局默认、恢复推荐值和导入都先进入草稿，保存才生效。
- fork/恢复：复制稳定分叉边界的完整策略与来源，不重新合并今日全局默认。升级 schema 保留显式值，新增字段按记录的版本迁移默认填充；不能自动恢复推荐值。

策略形态为 `{ schemaVersion, policyVersion, mode, parameters }`，mode 为 auto/manual；schemaVersion 管字段含义，policyVersion 管本任务提交版本。下列路径相对于 parameters。百分数统一使用 0–100 的值；只有带 kind 的阈值可用绝对 token。UI 与 Runtime 均拒绝 NaN、Infinity、未知字段和非法组合。

关闭 auto 停止新的自动增量摘要、大输出引用和本功能的性能降采样；参数保留可编辑，手动维护使用同一策略。已提交摘要与既有 microcompact/容量校验仍遵循主方案。各子功能关闭不会关闭原文读取、保护区和 Provider 硬限制。

## 2. 触发与节奏

`B` 指当前 ModelPort 的可用输入预算，已扣除既有输出预留与安全余量。百分比阈值基于 B，窗口容量仍按现有用量组件显示，二者不混用。

| 字段                                     | 推荐初值                  | 可调范围及含义                                                                |
| ---------------------------------------- | ------------------------- | ----------------------------------------------------------------------------- |
| trigger.start                            | `{kind:percent,value:70}` | percent 1–95 或 tokens 正整数；达到后请求前检查合格历史；不是硬容量上限       |
| trigger.target                           | `{kind:percent,value:50}` | percent 0–94 或 tokens 非负整数；解析后必须小于 start；目标不能越过保护区     |
| trigger.opportunisticPercent             | 45                        | 0–95 且不高于当前解析的 start；增长/周期检查的最低使用率                      |
| trigger.capacityPercent                  | 95                        | start 以上至 100；进入既有容量后备检查，不授权内核紧急删除内容                |
| trigger.growthMode                       | constant                  | constant/adaptive；只启用所选增长算法，另一组保留值并标注未启用               |
| trigger.growthTokens                     | 50000                     | 正整数；constant 模式的新增合格内容门槛                                       |
| trigger.tierGrowthTokens                 | 各层 auto                 | t1/t2/t3 各可选 auto 或正整数 token；auto 使用增长门槛及层级倍率              |
| trigger.minBenefitTokens                 | auto                      | auto 或非负整数；auto 为 max(5000,round(B×1%))；即使设 0 仍拒绝非正净收益     |
| trigger.checkIntervalRounds              | 5                         | 1–1000 个模型轮；普通增长检查间隔，压力/容量检查不受此间隔拖延                |
| trigger.periodicCheckRounds              | 15                        | 0–1000 个模型轮；0 关闭周期补查，不关闭压力检查                               |
| trigger.waitForUsageSample               | true                      | boolean；压力判断优先等待实际样本，不能无限等待                               |
| trigger.estimateHoldRounds               | 2                         | 0–20；0 不等待，仅前项开启时生效；硬容量校验不能被等待绕过                    |
| trigger.modelDecides                     | false                     | boolean；仅机会性检查可先询问选定摘要模型，额外请求按同一 execution/Goal 记账 |
| trigger.decisionMaxOutputTokens          | 200                       | 32–2048 且受选定模型上限约束；仅 modelDecides 开启时生效                      |
| trigger.adaptive.ratioPercent            | 5                         | 0–100；adaptive 增长门槛的 B 比例                                             |
| trigger.adaptive.floorTokens / capTokens | 50000 / 50000             | 正整数且 floor≤cap；只在 adaptive 生效                                        |
| trigger.adaptive.minGrowthFloorTokens    | 20000                     | 非负整数；减少反复小批维护                                                    |
| trigger.adaptive.minGrowthRatioPercent   | 45                        | 0–100；与 minGrowthFloorTokens 共同提供再次维护的增长门槛                     |
| trigger.adaptive.tierMultiplier          | 1.5                       | ≥1 的有限数；未显式指定层级门槛时用于 t2/t3 派生                              |

检查计算本身不调用模型。每检查点最多一批维护、同历史版本无新收益不重复发请求是固定调度规则，不是可关掉的参数。模型自决失败只跳过该次机会性维护，不能伪造成功、绕过容量处理或切换 Provider。

## 3. 历史与摘要

| 字段                                      | 推荐初值    | 可调范围及含义                                                                     |
| ----------------------------------------- | ----------- | ---------------------------------------------------------------------------------- |
| history.preserveTurns                     | 4           | 0–100 个完整交互轮；始终加上当前未完成轮和硬保护内容                               |
| history.preserveMessages                  | 3           | 0–1000 条 canonical 消息；与轮/token 保护取并集，不按拆分后的图片/工具 part 数计轮 |
| history.preserveTokens                    | 5000        | 非负整数 token；按完整组扩展保护，不截断组来满足数字                               |
| history.protectedTools                    | []          | 已注册工具的名称/受控后缀通配模式；保护全部历史实例                                |
| history.protectedLatestTools              | []          | 名称/模式；保护每类最新完整实例，适用于累计快照工具                                |
| history.earlyFoldTools                    | []          | 名称/模式；只允许已完成工具结果提前离开软近期区，不能解除当前未完成轮或硬保护      |
| history.preserveRecentTools               | []          | 从 earlyFoldTools 中减去的名称/模式；两者只生成一个派生的有效排除列表              |
| summary.minRangeChars                     | 5000        | 非负整数字符；0 关闭长度门槛，覆盖与收益校验仍在                                   |
| summary.minChars                          | 50          | 非负整数字符；单范围按自身校验，原生批量按合计校验；每个摘要始终不得为空           |
| summary.maxChars                          | 20000       | 0 或正整数字符；0 关闭字符上限，模型输出预算仍有界；不能截掉超长回复冒充合法摘要   |
| summary.minReductionPercent               | 10          | 0–99；同模型/边界净输入收益门槛；0 仍要求正净收益，非字符比或价格收益              |
| summary.tiersEnabled                      | true        | boolean；关闭后不启动新多层蒸馏，已有合法块可读可用                                |
| summary.tier2BlockCount / tier3BlockCount | 1000 / 2000 | 正整数个当前生效低层块；tier3>tier2；不是 token 或消息数                           |
| summary.promotionSurvivals                | 5           | ≥1 次存活/维护代数；只影响合并资格，不因块老化删除摘要                             |
| reasoning.completedMode                   | retain      | retain/provider-safe-omit；omit 仅允许已结束且目标模型契约允许省略的推理块         |
| reasoning.thresholdChars                  | 2048        | 非负整数字符；仅 omit 生效；签名/redacted/未完成推理按 Provider 既有协议保护       |

工具列表的 [] 明确表示空列表；不继承上游针对 read/bash 的默认提前折叠规则。工具名来自目标运行态 registry，保存历史通配模式不要求某个 MCP 此刻在线，但运行时只匹配真实工具身份。UI 显示解析后的有效保护表；代码中必须使用既有工具/消息分类器，不在文本里猜角色。

有效工具保护表位于当前任务参数页的「历史与摘要」组之后，由 Runtime 使用当前 `registry.list()` 和同一内核工具模式匹配器解析已保存策略。`NativeContextStatus.resolvedToolProtection` 为可选只读字段：`{ items, total }`；每项包含 `name` 及 `protected / latest / earlyFold / preserveRecent / referenceExcluded / distillExcluded` 六个 boolean。工具名非空且最多 512 字符，`items` 最多 200 项，`total` 为非负整数且不能小于已返回项数。UI 不用未保存参数重新匹配；编辑期间明确提示表中是已保存策略，超出 200 项显示「已列出 / 总数」。字段缺席表示运行态工具集合尚不可用，空集合与缺席分别呈现。新任务默认编辑器没有运行态 registry，不展示此表。手机纵向呈现同一工具的规则，桌面用表格，均保持完整名称与明确的启用/关闭状态，不在页内产生横向溢出。

硬保护始终包含最新真实用户请求、未完成轮、工具调用/结果配对、权限/技能/计划/Goal 等有效状态。用户参数只能扩大这些保护，不能解除。上游源码的 tier 注释仍提及 5/10，但当前 defaultConfig 实值为 1000/2000；本目录以实值为初始参考，不以注释当行为。

## 4. 工具输出与回取

| 字段                               | 推荐初值       | 可调范围及含义                                                                                                                     |
| ---------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| tools.reference.enabled            | true           | boolean；完整原文可读后才把大输出换成引用                                                                                          |
| tools.reference.minTokens          | 4000           | 非负整数；0 表示全部合格结果仍须有净收益                                                                                           |
| tools.reference.headChars          | 96             | 0–4000 字符；类型、成功/失败、完整来源引用不属于可省略的预览                                                                       |
| tools.reference.excludeTools       | []             | 名称/受控模式；硬保护工具也始终排除                                                                                                |
| tools.reference.inlineReadTokens   | 4000           | 128–25000，受当前读取预算约束；更长文本返回分页引用，不导出到任意宿主目录                                                          |
| tools.distill.enabled              | false          | boolean；可选即时模型摘要，成本计入当前执行；默认仍先用引用                                                                        |
| tools.distill.minTokens            | 4000           | 非负整数；与合格/收益规则共同检查                                                                                                  |
| tools.distill.minContextPercent    | 0              | 0–100；0 只按内容门槛                                                                                                              |
| tools.distill.mediaOnly            | true           | boolean；携图结果可按模态预算判断，不把 base64 文本长度当图片 token；指定模型须支持图片                                            |
| tools.distill.excludeTools         | []             | 名称/受控模式；模型摘要仍不能执行旧工具内容中的指令                                                                                |
| tools.simplify.enabled             | false          | boolean；对应 kernel crush，必须同时启用 distill 才开放其入口                                                                      |
| tools.simplify.minReductionPercent | 10             | >0 至 100；确定性输出简化的净收益门槛                                                                                              |
| tools.simplify.strategies          | 注册策略默认表 | 每个已注册策略的 enabled 与 excludeTools 可调整；json-fold/code-trim/log-select 等按实际 adapter registry 提供，拒绝任意可执行插件 |
| retrieval.planAware                | false          | boolean；从既有计划 owner 取得只读状态来重排检索，不复制或修改计划                                                                 |
| retrieval.maxHits                  | 20             | 1–1000；当前会话内检索条数上限                                                                                                     |
| retrieval.textPageTokens           | 4000           | 128–25000，受既有工具/输入预算约束；有界原文分页                                                                                   |

同一结果优先级为：硬保护 → 既有格式/协议处理 → 选定的一种内容转换。reference 命中后不再 distill/crush；distill 允许 crush 作为自身有界前置步骤，但引用完整原文必须指向转换前来源。不能在多个管线重复转换同一原文。依赖不满足时表单明确禁用并解释；导入非法组合报错，不静默打开其他功能。

上游参考页的 absorb.minToolTokens 仍写 1000，当前 kernel defaultConfig 为 4000；本方案采用后者。toolName/原文引用格式是固定协议，不提供用户重命名参数。

## 5. 图片

| 字段                       | 推荐初值                 | 可调范围及含义                                                                                      |
| -------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------- |
| images.rescale             | true                     | boolean；控制本功能的性能降采样，不关闭既有文件/Provider 容量边界                                   |
| images.foldWithHistory     | true                     | boolean；图片随合法历史摘要范围折叠，关闭后图片仍留在投影；独立于发送副本缩放                       |
| images.omitSeen            | false                    | boolean；可选地把已成功提供且离开保护区的图片换成来源说明；不要求先生成历史摘要，默认先沿用历史折叠 |
| images.keepRecentUserTurns | 1                        | 1–100 个用户轮；仅 omitSeen 生效，扩大图片保留范围；最新真实用户上传与未完成轮始终保护              |
| images.convention.enabled  | true                     | boolean；在稳定提示段中提醒模型按需要看图、写下结论及按引用回取；不替代真实视觉验收                 |
| images.convention.text     | 空值                     | 字符串≤8000 字符；空值使用内置指导，只改指导文案，不关闭来源、发送证明或保护校验                    |
| images.triggerMode         | edge                     | edge/edge-or-bytes；edge 与上游普通路径一致；后者是原生增强，允许小尺寸大字节图片尝试重编码         |
| images.maxEdge             | 1600                     | 128–8192 px，受目标能力限制；只缩小、不放大                                                         |
| images.byteTriggerKiB      | 100                      | 0–20480 KiB；仅 edge-or-bytes 生效，单位为解码后字节；不是 base64 字符数                            |
| images.jpegQuality         | 80                       | 1–100 的目标质量；仅 JPEG 编码生效；实际尝试不得低于 minJpegQuality                                 |
| images.minJpegQuality      | 60                       | 1–jpegQuality；发送硬预算需要继续压缩时的质量下限，不能沿用固定 80/60/40/20 绕过它                  |
| images.minEdge             | 512                      | 128–maxEdge px；需要继续降采样时的最小长边；较小原图不放大；不能满足硬预算时明确不可内联            |
| images.minReductionPercent | 20                       | 0–99；包含必要注释开销后才采用较小发送副本；0 仍须严格变小                                          |
| images.pngMode             | preserve                 | preserve/jpeg-if-opaque；默认保留 PNG，后者仅可对不透明图片转换 JPEG                                |
| images.alphaMode           | preserve                 | preserve/flatten；flatten 必须明确选定固定底色，不从 UI 主题取色                                    |
| images.flattenColor        | #ffffff                  | RGB hex；仅 flatten 生效；固定值保证主题切换不重写请求字节                                          |
| images.targetRawKiB        | auto                     | auto 或 ≥16 KiB，不能超过当前来源/Provider 硬限制；auto 沿用既有发送预算                            |
| images.sourceKinds         | attachment/read/bash/mcp | 可调整的来源集合；仅模型实际携带的图片，不能包含纯 UI 展示截图                                      |
| images.cacheMaxEntries     | 512                      | 0–4096；0 关闭编码缓存，原图来源与记录继续保留                                                      |
| images.cacheMaxMiB         | 64                       | 0–256 MiB；同时按 entries/bytes 边界管理副本，0 不保留副本缓存                                      |

普通上游路径的 byte gate 不代表只凭字节就会重编码；其 doRescale 对未超边长图片返回 no-op。edge-or-bytes、PNG/透明度、质量与缓存上限的页面配置是 ZCodium 原生增强设计，不能宣传为现上游完整 GUI 已有。

PNG/JPEG/BMP 在目标模型接受且处理器可靠时可进入本功能；动画 GIF/WebP、未知/无法安全解码的格式沿用既有兼容处理，不提供丢帧开关。目标没有图片能力时明确不可用。Provider 的 detail 字段继续归现有模型能力/请求 owner，不用改 detail 假冒图片压缩。

图片源必须是会话冻结的实际原字节；原图查看与模型原图读取始终可用且不二次降采样。原图读取超出硬预算返回明确不可内联结果与只读来源，不暗中压回小图。历史只有处理后副本时显示这一限制，不把原图保留设成可关闭选项。

原图存储在既有会话 artifact 管理范围；只缓存发送副本。缓存 key 包含 source hash、图片完整策略 hash、处理器编码版本及相关目标能力；不包含不影响编码的 UI 主题，也不能只含原内容 hash。恢复/fork 重建或重新计算副本时不改写原图或稳定时间。

omitSeen 对应补丁 0.6.4 新增的重复图片携带策略。Runtime 只有在相应模型请求成功完成、响应已提交且原图可恢复后，才记录图片已提供的证明；证明绑定当前分支、request/execution、稳定 message/part、实际发送副本 hash、目标模型与编码策略。只发送出去、收到响应头、取消或重试失败都不能当作模型已经接收。模型或发送副本发生变化时，旧证明不授权省略新的图片表示。

此策略不按「请求数组最后一项」推测最新用户消息，不只按内容 hash 在多个消息之间共享已提供状态。原图回取结果具有结构化的一次请求豁免：必须真的发送给需要它的模型请求，不能立即又折叠或降采样；后续请求仍按当前保护与策略判断。关闭 omitSeen 后，尚未被文本摘要覆盖且可用的图片在下一安全点重新参与请求，明确重新计算输入预算；不会展开已提交的文本摘要。关闭 auto 只停止新自动决策，已生效的记录仍按主方案处理。

现有 Jimp 处理器为满足预算会尝试固定质量档 80/60/40/20 与更小尺寸；原生扩展必须传入目标/最低质量与最小长边，不能先用固定档处理后再装作已应用用户参数。记录显示实际质量、尺寸与策略。到达下限仍超硬预算时走现有明确错误/只读来源结果，不静默删图或继续降质。

## 6. 模型与提示词

| 字段                        | 推荐初值       | 可调范围及含义                                                                                    |
| --------------------------- | -------------- | ------------------------------------------------------------------------------------------------- |
| maintenance.model           | follow-current | follow-current 或目标环境已有 ModelSelection 引用；仅指定一个摘要模型，无自动跨 Provider fallback |
| maintenance.stream          | auto           | auto/always；auto 沿用选定 ModelPort 的能力，always 仅在可流式时可选                              |
| maintenance.maxOutputTokens | auto           | auto 或正整数，受实际输出上限与执行预算约束；覆盖摘要及多段返回结构的必要开销                     |
| prompts.pack                | default        | default/lean；内置可维护包，不支持任意用户/项目文件路径查找                                       |
| prompts.compressPhilosophy  | 内置           | 空值用内置；自定义字符串≤16000 字符，仅改变摘要指导                                               |
| prompts.howToCompressRules  | 内置           | 同上；Runtime 的实际范围/配对/完整性校验不随文案变化                                              |
| prompts.tier2DistillRules   | 内置           | 同上，仅 tiers 开启并进行 t2 维护时使用                                                           |
| prompts.tier3CondenseRules  | 内置           | 同上，仅 t3 维护时使用                                                                            |
| prompts.visibilityMarkers   | true           | boolean；控制模型可见的说明，不隐藏 UI 记录或关闭原文来源校验                                     |
| prompts.messageTimestamps   | true           | boolean；控制模型视图中的时间标签，已持久首见时间仍保留，不允许重打时间                           |

指定模型复用现有模型候选、配置引用与调用 port；不在压缩页增加 Key、base URL 或隐藏临时 Provider。远程不可解析的引用保存/创建时说明原因。普通摘要调用仍有界、计费、可取消；本功能不调用子代理。follow-current 自动固定 execution 模型，手动固定点击时选择；显式模型则固定已提交策略中的引用。

自定义提示词只替换策略指导段，低信任历史和不可变的宿主规则独立组合；不执行旧历史指令。图片/提示词参数保存可能改变后续前缀缓存；已生效摘要不因此自动重算。

## 7. 上游 75 个配置条目的处置

核对基线：ranxianglei/billion-context dc041dd1ab1a014efa352ba47a6f31fc47f55284，kernel 0.0.195；[参考 schema](https://github.com/ranxianglei/billion-context/blob/dc041dd1ab1a014efa352ba47a6f31fc47f55284/website/config-reference/compress.yaml) 共 75 条，含分组对象与叶字段，不能称为 75 个独立有效开关。相较本轮初查 e3220ad，新增 blockOps 与其 enabled；UI 以本目录的可用原生字段为准。

| 上游条目                               | 原生处置 / 对应字段                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| compress.modelContextLimit             | 既有 Model 输入预算 owner；只读实际值并链接模型设置，不再存一个窗口覆盖                        |
| compress.maxContextLimit               | trigger.start；% 与绝对 token 经过明确单位转换                                                 |
| compress.emergencyThresholdPercent     | trigger.capacityPercent；只协调容量检查，不移植紧急截断节点                                    |
| compress.outputHeadroomMaxPct          | 既有 Model 输出预留 owner；本页显示实际值，导入不能覆盖它                                      |
| compress.nudgeGrowthTokens             | trigger.growthTokens                                                                           |
| compress.tierNudgeTokens               | trigger.tierGrowthTokens                                                                       |
| compress.minPressureBenefitTokens      | trigger.minBenefitTokens                                                                       |
| compress.requireUsageSampleForPressure | trigger.waitForUsageSample                                                                     |
| compress.maxEstimateHoldRounds         | trigger.estimateHoldRounds                                                                     |
| compress.nudgeModelDecided             | trigger.modelDecides；原生维护调用，无 side agent                                              |
| compress.nudgeDecisionMaxTokens        | trigger.decisionMaxOutputTokens                                                                |
| compress.requireNudge                  | 固定 admission 规则；仅已接纳维护可提交，不移植可关闭的提醒信用校验                            |
| compress.requireRecommendation         | 固定候选范围校验；不能关闭                                                                     |
| compress.streamSummary                 | maintenance.stream；转换为 auto/always 并验证能力                                              |
| compress.preserveRecentMessages        | history.preserveMessages                                                                       |
| compress.preserveRecentTokens          | history.preserveTokens                                                                         |
| compress.minCompressRangeChars         | summary.minRangeChars                                                                          |
| compress.maxSummaryLength              | summary.maxChars；单位字符                                                                     |
| compress.minSummaryLength              | summary.minChars；单位字符                                                                     |
| compress.reconcile                     | 原生分支/generation/完整前缀一致性固定执行，不提供 off/warn 绕过                               |
| compress.promptPack                    | prompts.pack；仅映射已存在内置包，外部路径不移植                                               |
| compress.tiers                         | summary.tiersEnabled                                                                           |
| compress.protectedTools                | history.protectedTools；原生硬保护叠加                                                         |
| compress.protectedLatestTools          | history.protectedLatestTools                                                                   |
| compress.neverPreserveRecentTools      | history.earlyFoldTools；不能放松当前轮/配对硬保护                                              |
| compress.preserveRecentTools           | history.preserveRecentTools；[] 在原生明确为空减法列表                                         |
| compress.visibilityMarkers             | prompts.visibilityMarkers                                                                      |
| compress.messageTimestamps             | prompts.messageTimestamps；固定首见时间保留                                                    |
| compress.rules                         | 不移植新 acp_rule owner；已有计划/技能/权限/Goal 状态保留原 owner                              |
| compress.injectTool                    | 原生工具 registry 固定接口，不能通过任务参数删除读取/维护协议                                  |
| compress.injectNudge                   | 原生调度与 auto/manual 统一管理，不移植第二个全局开关                                          |
| compress.reasoning                     | reasoning 分组；按 Model 契约校验，不透传内部对象                                              |
| compress.absorb                        | tools.distill 分组；可调但默认关闭                                                             |
| compress.blockOps                      | 新增的摘要块停用/恢复/改写能力；列为后续产品候选，首版不注入工具，不以无效开关冒充支持         |
| compress.ccr                           | tools.reference 分组；使用既有会话 artifact 与原文来源                                         |
| compress.search                        | retrieval 分组                                                                                 |
| compress.search.planAware              | retrieval.planAware                                                                            |
| compress.prompts                       | prompts 分组；不可变宿主校验独立                                                               |
| compress.reasoningGuard                | 不移植 Provider 格式/推理继续修补循环，超出压缩参数 owner                                      |
| compress.outputSteering                | 已有回答风格/模型 effort 的独立 owner；不在压缩策略重复覆盖                                    |
| compress.priceProfile                  | 本方案使用实际用量，不提供推算价格配置；不移植                                                 |
| compress.externalSummary               | maintenance.model 的单一显式选择；上游外部 Provider 配置、自动链式 fallback 不移植，导入须报告 |
| compress.acknowledgePromptsRisk        | 上游宿主文案编辑门控，不形成原生生效参数；导入报告不适用，不模拟权限批准                       |
| compress.absorb.enabled                | tools.distill.enabled                                                                          |
| compress.absorb.minToolTokens          | tools.distill.minTokens                                                                        |
| compress.absorb.contextThresholdPct    | tools.distill.minContextPercent                                                                |
| compress.absorb.excludeTools           | tools.distill.excludeTools                                                                     |
| compress.absorb.toolName               | 固定原生维护工具接口；拒绝重命名                                                               |
| compress.absorb.mediaOnly              | tools.distill.mediaOnly                                                                        |
| compress.blockOps.enabled              | 与 blockOps 一起暂不开放；上游默认 false，导入 true 明确报告不支持，不能静默启用               |
| compress.ccr.enabled                   | tools.reference.enabled                                                                        |
| compress.ccr.minToolTokens             | tools.reference.minTokens                                                                      |
| compress.ccr.excludeTools              | tools.reference.excludeTools                                                                   |
| compress.ccr.toolName                  | 固定 context_read 接口；拒绝重命名                                                             |
| compress.ccr.maxHeadChars              | tools.reference.headChars                                                                      |
| compress.prompts.compressPhilosophy    | prompts.compressPhilosophy                                                                     |
| compress.prompts.howToCompressRules    | prompts.howToCompressRules                                                                     |
| compress.prompts.tier2DistillRules     | prompts.tier2DistillRules                                                                      |
| compress.prompts.tier3CondenseRules    | prompts.tier3CondenseRules                                                                     |
| compress.reasoningGuard.enabled        | 与整个 reasoningGuard 一起不移植                                                               |
| compress.reasoningGuard.maxContinue    | 同上                                                                                           |
| compress.reasoningGuard.maxTierN       | 同上                                                                                           |
| compress.reasoningGuard.markerText     | 同上                                                                                           |
| compress.reasoningGuard.base           | 同上                                                                                           |
| compress.reasoningGuard.offset         | 同上                                                                                           |
| compress.reasoningGuard.debugLog       | 同上；不能通过配置打开原文日志                                                                 |
| compress.outputSteering.enabled        | 与整个 outputSteering 一起保持独立 owner，不移植覆盖                                           |
| compress.outputSteering.verbosityLevel | 同上                                                                                           |
| compress.outputSteering.effortRouting  | 同上                                                                                           |
| compress.priceProfile.w                | 与整个 priceProfile 一起不移植                                                                 |
| compress.priceProfile.r                | 同上                                                                                           |
| compress.priceProfile.q                | 同上                                                                                           |
| compress.reasoning.drop                | reasoning.completedMode；true 只有 Provider 安全省略能力成立时可转换                           |
| compress.reasoning.threshold           | reasoning.thresholdChars                                                                       |
| compress.minCompressRange              | 已弃用 alias；仅在新字段缺席时显式转换，二者冲突报错                                           |

另有适用的 kernel 公开项（不在上述 75 条中）：tiers 的两个 block count、promotionThreshold、nudge frequency/iterationThreshold/adaptive 参数、crush 注册策略、ccr.retrieveInlineTokens，已进入各原生分组。函数型分类器、isMessageProtected/isCompressTool、pipeline 注册和 truncate.terminalEscapeAfter 保持固定实现，不接受 JSON/函数透传。

图片 imageRescale 是上游顶层开关，最长边位于宿主 env knob，质量/收益/缓存是源码常量；原生将它们统一纳入 images 分组。移除的 compress.imageCompression、compress.stripImages、compress.stripImagesKeepRecent、compress.compressAtFoldPoint、compress.compressAtFoldPointClearThinking 均报告已移除；没有可执行映射。

### 7.1 补丁 0.6.4 的图片与增长参数

No-ni/billion-context-patched 核对至 [6dbd99d / 0.6.4](https://github.com/No-ni/billion-context-patched/blob/6dbd99dc0affe9b365191ee66d53965a9ef1891c/MAINTENANCE.md)，vendor 仍锁定上游 406193b。以下属于补丁自己的 B12–B18，不能误归为刚升级的 acp-kernel 图片功能。

| 补丁 / 宿主字段            | 原生处置                                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| imageRetention             | 拆为 images.omitSeen 与 images.rescale；导入 true 可加载两者开启的草稿，false 关闭这两项；既有历史摘要规则独立               |
| imageRetentionKeepLastUser | 对应 images.keepRecentUserTurns；原生始终保护最新真实用户上传，false 没有完全等价映射，导入必须报告差异                      |
| imageRetentionMaxDim       | images.maxEdge；补丁默认 1200，原生建议 1600，均可调整；不静默替换用户显式值                                                 |
| imagePrompt                | images.convention.enabled；内置指导可由 images.convention.text 编辑，实际校验固定                                            |
| imageRescale               | images.rescale；不另起第二个编码管线                                                                                         |
| imageRescaleMaxDim         | 旧上游 Jimp 链的边长；补丁维护文档说明该依赖未安装。若与 imageRetentionMaxDim 同时出现且不同，报告冲突，不宣称两个值同时生效 |
| compress.nudgeGrowthTokens | trigger.growthTokens；补丁缺省已改 80000，原生暂建议 50000；表单可设 80000，压力触发仍由输入预算裁决                         |

图片设置卡片「编辑同一草稿、统一保存、恢复只改草稿」已吸收到本方案的参数页。宿主 sips/PowerShell/ImageMagick 编码器、原图读取后仍参与折叠、仅按 hash+MIME 缓存、按末条 wire 消息识别上传等实现不照搬；原生复用唯一 ImageProcessorPort，并补来源、发送证明、豁免与策略缓存维度。

## 8. 完整编辑与导入报告

原生 JSON 导出仅包含 schemaVersion、mode 与全部参数；policyVersion、会话/路径身份、原文/图片、Key、原始 endpoint、内部引用与运行中候选不导出。完整编辑只接受这套 schema，不把任意 kernel/宿主对象灌进 Runtime。

第三方配置导入为可选的辅助入口，仅读取 compress 与明确支持的图片字段；不能读取凭据、安装目录、代理地址或修改外部配置。先产生「可转换」「固定规则」「归其他设置」「不支持/已移除」「冲突」的逐字段报告。单位与模型引用不明确时要求在表单中补齐；不得把 token 数猜成百分比。只有经过表单校验的候选才能保存；不支持字段不能混在导出中冒充已生效。

完整编辑的成功校验不提交，导入加载草稿也不调用模型。普通表单、高级编辑和恢复推荐值使用同一版本快照；任何入口的改动都可在其他入口立即看到。关闭与取消行为沿用主方案，无隐式提交。存在尚未加载到表单的 JSON 草稿时禁用「导出配置文本」，提示先校验并加载，或明确「恢复为表单配置」；导出不能覆盖正在编辑的文本。

## 9. 准入验收

- 用 schema 字段清单核对分组表单、高级编辑、序列化与实际适配；可调字段不得只存在于 parser，移除/未知字段不得静默保存。
- 验证 start/target/容量关系、字符与 token 区分、数组空值/通配/冲突、crush 依赖、模型模态/输出上限、alpha/PNG 组合和实际图片预算。
- 保存中/并发冲突/取消/重连/重启/fork 均只使用一份正确版本。估算等待有界，原图缓存改参数后不复用旧副本。
- 图片缩放、原图回取、同尺寸重编码、未知格式、Provider 硬限制各取代表实例；字节减少不能被标成 vision token 减少。
- 已提供图片的失败/取消/重试、工具消息追加后的最新用户图、跨消息同图、原图读取一次豁免、模型/编码策略变化与关闭省略后的预算各取代表实例；不得用 HTTP 成功状态替代模型请求完成事实。
- 共享 schema、正式表单、只读查询和原生维护已实现；90 字段消费者见实现映射。Windows 产品回放已验证表单/JSON、两作用域保存、默认捕获、摘要、图片与桌面趋势的代表场景，实际轮次及未验规则见[验收覆盖](../testing/native-context-compression-e2e-coverage.md)。真实模型摘要质量、所有字段取值及条件组合仍未完整验证，静态检查不代表行为验收通过。

2026-11-12 共享产品回归补充：

- 320/390px 的侧栏底部允许「偏好」触发器收缩并截断长文案，保留其图标与完整可访问名称；设置和远控按钮保持实际鼠标、键盘入口，不通过修改通用 Button 或隐藏入口绕过裁切。
- 参数多宽度验收可能触发既有 Shell 自动收起侧栏。新任务默认捕获验收先关闭弹窗，通过真实侧栏开关恢复项目行，再从项目行创建并发送唯一一次受控主请求；不注入 DOM 事件或改写 store 来建立创建前提。
- Windows 与 macOS 的实际侧栏开关提供相同 `desktop-top-logo-sidebar-toggle` 测试标识，复用同一恢复入口；标识不改变按钮行为，Windows 运行不登记为 macOS 真机验收。
- 设置验收失败后先关闭弹窗、恢复 1024px 安全视口，再沿当前控制端的真实设置界面还原原语言、主题和任务；外层最后恢复调用者的原视口。恢复失败与首次断言分别保留，不能把遗留偏好当作后续场景的产品事实。

2026-11-12 第八轮恢复时序补充：手动维护在途切换 mode 的主断言已走完，恢复参数时却遇到已卸载的 `open-parameters` 元素，整场仍登记失败。测试的共享关闭入口必须在发送 Escape 后观察详情弹窗和 popover 均已关闭，才能允许下一次打开入口；键盘操作完成不等于 React portal 已卸载。复测不得通过延长等待、重复点击、直接写 store 或忽略 teardown 来隐藏该失败。用实际 helper 的受控关闭/重开回归先证明旧实现过早继续，再执行共享产品套件验证真实交互。

回归依据是 [32 场运行日志](../../.run-logs/project-only-validation/native-context-desktop-e2e-X6iFbn/logs/e2e.log)：项目节点存在但不可见，390px 设置按钮实际中心命中失败，随后语言/主题清理在同入口失败；修复后的产品复测由共享套件统一执行。
