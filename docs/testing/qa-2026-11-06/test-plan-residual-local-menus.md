# 剩余本地菜单专项测试计划

2026-11-06 19:38 UTC 补测修订：RLM05 在新draft workspace中期待原workspace最近任务，未到查询动作。改为另一个本例独占公开导入 anchor（不提前创建09的beta），保持同workspace且alpha非active，再执行原任务查询/选择/history断言。RLM06 已实际打开文件预览、截图正文可见，但 body.innerText不读取当前 @pierre/diffs open shadowRoot，未到精确正文验证。仅改QA为preview容器内递归open shadowRoot的[data-code]行，完整marker精确验证并保存shape摘要；不改内容/超时。RLM04/07同一个可见dialog两Settings同时selected候选不修改断言。修前后SHA与旧证据停点见 [独立归因](logs/qa-local-supplement-attribution.md)。

当前 source SHA256 `eaebe0c7aaf09d13946e99827db1960a1808ac1dacfbca496dcf71c75100c152`。[最终静态](logs/e2e-preflight-final-local-gaps-static.json)全外置noEmit0/相关六文件lint0，真实fullTitle精确选RLM05/06；新版本UI未执行。补测仅这两项，不重跑已确认RLM08–13，也不隐藏04/07双selected现场。

2026-11-06 menu-final 实际 worker 0-1 在 beforeAll 执行了真实 picker/Host 导入、busy/input释放，随后我方裸标题断言超时，13项均未执行。当前 importer 的会话标题有 `Imported: ` / `导入：` 前缀，归档原题只用于公开副本和toast；QA将精确匹配当前locale前缀且独立验证sessionId，不放宽为任意标题。导入rows由 `ConversationShareImportNotice` 的只读header渲染，不是CLI运行历史。补测使用 renderer同步可见DOM快照定位菜单，失败beforeAll也保存独立PNG/只读index/toast；仍须root串行实际重跑。

本计划补充 [87 组覆盖矩阵](coverage-matrix.md) 中 TSK-02、TSK-01、CMD-01/02、NAV-01、CHAT-09 和 SET-12/20/21 的未执行动作。状态为 **READY / UI 尚未执行**，不是功能通过证据。13 项用例放本轮 `manual-review/pending` 外置目录；不改变产品、不转正。task-groups 已规划的视图、置顶、分组与归档不在这里重复。

## 既有契约和隔离前置

- 所有 HOME、业务数据根、临时目录、下载、截图、合成文件和子进程 cwd 均限定当前工作树，启动前检查绝对路径及重解析点。使用现有 `getE2EAppDataPaths()` / `resolveE2ERuntimePath()`；当前业务数据根是隔离 HOME 的 `.zcodium`，不直接拼旧 `.zcode`。
- 本套无模型请求的真实任务最小前置：`prepareV4ConversationE2E({skipProvider:true})`后，生成canonical公开一轮归档，经真实新任务下拉菜单、file picker adapter和Host导入事务创建有正文的session；等待正式sessionId、标题和只读历史加载完成。后续菜单测试使用这一导入任务，保留sessionId、执行目录、workspace identity、NDJSON和步骤截图。不得直接向store注入任务或把仅有列表行的DB seed当完整可复制会话。
- 模型首发 / 完成任务行为由独立canonical批次覆盖，不是本套无模型前置。若后续需验证真实运行中任务的Markdown / 复制，则另登记synthetic main/title fixture或复用审查通过的完整fixture，限制Provider请求为本树loopback；不能把本套只读导入任务的通过推广到running / completed runtime全部状态。
- 文件范围准备一个本树 `RLM_中文 空格.txt`，内容为合成 marker；只在当前任务的真实执行 root 中创建。目录和结果经现有 Host 文件索引进入 UI，不注入菜单候选。
- 复制路径 / ID 走 `navigator.clipboard.writeText`；Markdown 走 `IPlatformService.writeClipboardText(Promise<string>)`。允许捕获本轮合成文本或受控拒绝，不覆盖真实用户剪贴板内容。文件管理器动作拦截 platform/native 出口并断言参数，不启动外部应用；这只验路由，不宣称 OS 打开成功。
- 各 case 首尾截图与状态 JSON；失败时保存错误、当前菜单、active task、作用域、请求次数和本树配置 / DB 检查结果。不得采真实凭据、用户正文或全目录。独立测试恢复 mocks，不通过任意超时或 direct store mutation 伪造成功。

## 当前入口和 locator

| 入口           | 当前 locator / 语义                                                                                                      | 注意事项                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| 真实任务行右键 | `testId(TID_TASK_ITEM, sessionId)`，即 `task-item-<sessionId>`；实际 DOM 以 shared `testId()`为准                        | 菜单用 `role=menuitem` + 精确中英文可见名称定位，不按全页模糊前缀                                               |
| 路径 / ID      | `复制路径 / Copy path`、`复制任务路径 / Copy task path`、`复制日志路径 / Copy log path`、`复制会话 ID / Copy session ID` | 复制执行目录要查真实任务，不能假定等于 backing workspace；任务 / 日志复制只要求 path 字符串，不能要求文件已存在 |
| Markdown       | workspace header `TID_WORKSPACE_MORE_BUTTON=workspace-more-button` → `task-copy-markdown`                                | 当前 grouped sidebar 右键菜单没有装配 Markdown；未找到行菜单该项不能作为 bug。草稿没有正式 header more 菜单     |
| 未读           | 行右键 `标记为未读 / Mark as unread`，然后点同一 `task-item` 行                                                          | 应真实出现并清除 unread indicator，DB 只读检查当前 `.zcodium/v2/tasks-index.sqlite` 的 `unread_at`              |
| 命令中心       | `sidebar-search-open`，`[role=dialog] [cmdk-input]`，`[role=tablist] [role=tab]`                                         | 四 tab 中文 `全部 / 操作 / 任务 / 文件`，英文 `All / Actions / Tasks / Files`；唯一 `aria-selected=true`        |
| 命令中心结果   | `[cmdk-item]`，最近任务 `data-value^="recent-task:"`；搜索任务 `data-value^="task-result:"`                              | identity 和 taskId 决定选中，标题仅展示；具体 row 值以当前 DOM 为准                                             |
| 本地导入       | `task-new-button` 内 `aria-label="对话选项 / Conversation options"` → `从文件导入… / Import from file…`                  | Desktop 也复用 browser file picker；创建隐藏 `input[type=file][accept=".zcodium"]`，不是 Electron native picker |

Locator 和动作来源：`packages/ui/src/TaskActionMenuContent.tsx`、`project-sidebar/grouped/task-context-menu-content.tsx`、`WorkspaceHeaderSections.tsx`、`command-center/CommandCenterDialog.tsx`、`NewTaskButtonGroup.tsx`。当前 `useTaskListItemContextActions.ts` 对路径解析失败停止操作；不要用工作区路径兜底使测试通过。

## Accepted 场景（13 项）

| ID     | 对应组         | 前置和真实动作                                                                       | 验收断言与证据                                                                                                                                                                                                                                                                   |
| ------ | -------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RLM-01 | TSK-02         | 正式导入任务；逐次右键选择四个复制项，最后选择文件管理器                             | 每次捕获唯一写入；执行路径 / session路径 / 日志路径 / ID 分别对应真实查询，全部路径留在本树；日志尚未落盘但有字符串时仍可复制。文件管理器出口收到本树执行目录，不启动 Explorer                                                                                                   |
| RLM-02 | TSK-02         | header more → `task-copy-markdown`；复制后再次执行。再受控拒绝 clipboard，恢复后重试 | 合成标题、用户和 assistant marker 出现在完整 Markdown；无其他任务 marker。错误反馈可见、pending释放、重试成功。若测并发，需要持有真实出口 Promise 验单飞，不能双击后仅看一次 UI toast                                                                                            |
| RLM-03 | TSK-01         | 当前已打开任务右键标记未读，再点同一任务，切到新草稿并返回                           | marker真实显示后消失；DB `unread_at` 数字→null，返回不反弹；不重复 task-groups 的置顶 / 分组动作                                                                                                                                                                                 |
| RLM-04 | CMD-01/02      | 打开命令中心点 Actions；空查询后输入精确 Settings 名称，用键盘选中并 Enter           | 仅操作范围选中，不混入任务 / 文件结果；真正进入 settings-page，dialog关闭。Escape关闭时回焦可独立保存证据；不执行外部帮助或发布动作                                                                                                                                              |
| RLM-05 | CMD-01         | 同工作区真实导入另一个独占anchor后点 Tasks；空查询看到alpha，再输入唯一中文标题，用上下键 / Enter 打开 | 当前 recent 合同排除 active task，因此验证anchor与alpha同workspace且不同ID后验最近；只任务范围、精确 taskId 被激活，其他结果不同时选中；重开搜索仍可命中，清除关键词恢复最近任务 |
| RLM-06 | CMD-01         | 点 Files；空查询没有当前任务变更时按契约为空，再输入 `RLM_中文 空格`，选择实际文件   | 只文件范围；Host索引找到本树文件，真正打开文件预览且内容 marker正确。不能把全repo Git变化当当前任务空查询 Recent changes                                                                                                                                                         |
| RLM-07 | CMD-01         | 点 All；分别真实输入 `>`、`#`、`@` 前缀完成一次选择，再重开并清除搜索历史            | 前缀分别切 Actions / Tasks / Files，选中唯一；完成选择后真实历史chip带正确scope，点击可恢复关键词 / scope；Clear后关闭重开仍为空。只读当前本树local storage，不直接写历史                                                                                                        |
| RLM-08 | NAV-01/CHAT-09 | 打开导入菜单，捕获实际新建 file input；先取消，再持有一次选择并重复尝试入口          | accept为`.zcodium`、max72MiB合同；cancel清理input / busy且没有新session。待选择时按钮busy / disabled，无第二事务。仅拦截input.click抑制OS对话框，用本树文件的DataTransfer/File触发真实onchange / File.arrayBuffer，后续Host事务不mock；取消adapter事件不宣称真实OS对话框按键已验 |
| RLM-09 | NAV-01/CHAT-09 | 从真实DOM file input选本树有效v1 `.zcodium`，等待Host提交；同一文件再次导入          | 导航到导入session，公开合成正文可读；源配置 / 源路径 / 运行时凭据未带入；重复导入复用相同session并提示reopened，不重复task、不覆盖已有草稿。只验离线本地Host，不验remote fallback                                                                                                |
| RLM-10 | NAV-01/CHAT-09 | 独立选择空文件、非ZIP、未知version v2、篡改hash的合成归档；各次错误后选择有效文件    | 错误映射符合当前UI，非retryable合同错误不显示Retry，busy和临时import句柄释放，无半成品任务；恢复有效文件可导入。四子场景各保存截图 / JSON，不能只按“出现任意错误”验收                                                                                                            |
| RLM-11 | SET-12 | MCP 新建入口，填写名称与 command 后取消 | 精确 `settings.mcp.create.open`；不 Save、不启动 server；配置文件指纹无变化 |
| RLM-12 | SET-20 | Commands 新建入口，填写名称与 prompt 后取消 | 当前页 New 按钮/真实 form；不 Submit；commands 文件目录指纹无新增 |
| RLM-13 | SET-21 | Skills 新建入口，进入含 skill-creator mention/提示的草稿后返回 | 当前合同没有新建 form；精确 `settings.skills.create.open`；不发送 Provider，真实草稿可读且可返回 |

中文 / 英文和深浅主题至少各选择一组真实菜单执行与截图；不要用切换主题状态作为所有业务case重复通过。布局像素上限与DPI应独立记录，不预设旧1px / 64px精确值。

## 当前 `.zcodium` 归档格式

剪贴板 adapter 同时拦截 `navigator.clipboard.writeText` 与 `write`，后者用 ClipboardItem.getType("text/plain") 读取合成 Blob；全部写入只记录到测试数组，不调用真实 API。文件 adapter 仅拦 input[type=file][accept=.zcodium] 的 HTMLInputElement.click，其它 click 原样；DataTransfer/File/真实 onchange 继续驱动 Host begin/append/import/release。动态 reparse 审查使用本轮共享 `qa-reparse-children.ps1`，仅树内当前 queue 的原生 PathNotFound / DirectoryNotFoundException+DirIOError 且二次确认不存在时跳过，权限、仍存在路径、link/redirect继续拒绝。该共享守卫由 root 维护，本 suite不放宽错误族。

导入文件是 ZIP，不是原始 JSON：根 `manifest.json`，内容引用附件时另有 `blobs/<sha256>`；拒绝额外ZIP条目、重复 / 不安全路径和不可信结构。manifest严格为 `{content, sha256}`；content严格为 `format: "zcodium-conversation"`、`version: 1`、非空title、非空`selectedProductTurnIds`、非空v4 `rows`、`artifacts`数组。hash使用项目canonical JSON，不是原始文件文本hash。

正向fixture通过公共 `@zcode/services/node` 的 `encodeConversationArchive()`生成，并以 `decodeConversationArchive()`预检，不能绕过Host import或伪造其成功结果。最小fixture无附件，只用canonical公开一轮终态 `turnHeader / userInput`，或增加公开 `assistantText` 以验证回答Markdown；public IDs用 `share-product-turn-1 / share-turn-1 / share-entity-N`，去掉私有action / 模型配置 / Source字段。所有row按shared schema填写，选择同一product turn。`buildConversationSharePublicProjection()`目前未从services/node公共入口导出，本轮外置fixture可按`ConversationArchiveInput["rows"]`直接构造canonical公开行，不跨包导入该实现；若从真实导出流程取fixture，应优先复用其公开投影，不能直接把raw session rows塞进ZIP。

上限：ZIP 72MiB、manifest 4MiB、单artifact 16MiB、总artifact64MiB、最多128 artifacts / 5000 rows、JSON depth64 / nodes250000；首批RLM不造大型文件压力。正向只测无附件，下批仍需附件内容 / ZIP traversal / limits / 导出取消与敏感披露的专项测试。

当前错误presentation：零长度 / 超限 → `limit_exceeded`；未知v1版本 → service `unsupported_schema_version`；结构 / 完整性 → `invalid_contract`；一般Host失败可提供Retry。UI先分块512KiB begin/append/import，finally release；导入是Host事务，不经已删除官方publish / 分享链接API。

依据：`packages/shared/src/conversation-archive.ts`、`packages/services/src/conversation-share/conversationArchive.ts` / `conversationArchiveValidation.ts`、`packages/ui/src/root/useConversationArchiveImport.ts`、`lib/importConversationArchive.ts` / `browserFilePicker.ts`。以上为源码合同和计划，尚无本轮这些动作的执行证据。

## 附加候选与仍未覆盖

- AskUserQuestion 单题Enter、三题键盘导航，以及 Tool Action Guard / Explore 连续折叠四个formal specs，由主批与已安排17it合并执行，结果只按实际NDJSON写回矩阵。
- MCP `settings/mcp-dual-era-version-negotiation.test.ts`可审查本地stdio子进程后候选；config用当前storageRoot，日志必须显式本树`ZCODE_LOG_DIR`，fallback仍提旧`.zcode`。它验证协议连接，不替代MCP新增 / 编辑 / 删除表单。
- Skills plugin creator helper有多个旧`home/.zcode/cli`写点，不直接执行。当前Skills的“新建”会创建带skill-creator mention的任务草稿，没有SkillForm或取消按钮；草稿可验证但不发送。Commands和MCP有真实本地表单，应按当前合同另写外置case，先验取消 / 必填，再验保存回显 / 错误恢复；不得自动安装外部包。
- `command-center-selection`、旧history pending和`sidebar-unread-clear`直接拼旧`.zcode`，不列本批安全可执行；旧share-publish-import不是当前本地文件格式。真实macOS、设备、SSH / relay、外部账号均不在此计划。

## MCP、Commands、Skills取消路径的只读审查

以下是 RLM-11/12/13 当前实现采用的入口和取消边界，不是本轮通过证据。

| 功能         | 当前真实入口 / locator                                                                                                | 取消与写入语义                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| MCP新建      | `[data-settings-create-action="settings.mcp.create.open"]` → 标题“新建 MCP 服务器”，input placeholder `my-mcp-server` | footer精确`取消 / Cancel`（无testid）调用onCancel返回列表；取消不保存、不启动server。保存/stdio连接另需本树fixture                |
| MCP导入      | 更多操作菜单 → `[data-settings-import-action="settings.mcp.import.open"]`                                             | 外部Agent导入dialog先验关闭/Escape；打开只扫描隔离HOME，不导入真实源                                                              |
| Commands新建 | installed section中唯一可见`aria-label="新建 / New"`按钮 → 唯一form，input placeholder `my-command`                   | form内`button[type=button]`精确`取消 / Cancel`；保存是`type=submit`并实际写入。取消前后只读隔离config比对，不能点submit后声称取消 |
| Skills新建   | `[data-settings-create-action="settings.skills.create.open"]`                                                         | `SkillsSection.tsx`调用onCreateTask创建skill-creator草稿；没有新建表单。只检查真实mention / 草稿，不发送，不安装                  |
| Skills导入   | 更多操作菜单 → `[data-settings-import-action="settings.skills.import.open"]`                                          | `ExternalAgentImportDialog`可关闭/Escape；导入动作不在本批，不访问真实用户HOME                                                    |

入口使用`SettingsResourceHeaderActions.tsx`的`data-settings-create-action` / `data-settings-import-action`，并非`data-testid`。表单来源为`McpSettingsSection.tsx` / `McpServerForm.tsx`、`CommandsSection.tsx` / `CommandForm.tsx`；Skills来自`SkillsSection.tsx`。每次进入需等待当前section稳定、限定dialog或form并用精确名称，避免把其他页“新建”误认成目标按钮。

## 静态准备与串行运行

### menu-reviewed 后的独立补测 RLM-04–13

原 run 的 RLM-03 点击标记未读后，同一 WebDriver session 从下一次 task row 查询起持续超时，后续十项没有抵达功能动作，不能记为各自独立失败。新 run 只选择 `(?:^| )RLM-(?:0[4-9]|1[0-3]):`：Mocha匹配suite fullTitle与it标题的组合，不能用`^RLM`直接锚裸it标题。beforeAll 仍真实导入独占 alpha、编码 beta，并在 alpha 的本树执行目录创建文件；跳过 RLM-01/02/03，避免继承未读动作后的协议阻塞。

十项按原注册顺序执行。04、07 的中文“设置”查询由当前 commands 固定 keywords 同时支持，与03切换中文没有依赖。05自行切真实草稿后检查最近任务；06/07所用文件由 beforeAll 创建；08自己开启和取消真实 input；09自己导入 beta 并验证复用；10每次错误后恢复 alpha；11/12的配置基线与表单取消都在各自 case 内完成。每项结束关闭菜单/dialog/settings，下一项重新导航。13仅修正 QA 导航名 `skills` 为当前 `skill`，仍只创建 skill-creator 草稿，无 Provider发送。

该十项尚未在修正后运行；静态注册、定向 lint 与 noEmit 的新证据另行追加，不反写旧 run FAIL。正向 runtime Markdown 使用独立 RFC/RMC replay，公开归档 readonly 正文不被当作 runtime history。

2026-11-06 18:40:26 UTC 静态 READY：13项实际tsx注册的裸it标题中目标10项；该独立stub未模拟describe栈，不能据此宣称Mocha filter准入。真实fullTitle准入以[合并probe](logs/feature-inventory-local-supplement-preflight.json)为准。定向noEmit 0、lint 0；公开encode/decode为516 bytes/3 rows/0 artifacts，见[当前静态证据](logs/e2e-preflight-residual-static.json)。修后suite SHA256 `2eb73bb1cb66625d0d074c71ecfe68649c43d29b0e1c57442c12d8499fa70ab7`；menu-reviewed原loaded SHA `797b81824a904bc37d275408eb63cd18e936e098a3368a2a182110a9e63a1aac`。后续SLM统一静态审查也包含本RLM当前SHA，65callbacks无keepNames闭包finding。没有执行任何hooks/cases/UI。

[外置 suite](manual-review/pending/qa-residual-local-menus-20261106.test.ts) 的 13 项已实际通过 TypeScript noEmit（0 diagnostics）、tsx 模块导入和 Mocha registration（13 项），定向 oxlint（0 warnings / 0 errors）。公共 package export 经 desktop 的 `createRequire(...package.json).resolve("@zcode/services/node")` 解析，未跨包导入内部投影实现。编码/解码预检得到 516 bytes、3 rows、0 artifacts；详情见 [静态证据](logs/e2e-preflight-residual-static.json)。TypeScript 使用 services 自己现有的 yazl / node-forge 声明，无新增产品 shim。

suite SHA256（17:40UTC QA callback修正后）：`dc7f185b21cd74c68b348bcc0107694c8fddff5de437e1b748852b8eab988670`。该证据没有执行 hooks、UI、真实 Host 导入或功能断言，不应计入 UI PASS。后续失败保留 PNG 与帧时间序列；本环境无标准编码器，不能把未编码的 WebM 或 SVG 帧动画登记为视频通过。

17:40UTC追加QA序列化审查：archive picker/clipboard adapter用rawJS，避免tsx属性function携带__name闭包；setup使用[外置等价RPC adapter](qa-local-rpc-probe.ts)，正式remote-project-handoff-probe保持原样，调用/编解码仍复用其公开helper。QLA/RLM/SLM及adapter共61个直接execute函数callback keepNames无finding、3rawJS语法无错误，allQA noEmit与4文件lint均0，见[追加静态证据](logs/e2e-preflight-short-static.json)。只有实际运行才确认UI/事务结果。

完成当前桌面进程退出后，由 root 使用隔离 runner 串行执行；不启动并行桌面实例：

```powershell
& .\docs\testing\qa-2026-11-06\run-menu-tests.ps1 -RunId qa-menu-20261106-residual-local -Bootstrap -Specs '../../docs/testing/qa-2026-11-06/manual-review/pending/qa-residual-local-menus-20261106.test.ts'
```

runner 为 pending suite 设置 common 空 replay，所有 case 首尾检查 Provider 请求数量未增加。新文件仅在隔离 HOME 的项目根与本轮 evidence 写入；DB 只读，native文件管理器和系统剪贴板被拦截。beforeAll 要求同worker独立bootstrap-after证据确认本轮 synthetic项目/root，路径及重解析审查不通过即拒绝运行。正式级 `pnpm typecheck` / `pnpm lint` 的仓库总体结果由主报告单独记录，此处仅是新增 QA 的定向结果。
