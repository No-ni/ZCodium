# 设置菜单专项 E2E 测试计划（2026-11-06）

状态：accepted 的既有契约测试计划；新增脚本是本轮外置 `manual-review/pending` 候选，尚未运行、未转正。脚本位置为 `docs/testing/qa-2026-11-06/manual-review/pending/qa-settings-menu-20261106.test.ts`。根 agent 统一执行和记录真实结果。

## 依据与边界

- 当前菜单装配：`packages/ui/src/settings/settingsPageConfig.ts`、`packages/ui/src/lib/settingsNavigation.ts`、`packages/ui/src/SettingsPage.tsx`。
- 当前测试合同：`docs/testing/conversation-session-e2e-development-workflow.md`、`docs/testing/conversation-session-e2e-coverage-matrix.md`、`docs/conversation-session-case-catalog.md`，既有 `settings/settings-ui-polish.test.ts`、`settings/settings-personalization.test.ts`、`ui-shell/manual-review/pending/sidebar-primary-navigation.test.ts`。
- 使用 architecture-governance 与 e2e-case-lifecycle 技能，已读取 `DESIGN.md` 的菜单、主题、响应式和国际化规则。代码前架构基线为 OK/0 violations，证据 `logs/validation-architecture-check.log`。
- 不修改产品行为、Source owner、协议或持久化合同。设置 owner 仍由当前 `SettingsPage`/服务决定；本脚本仅通过真实 WebDriver click 操作可见菜单，读取 DOM 投影与保存测试证据。
- 测试文件外置是为避免向尚未纳入 managed module 的桌面 E2E 源码目录新增文件；不为测试修改架构策略。通过相对导入复用既有 V4 初始化，`prepareV4ConversationE2E({ skipProvider: true, skipShellReady: true })` 不配置模型、不发送请求。全局设置与固定项目行无依赖；启动时真实跳过引导并等待设置按钮，避免既有固定项目行播种前置失败阻断全局菜单测试。
- runner 必须把 HOME/APPDATA/TEMP/缓存/下载/产物指向本工作树内的隔离目录。脚本在写证据前核对 artifact 目录 realpath/祖先不存在符号链接或重解析点，拒绝越界。
- 只改变隔离会话里的语言/主题以验证真实可见菜单。没有插件安装、官方联网、数据迁移、清空真实配置或外部发送。语言/主题组合通过实际 Select 交互，不能调用 `__testActions` 或直接 dispatch click 代替用户交互。

## accepted cases

| Case     | 输入/动作                                                                                                                                                                                           | 必须断言                                                                                                    | 证据                                                    |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| QSM01-18 | 分别真实点击 general、appearance、modelProvider、sourceServers、personalization、memory、subagents、plugin、mcp、skill、commands、hooks、browser、computerUse、shortcuts、usage、projects、archives | 对应导航显示且 `aria-current=page`；当前内容标题与目标分区一致；该分区的关键控件/兼容空态在内容区出现       | 每个独立 it 的 PNG、JSON；失败 JSON 保存错误            |
| QSM19    | 打开设置并读取实际导航集合                                                                                                                                                                          | 18 个桌面入口存在；旧 remoteDevices/dataSync/automations/plugins/workspaceFileSearch/migration 不出现       | PNG、JSON                                               |
| QSM20-23 | 通过常规语言下拉和外观主题下拉选择 light/dark × zh-CN/en-US；分别重新进入 18 个设置，再返回主视图真实点定时任务、商店、新任务                                                                       | 语言 label 和实际主题类收敛；每个分区导航/标题/关键控件一致；主导航选中与内容真实存在，新任务回到可见主导航 | 每个组合 18 页 PNG/JSON及主导航证据，失败按实际止点保存 |

Source Server 的 ready-empty 或兼容性不可用文案是既有允许状态，不伪造远端连接。使用统计允许 loading/empty 但必须显示真实 range tab，不能用任意页面 loading 作为通过。MCP/技能/命令允许空列表，但必须在正确目标标题下出现 scope/search 控件。电脑控制允许 unsupported 文案，但不能仅以 nav 选中代替内容断言。

## pruned 与未覆盖

- Web/手机隐藏 Source Server/电脑控制、macOS 原生菜单及真实 CUA 权限不在本脚本范围，单列平台验收。
- 不覆盖各设置保存/取消/校验、实际 MCP 握手、Provider Key/API、插件安装、Source 生命周期、自动化执行或故障恢复；这些由库存清单的对应专项覆盖。
- 只验证当前已有导航合同。未知新功能语义不生成用例，历史官方云菜单不恢复。
- PASS/FAIL 必须以本轮实际 artifact 为依据。若初始化提前失败，所有未到达 cases 记 NOT-RUN/BLOCKED，不能记 covered。
