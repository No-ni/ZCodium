# 官方 3.17.1 UI 域合并契约

范围：`packages/ui/**`。上游 `zai-org/ZCode@a60ba6a7`（v3.17.1），本地基线 `4ea45367`，合并基 `872ad960`。
总规则见 [official-3.17.1-integration.md](../../docs/specs/official-3.17.1-integration.md) 与 [AGENTS.md](../../AGENTS.md)；
本文件只记 UI 域的所有者、吸收/剥离边界和逐类决议，不复制产品文案。

## 冲突规模（开工实测）

`packages/ui` 未解决路径 250，按三方来源分类：

| 类别                                | 数量 | 处置                                                                                    |
| ----------------------------------- | ---- | --------------------------------------------------------------------------------------- |
| 三方都有（`B/H/M`，UU）             | 165  | 逐块三方合并：吸收上游新增，保留本仓 delta                                              |
| 双方新增（`H/M`，AA）               | 54   | 上游版本为新主线，回灌本仓 ZCodium/性能/远控修正                                        |
| 上游删除、本地有改动（`B/H`）       | 12   | 接受删除，本仓 delta 迁到上游新落点（`project-sidebar/`、`workspace-grouped-tasks/`）   |
| 仅上游新增（`M`）                   | 9    | 直接采纳，含 `v4/diagnostics/local-ttft/` 模块与 `project-sidebar/grouped/task-row.tsx` |
| 本仓独有、上游迁移（`H/12`、`H/2`） | 7    | 迁移到上游模块目录后删除旧路径                                                          |
| 双方删除（`B/1`）                   | 3    | 保持删除（`v4/telemetry/localTtft*`）                                                   |

## 所有者与边界

- **草稿与已接受输入**：唯一所有者仍是 Renderer 的乐观 overlay + CLI `CommandInbox`。UI 不新建第二份已接受队列。上游 composer/toolbar 重构必须保住本仓的 ACK、草稿与重放语义。

- **手机 Web 远控**：`web-remote-replayable`（快照 + 缺口修复）与桌面 `desktop-continuous` 保持两条明确链路；上游 `web-remote-control/`、`WebRemoteControl*` 新文件只做展示层适配，不改投递语义。

- **侧栏任务列表**：唯一所有者为 `project-sidebar/` + `workspace-grouped-tasks/`（上游新结构）。本仓 `WorkspaceGroupedTasksSection.tsx`、`WorkspacePinnedTasksSection.tsx`、`WorkspaceSidebarItem.tsx`、`useWorkspaceTaskLists.ts`、`buildGroupedTaskViewFromSessions.ts`、`unreadTaskCount.ts`、`taskFileTreeTarget.ts` 的旧路径全部让位给新模块，本地修复按行迁过去，不保留第二份实现。

- **图片标注与文件菜单**：`image-preview-editor/`、`file-menu/` 为上游新契约所有者；`components/ai-elements/image-preview-dialog.tsx` 只做宿主接线。

- **配置同步 / 设备范围**：`data-sync/` 为唯一入口，只连用户预部署远端，不自动部署、下载、注册；凭据范围必须可见，目标离线不回落本机。

- **个性化 / 全局指令**：读写 `.zcodium/AGENTS.md`，走既有设置服务串行 + 原子锁，不新增第二份事实存储。

- **诊断**：`v4/diagnostics/local-ttft/`（上游模块化）与 `lib/diagnostics/` 属安全本地技术日志，保留；任何官方 ARMS/OTLP 自动上报、设备归因、会话能力统计一律不接。

## 持续剥离（UI 域）

上游新增但本仓不存在的下列面属于官方账号/权益/营销/云分发，整体删除，不接任何入口：
`login/`、`WelcomeScreen.tsx`、`marketing-touch/`、`marketing-touch-contract/`、`lib/marketingNavigation.ts`、
`highspeed/`、`v4/highspeed/`、`rewards/`、`components/cloud-content-dialog/`、`assets/cloud-content/`、
`assets/highspeed/`、`assets/payment-icons/`、`feedback/` 官方工单族、`CodingPlan*` 订阅/权益族、
`useOAuth`/`useStableAccountAccess`/`useUsageEntitlement`/`useStartPlanEntitlement` 等官方账号与额度 hooks、
`lib/*Telemetry.ts`、`lib/arms*`、`components/ui/floating-particles.tsx`。
保留：`hooks/useCodingPlanQuota.ts`、`settings/usage-stats/CodingPlanQuotaPanel.tsx`、
`settings/model-provider-section/ProviderDetailFeedback.tsx` —— 它们是用户自带 Key 的 Provider 额度与本地校验反馈。

本轮排除：项目永久 purge 的 `deleteData` UI、原生手机 prediction/log/push、Sites 产品入口。

## 验收

- 所有 `packages/ui` 冲突标记清零，`pnpm typecheck` 中 UI 域不再有解析错误（跨域缺接口单列，不算 UI 失败）。
- 上游吸收项以真实代码进入，不以整目录 `--theirs`/`--ours` 交差。
- 本仓保留项：手机 ACK/草稿/性能、`lib/diagnostics/*`、`test/performance*` 回归套件、ZCodium 身份与 `.zcodium` 路径、自有更新源文案、无 Linux 发行资源。

## 进度台账（2026-11-01 阶段 1）

已完成（工作树内容，索引由主代理统一处理）：

1. i18n 目录 `en-US.ts` / `zh-CN.ts` 做键级三方合并：上游 5598 键吸收、本仓改写/新增 865 键保留、
   本仓既有剥离决定的 1106 个官方键保持不引入、另有 35 个上游新官方营销/权益键剔除；无重复键、无冲突标记。
2. 上游迁移落点确认并删除旧路径 12 个（`ChatEmptyState`、`WorkspaceGroupedTasksSection`、
   `WorkspacePinnedTasksSection`、`WorkspaceSidebarItem`、`WorkspaceSidebarCollapsedRail`、`useWorkspaceTaskLists`、
   `buildGroupedTaskViewFromSessions`、`taskFileTreeTarget`、`OnboardingWelcomeView`、`RemotePluginSyncDialog`、
   `workspace-grouped-tasks/task-context-menu-content` 等）。2026-11-03 清理角标双写：旧 `lib/unreadTaskCount.ts` 与 hook 在引用核对后删除，窗口角标统一从常驻 ProjectDirectoryProvider 的共同未读集合发送。
3. 本仓先行回填的模块取上游较新版本后逐块复核：`plugin-ui/`、`gen-ui/`、`side-pane-full-view/`、
   `components/workflow-timeline/`、`components/workflow-graph/`、`app-shell/`、`v4/WorkflowNotificationHoleRow`、
   `v4/conversationRowSharing`、`lib/documentHiddenMotionPause`、`lib/zcodeTaskUsageFallback`、
   `assets/channel-icons`、`ToolCallBlocks/renderers/WorkflowRetuneRow`（共 69 个文件）。
4. local-ttft 诊断按 fork 命名落到 `v4/diagnostics/local-ttft/`（不回到 `telemetry/`），删除旧的散装副本，
   模块内引用改指新路径。
5. 审计剥离（不只冲突，含自动合入/新增文件）：删除官方营销/权益/云分发与埋点族共 168 个上游新增 UI 文件
   （`highspeed/`、`v4/highspeed/`、`rewards/`、`marketing-touch/`、`marketing-touch-contract/`、
   `cloud-content-dialog/`、`coding-plan-quota-reset/`、`manual-claim-plan/`、`global-notice/`、官方 `feedback/` 工单族、
   `CodingPlan*`/`StartPlan*`/`*Entitlement*`/`*Telemetry*`/`useOAuth`/`useTokenRefresh`/`payment-icons` 等）；
   保留用户自带 Key 的 `useCodingPlanQuota`、`CodingPlanQuotaPanel`、`ProviderDetailFeedback`。
   随后清理残留引用：解包 `runUserAction*` 官方埋点包装（`project-sidebar/ProjectComposerMenu`、
   `v4/ConversationBackgroundWorks`）、`pluginUiManagedPage` 删除官方上报及其无行为 no-op 调用链、
   `data-sync/app/marketplacePluginSync` 终态改走安全本地日志、
   `plugin-ui` 停止消费官方 client-config 推荐、`WebRemoteControlDialog` 去官方 OAuth、
   `WindowsCaptionMenuButton` 去官方工单/产品需求入口、`conversationTurnRenderUnitTypes` 去掉 highspeed 继承。
   自动合入文件的悬空官方引用从 28 个降到 7 个。

剩余（下一阶段，未解决冲突）：`packages/ui` 索引 250 条未解决路径不变（本域不动索引），其中 150 个文件仍含冲突标记、共 585 处，
大头为 `v4/SessionPane.tsx`(54)、`BotsDialog.tsx`(33)、`v4/ConversationTimeline.tsx`(21)、`SettingsPage.tsx`(19)、
`v4/ConversationComposer.tsx`(19)、`Root.tsx`(18)、`v4/composer/V4ComposerToolbar.tsx`(17)、`App.tsx`(15)、
`ModelConfigSelect.tsx`(12)、`chat-input-toolbar/ComposerModelMenu.tsx`(12)。
`packages/ui/package.json` 的依赖冲突留给主代理与根 `package.json`、`pnpm-lock.yaml` 一起对齐。

验证边界（本阶段实际做到 / 未做）：用仓库自带 TypeScript 对 `packages/ui` 全部 2063 个跟踪 TS/TSX 文件做**仅解析**检查，
1907 个非冲突文件解析通过、150 个仍带标记、6 个 `.d.ts` 为检查器对声明文件的假报（`transpileModule` 不支持 ambient 文件）；
本域改过的 17 个文件全部解析通过；i18n 合并结果无重复键、保留全部本仓键。标记检测必须同时匹配 7 连与 8 连 `<`
（重命名/新增冲突用 8 连），旧统计口径会漏。未运行根 `pnpm typecheck`、`lint`、`fmt:check`、架构检查与任何测试/E2E，
由主代理统一执行；未做真机、安装包、远端与实体手机验收。

待重定位（不静默删除、不伪装通过）：`test/browser/manual-review/pending/{yolo-confirmation,provider-settings-batch,provider-family-responsive}.fixture.tsx`
仍引用已剥离的官方 off-peak / plan 面，需按 e2e-case-lifecycle 重做用例；
`test/performanceGroupedTaskViewSortKeys.test.ts`、`test/performanceRound4WorkspaceGroups.test.ts` 依赖的
`lib/buildGroupedTaskViewFromSessions.ts` 与 `v4/buildTaskListResultFromSessions.ts` 已上游删除，本域暂按测试支撑保留，
待 `project-sidebar/grouped/model.ts` 判定等价后重定位用例并删除这两份副本。

跨域接口需求（交给主代理，UI 不自行兜底）：

- `IPlatformService`：`file-menu` 的「打开方式 / 另存为 / 原件保存」需要列可用应用、按应用打开、save-as 三个端口；
  `reportTelemetryEvent` 端口在 UI 侧已不再调用，建议 shared/platform 与 desktop main 一并收口。
- `WorkspaceSidebarFooter` 上游新增的 `onUpgradeClick` / `banner` 属官方升级弹窗与营销位，`project-sidebar/index.tsx`
  已不再传值，footer 解析时需设为可选或删除。
- `StoreProvider.requestLoginEntry(user?, channel)`：远控对话框仍引用；本 fork 无官方账号，需要 desktop/shared
  明确它是本机 LAN 配对入口还是删除。
- `@zcode/services` 的 `withPluginTelemetry`、`clientConfigService.uiPluginRecommendations`、`shared/conversation-telemetry`：
  UI 已停止消费，服务侧删除时请同步本域调用点。
- 共享 chat CLI 显示（`hooks/useBuiltinAgentCli.ts`、`lib/builtinAgentCli.ts`）与 Office 预览
  （`hooks/readOfficePreview.ts`）为上游新增，需要 services/shared 的对应方法与协议字段确认后才能接线。
- `project-sidebar` 的项目批量移除/撤销/恢复、归档管理依赖的 Host 服务方法需 services 域确认；本轮不接永久 purge 入口。

## 页面控制器构造收口（2026-11-02）

`createPage` 仍唯一持有 latest、controller、snapshot、incarnation 与释放链。构造帮助函数只读取该 owner 的显式端口，不保存第二份状态；controller 的身份复验与 start 顺序不变。官方 UI 埋点无消费者，删除 no-op stub 和调用点，不恢复采样或上报。

## 最终验证记录（2026-11-02）

前文阶段 1 的冲突数量、接口需求及未执行说明保留为历史过程。最终源码已通过根 typecheck 与 changed 架构；主代理浏览器及接线回归 4/4，含 3 个真实组件场景和 1 个静态接线，保持 pending-review。根与 CLI Lint、全仓格式欠账及未验收环境见 [最终集成记录](../../docs/specs/official-3.17.1-integration.md)，不把早期解析或静态接线当作完整 Electron/手机验收。
