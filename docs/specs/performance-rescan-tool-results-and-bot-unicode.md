# 工具结果单次解析与 Bot 长文本代理对分片

## 范围与现有契约

继续 `packages/services` 的性能/正确性重扫；只触及四个已确认的生产文件与其新增回归，不改动任何接口、状态所有者、事件顺序与持久化：

- `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts`：`mapToolUpdated` 的 `result` 分支是 ZCode Protocol `tool.updated`（kind=result）事件到 `ZCodeStreamEvent`（`tool_call_update`）的唯一投影路径。`normalizeToolResultContent` 与 `toolResultStatus` 均为模块私有函数，各自只被该分支调用一次（4583-4584 行）；两者对 `result.content` 的解析只服务于本事件内的分类判定，不跨调用、不落库。
- `packages/services/src/bots/providers/telegramProvider.ts`、`packages/services/src/bots/providers/feishuProvider.ts` 与 `packages/services/src/bots/replyFormatter.ts`：`splitTelegramText`（limit 3900，调用点 send:394）、`splitFeishuText`（limit 1900，调用点 send:1694）与 `splitLongReplyText`（MAX_REPLY_MESSAGE_LENGTH 3500，经导出的 `extractBotAssistantResponseMessages` 由 botsService:3893 调用）是三处出站长文本分片，模块私有。已核查全仓不存在现成的公共文本 split / 代理对 helper（`packages/shared/src` 无 surrogate 相关工具），按“独立平台常量保留小局部循环、不新增公开接口”处理，三个文件各保留本地小函数与本地代理对判定。
- 不新增缓存、队列、后台任务或第二条事实来源；不改变任何 RPC 契约、Bot 协议载荷结构、desktop-continuous 与 web-remote-replayable 语义。

## 确认问题与决策

### 1. 同一工具结果 content 在每个投影事件里被全量 JSON.parse 两次（TodoWrite 为三次）

`mapToolUpdated` 的 result 分支顺序调用 `normalizeToolResultContent`（经 `parseAgentActivityResultContent` → `parseJsonRecord`）与 `toolResultStatus`（经 `isBackgroundAgentLaunchResult` → `parseJsonRecord`）。在普通非空字符串结果的默认路径上，两个解析互不复用：JSON 文本 content（Read 到 .json、MCP JSON 输出、Agent/Task 结果）被完整解析两次，普通非 JSON 文本则两次快速失败。`success: false` 或后台 ACK 文本的状态分支会提前返回，原先就只解析一次，不把这些分支计为减半收益。纯空白字符串原状态分支尝试解析一次后失败，现在不再尝试，仍保留原文与 completed 状态。两个消费方都只读取对象字段，解析值本身不进入投影结果。

第三次 parse 位于 `packages/shared/src/tool-plan-adapter.ts` 的 `extractPlanStepsFromToolOutput`（`collectOutputCandidates` → `parseJsonValue`），仅对 TodoWrite 类工具名（`isTodoPlanToolName`）触发；该文件属 shared 且不在本轮范围，**不改**。因此收益口径精确为：普通工具 2 → 1，TodoWrite 3 → 2。

决策：在 result 分支内解析一次并复用原 `parseJsonRecord`（它对有效非对象 JSON 返回 `{}` 而非 null；空串/非字符串 content 不触发解析，负结果同样复用、不重新 parse）。以可选参数传入两个消费方；判定条件（`toolName === "Agent" || "Task"` 或 `agentId`/`agentType` 归一）与判定顺序不变，投影输出逐位一致。不加入首字符预筛等额外改动。

### 2. Telegram/Feishu 长文本分片切断 UTF-16 代理对

两个 splitter 都是裸定长切片（`text.slice(index, index + limit)`）。边界落在高低代理对中间时，前一块以孤立高位代理结尾、后一块以孤立低位代理开头，产出 ill-formed UTF-16 字符串。`JSON.stringify` 只是把孤立代理项转义为 `\udXXX`（转义而非替换，请求体里携带的仍是 ill-formed 文本）；接收端解码或显示时可能拒绝、替换或呈现乱码（U+FFFD 只是其中一种表现，不承诺必然发生），用户侧表现为两条各坏一个字符的消息（emoji 等非 BMP 字符）。Telegram 既有的“markdown 未闭合回退纯文本”不修复此项。

### 3. Bot 回复长文本分片（splitLongReplyText）硬切同样切断代理对

`splitLongReplyText` 优先在 `MAX_REPLY_MESSAGE_LENGTH` 前找最后一个换行或空格作断点；找不到时硬切 `remaining.slice(0, MAX_REPLY_MESSAGE_LENGTH)`，边界同样可能落在代理对中间。换行/空格断点不可能落在代理对中间（代理对码元不是空白），只需修硬切分支。

决策：三处 splitter 均在硬切边界需要时回退一格，并按实际边界推进，让代理对整体进入下一块/下一片；两个 provider 使用游标循环，回复格式器保留原有 remaining 循环。只承诺分片顺序、单片上限、内容保真与既有空文本行为不变——边界退让可能使总片数增加，因此不断言总片数等于旧算法；`splitLongReplyText` 保留既有 trim 语义（因此不能断言拼接回原文），纯 BMP 输入输出与旧实现逐字节一致（用旧算法参考实现做差分）；空文本行为不变（两个 provider splitter 返回 `[""]`，`splitLongReplyText` 返回 `[]`）。limit 为 ≥2 的模块常量且回退只在 `end < text.length`（即 `end - cursor === limit`）时发生，游标严格前进，无空块/死循环。代理对判定为三个文件各自的本地小函数，不新增共享模块或公开接口。

## 验收

1. `toolResultProjectionParseBudget`（node:test，真实 `createZCodeTaskServiceAdapter` + `onDynamicTaskEvent` 入口 + 全 stub 依赖，全局计数 `JSON.parse`，恰好 13 项）：
   - Read + 大 JSON content：对 content 的解析恰好 1 次；投影为 string content、status completed。
   - 纯文本 content：解析恰好 1 次（快速失败）；投影不变。
   - 空串 content：解析 0 次；content 投影为 undefined、status completed。
   - 非字符串 content（number/object/undefined）：解析 0 次；content 投影为 undefined、status completed。
   - Agent + JSON agent 结果（agentId/agentType/content 数组/thought）：解析恰好 1 次；投影仍为 `agent_activity`（含 thought）。
   - Read + 含 agentId 且含 content 字段的 JSON：解析恰好 1 次；**保持现有 agent_activity 投影**（agentId 归一本轮不收窄）。
   - Read + 含 agentId 但不含 content 字段的 JSON：解析恰好 1 次；投影为原始 JSON 字符串（无 content 可提取时回落原文）。
   - Agent + 后台启动 ACK 文本：解析恰好 1 次；status 仍为 `in_progress`。
   - Agent + backgrounded JSON（status + backgroundTaskId）：解析恰好 1 次；status 仍为 `in_progress`（锁住经解析分支的后台判定）。
   - `success: false`：status 仍为 failed；解析恰好 1 次。
   - legacy/previous 两种 ACK 文本：保留一次解析与 in_progress 状态。
   - async_launched JSON：解析一次，后台状态不变。
   - 前置 scheduled 事件播种 toolName，result 不带名称：继续使用记忆路径，解析一次。
   - 修复前计数断言失败（红），投影断言通过（证明行为不变）。
2. `botLongTextSplitUnicode`（node:test，真实 `createTelegramBotProvider`/`createFeishuBotProvider` 的 `send` 入口 + stub `globalThis.fetch`，以及真实 `extractBotAssistantResponseMessages` 入口，恰好 16 项）：
   - Telegram：代理对落在第一处/第二处分片边界时整体进入下一块（块长 [3899,12] / [3900,3899,12] 等），无新孤立代理项，拼接回原文本。
   - Telegram：非边界场景（emoji 居中、长度恰为 limit、全 emoji）分片与旧行为一致。
   - Telegram：空文本仍返回单块 `[""]`。
   - Telegram：输入原本含孤立代理项时原样保留。
   - Telegram：长文本 + selection 时按钮只挂在最后一片（锁住在位行为）。
   - Feishu：代理对落在第一处/第二处边界时整体进入下一块；纯 BMP 长文本分片与旧行为一致（[1900,1900,200]）；空文本单块；既有孤立代理项原样保留（经卡片 markdown 提取验证）。
   - `splitLongReplyText`（经 `extractBotAssistantResponseMessages`）：硬切边界代理对整体进入下一片；纯 BMP 多场景（含换行断点、空格断点、无断点硬切、长度恰限）与旧算法参考实现逐字节一致；既有孤立代理项原样保留；空串返回 `[]`。
   - 修复前边界用例失败（红）。
3. 精确测试数由 `scripts/ci` 入口断言，缺一即失败；既有受影响回归（任务适配器既有测试、bot 既有测试）不回归。

## 验证边界

- 全部测试经 `scripts/ci/source-test-runner.mjs`（`runSourceTests` + `createProjectTestSandbox`）在项目内 Node 24.14.0 下执行；HOME/TEMP/APPDATA/数据目录全部重定向到 `.run-logs/project-only-validation/`，不写真实用户数据、不启动真实 git/模型/Agent；Bot 出站经 stub fetch，不发出真实网络请求。
- 记录红/绿确切计数与解析次数定量；解析次数与耗时是指定合成输入的工作量指标，不换算成真机提速比例。
- 未执行浏览器/真机验收；未改变 UI 交互与协议。全量 typecheck 与 architecture 检查通过（架构违反 0）；lint 为 0 错误、2 条既有警告。

## 实际验证记录

- 初始 26 项回归在未修复实现上：14 通过、12 失败（6 个重复解析计数、6 个代理对边界），日志：[初始红态](../../.run-logs/project-only-validation/rescan-red3-fxTGwU/logs/output.log)。
- 最终 29 项中的适配器对照：保留 splitter 修复、使用原适配器，21 通过、8 个解析计数失败，日志：[适配器红态](../../.run-logs/project-only-validation/rescan-red-final-3JGgFG/logs/output.log)。
- 修复后服务回归 29/29；主代理统一入口再次通过本轮全部 46 项源测试，其中解析预算 13 项、代理对 16 项、RPC 10 项、插件名称 7 项，入口计数不重复算作源测试，日志：[集成回归](../../.run-logs/project-only-validation/round2-integrated-regressions-U9nqmT/logs/output.log)。
- 相关 bot 既有回归 67/67 通过。另三个适配器旧测试文件共 17 项：13 通过、4 失败；原适配器对照相同，不记为通过。失败位于 importedClaudeRecovery 与 nonCliAcpRetirement 的旧 fixture：裸建 Repo 后直接使用，未先调用 prepareTasksIndexStorage，触发异步启动 owner 守卫；不是临时目录或权限问题。本轮不放松生产迁移守卫，也不改这两个范围外的旧测试。日志：[修复版](../../.run-logs/project-only-validation/rescan-existing-node-2ov1wv/logs/output.log)、[原适配器对照](../../.run-logs/project-only-validation/rescan-existing-node-orig-LUWFmY/logs/output.log)。
