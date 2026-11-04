# Desktop 未读 Badge

## 目标

Desktop 把 ZCode task 的未读数显示到应用 Dock / launcher badge，口径以 task meta 的 `unreadAt` 为准，也就是“后台完成后还没点开看的 task 数”。

## 数据流

1. task 的持久未读权威是 tasks-index meta `unreadAt`。V4 `sessions-index` 不携带这个组织态字段，列表通过
   `taskListMembershipSets` 平行读取后 join 到 session summary。
2. 常驻 `ProjectDirectoryProvider` 从 Host ProjectTree 的共同未读集合构造 `WindowUnreadSnapshot`，
   task key 按 Host、`workspaceIdentity?.trim() || workspacePath`、taskId 去重。不读取旧缓存或临时 map。
3. 该 Provider 是窗口唯一 `IPlatformService.syncWindowUnreadCount(snapshot)` 发送者，Root 不再发送
   旧投影。通知关闭发送空快照；相同数量但成员变化也同步。Web 不发送本机角标。
4. Desktop preload / renderer bridge 通过 `PlatformChannels.SyncWindowUnreadCount` 发给 main。
5. Main 维护 `windowId -> unread projection` map，按 task key 跨窗口去重；窗口关闭清理其投影。
   macOS 使用 `app.setBadgeCount(totalUnread)`，Windows 使用 overlay 和托盘红点，清零恢复原图。
   本 fork 只发行 Windows/macOS 桌面包。

## 约束

- Badge 不混入失败红点、permission request 等其他 UI 状态，避免语义漂移。
- automation 的 schedule / manual run 收到与本轮 `traceId` 匹配的 `succeeded`、`failed` 或 `stopped`
  终态后，host 必须通过 `setTaskUnread(..., true)` 持久化关联 task 的 `unreadAt`。该规则不使用
  renderer 的 active session 推断“正在阅读”；用户显式点击 task 后由
  `useWorkspaceTaskNavigation` 清除持久状态，并同步 task query cache 的乐观值。
- Web 平台保持空实现，保证 desktop / web 共享同一套 `IPlatformService` 接口。
- 窗口关闭时会清理对应 unread 记录，防止 badge 卡住。

## 当前代码入口

- `packages/ui/src/project-sidebar/ProjectDirectoryProvider.tsx`
- `packages/ui/src/project-sidebar/view.ts`
- `packages/ui/src/lib/taskListMembershipSets.ts`
- `packages/shared/src/windowUnread.ts`
- `packages/desktop/src/main/desktopMainIpcPlatform.ts`
- `packages/desktop/src/main/desktopWindowLifecycle.ts`
- `packages/desktop/src/main/unreadBadge.ts`

2026-11-03 的回归证据与验证限制见 [桌面界面回归修复](../specs/windows-ui-regressions.md)。
