# 官方 3.17.1 合并｜services 域（packages/services/\*\*）

范围：`packages/services/**` 的冲突解决与新接线。上游 `zai-org/ZCode@a60ba6a7`（v3.17.1），本仓开工基线 `4ea45367`。索引与全仓检查由主代理统一处理。

## 合并方法

原始 merge 的 stage 以 `872ad960` 为共同祖先，对 `bots/**`、`gen-ui/**`、`window-project-directory/**`、`session/sessionModeOptions.ts`、`plugin-ui-bridge/**` 这类「双方各自新增」文件只给出 `AA` + 空基线，逐块裁决看不到上游真实增量。

核对事实：本仓这些模块实际源自官方 `v3.15.1`。例 `bots/botsService.ts`：`v3.15.1`→`v3.17.1` 只差 280/317 行，而 `HEAD` 相对 `v3.15.1` 是 280/3816 行的本仓改写。于是对这些文件改用 `git merge-file`，基线取 `refs/upstream-tags/v3.15.1`（缺失时 `v3.14.3`），`ours=HEAD`、`theirs=v3.17.1`，把上游 3.15→3.17 的全部增量直接叠到本仓改写之上。75 个冲突文件已降到 22 个仍带标记，且每文件块数明显变小。

辅助脚本在 `.run-logs/project-only-validation/services-3171-merge/`（工作树内、gitignored）：`remerge-all.mjs` 基线重算三方合并；`pick.mjs` 逐块 ours/theirs/union 显式裁决并打印决策日志；`importfix2.mjs`、`mergehunks.mjs` 做 import/export 语句级合并并过滤本仓剥离项；`hunks.mjs` 输出 diff3 视图。索引未动，等主代理统一 `git add`。

## 契约与所有者

- `project-storage/startup.ts`：`prepareTasksIndexStorage(path, onProgress, options)` 仍是 Host Worker 唯一启动 owner。保留本仓异步迁移链（`runTasksDatabaseMigrationsAsync`、`retrySqliteBusy`、`withShortBusyTimeout`、`AbortSignal`、`backupDirectories`、`BUSINESS_BUSY_TIMEOUT_MS`），吸收上游 `export type TasksStoragePhase`。未采用上游 `settings?: Pick<AppSettings, ...>` 位置参数和 `acquire()` 手写忙等；上游 `OffPeakTaskRepo` 不恢复。跨域：desktop `tasksStorageWorker` 若照抄上游调用形态会命中 TS weak-type 报错，须按本仓 options 传参。
- `source-server-management`：保留 fork 身份形态（`ConnectionProfile`、`SourceServerProfileOperation`、`SourceServerIdentityConfirmation`），新增 `stopSource(sourceServerId)`、`restartSource(sourceServerId)`、`getSourceRunningTasks(sourceServerId)`（返回 shared 的 `SourceServerRunningTasksResult`）。不吸收 `updateSource`、迁移报告、operation log、`UpdateConnectionProfileInput`，远端只有显式停止/重启，不存在自动部署、注册、下载或升级路径。
- `window-project-directory`：采用上游通用化契约（`projectService: IProjectService`、`remoteProjectService: IRemoteProjectService`、`changesService`），项目非破坏移除/恢复由 `remote-projects` 的 `deleted` 缓存与 `expectedLastSyncedAt` 版本复检承担。本仓 `app/windowProjectDirectory.ts` 与 `contract.test.ts` 已 `git rm`；替代证据：`remote-projects/{contract,index}.ts` 的 remove/restore 合同、`test/webRemoteProjectTreeActivity.test.ts`。跨域：desktop `host/index.ts` 需改用 `createProjectService` + `createRemoteProjectService` + `createWindowProjectChangesService` 组装窗口目录。
- `accessor.ts` / `index.ts` / `package.json`：吸收 `projectService`、`taskGroupService`、`remoteProjectService`、`windowProjectDirectory`、`deviceSyncStateService`、`providerProvisioningStatusService`、`userConfigSyncService`（data-sync 六类）、`task-facts`、`project-catalog`；`storage-startup` 出口指向 `project-storage/startup-entry.ts`；清掉自动合并带回的重复成员与重复 import。`@agentclientprotocol/sdk` 未加入 services 依赖（本域无任何 importer，且本机不安装依赖）。
- CUA：按用户后续裁决保留本仓 `@trycua/cua-driver`；撤销此前官方 Helper installer、LaunchServices 权限和 PiP 装配，不恢复下载或官方占位后端。Windows 显式开发 Helper 的已有生命周期保持。

## 审计边界裁决

上游在本域重新引入且必须继续剥离：`cloud-content/**`、`marketing-touch/**`、`highspeed/**`、`conversation-telemetry/remoteConversationTelemetry.ts`（本地 `conversationTelemetry.ts` 保留）、`model-provider/account*`（含 `accountProjectTokenClient.ts`）、`oauth/**`、`telemetry/**`、`session/offPeak*`、`official-mcp/**`、`project-storage/purge/contract.ts`（本轮不接永久 purge）、`conversationShareHttpClient.ts`、`index.ts` 的 FeedbackTicket 类型出口。`node.ts` 中被自动合并静默带回的 marketing/cloud 服务注册链已删除。

日志：`mcpSyncService` 保留不写真实路径与原始错误的净化写法，拒绝上游把 `filePath` 送进 `logger.warn`；`zcodeAgentProcessManager` 保留「stderr 只计行数」，拒绝上游 `stderrTail.snapshot()` 原文缓存。

并发写：`settingService`、`skillsService`、`pluginSyncService`、`mcpSyncService`、`settingsSyncService` 保留本仓跨进程统一锁 + 串行私有写 + `atomicWriteText(mode 0600)`，不回退上游无锁 `updateJsonObjectFile`；同时吸收上游「个性化指令文件 ENOENT 视为未配置」的修复。

数据根：`paths.ts`、`skillSyncService`、`pluginSyncService`、`storage/adapters/rootsResolver.ts` 一律走 `ZCODE_USER_DATA_DIR_NAME`（`.zcodium`）；新增 `getProviderWorkspaceConfigDir` 的回退也取本仓常量而非官方 `.zcode`。`coding-plan-subscription`、`usage-stats`、`onboarding` 的上游增量全部是官方套餐支付/权益/重置、云端额度与设备归因（`deviceMid`、`loadUserId`）面，按边界保留本仓本地实现。

## 本域吸收项（择要）

`sessionModeOptions` 官方 mode 全集与语义映射；`subagentsService.collectAgentMarkdownPaths(root, recursive)`（`data-sync/subagentDataSync.ts` 依赖）；`skillSync` 的 `SKILL_DATA_SYNC_MAX_ITEM_BYTES`、`UserSkillCandidate`、导出 `getUserZcodeSkillRoot`；`pluginSync.readPluginManifestInfo`；`mcpSync.readZcodeServerMap`；`bots/**` 上游通道实现叠在本仓 3.15.1 基线改写之上（astrbot provider 等本仓自有文件未被覆盖）；`gen-ui` 保留本仓「Renderer 不得自报执行目录」的可信查询端口。

## 未解决与验证

本域未跑 typecheck / lint / 单测 / 架构检查（全仓项由主代理统一执行）；只做了冲突标记计数与语句级合并自检，因此类型与运行行为均未验证。仍带冲突标记的文件与各自块数见本轮结束报告。

## 2026-11-02 启动装配续接

Host 只装配当前公开契约：Bot 远端复用窗口已有 Source connection，由 `bot-project-runtime` 做 owner/lease 路由；删除并列的 parentPort workspace bridge 装配。偏好下发保留问答与 ToolSearch，不下发自动录制。普通 BYO Bot 的话题附件由授权 Host 校验；显式 peer channel 只转发可信连接上的分块请求，不连接官方 relay 或平台。CLI 会话查询不传 Host 归档字段，GenUI 查询仍按明确 session ID 取执行目录。本地打包 scenes/default config/动态工作流开关继续使用已有本地实现，无官方请求；缺失的官方 CUA 和网络捕获出口以及插件统计装配删除。Subagent 配置缓存的生命周期接线另行核对，不为消除类型错误删除该端口。

进程退出诊断的完成信号由原 `ZCodeAgentProcessManager` exit listener 唯一结算。先收齐 stderr、发出一次结构化生命周期事件，再在 finally 完成 `exitDiagnosticsCompleted`；正常退出、协议故障回收和诊断失败均不得遗失此信号。原 cleanup Promise 等待该信号后释放 ownedProcesses，不用超时跳过 stderr 或丢弃进程所有权。当前源码 Worker 的 dispose/resume 回归覆盖这条真实退出路径。
