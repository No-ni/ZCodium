# Windows 任务栏未读角标（taskbar overlay badge）

## 背景

任务完成时桌面端有声音提醒，但用户专注别的事情时容易错过。Windows 在任务栏和托盘图标显示未读红点，macOS Dock 显示数字。

本 fork 只发行 Windows/macOS 桌面包。角标链路为 Host 权威树 → 窗口身份快照 → IPC → Main 去重聚合 → 平台 API；不读取旧 renderer 会话缓存。

## 角标语义

- 未读集合与侧栏「按未读」列表同源：Host `projectService.readTree()` 返回的 ProjectTree，只统计非归档且有 `unreadAt` 的可见成员。置顶成员、本机未归类成员及非删除项目成员使用已有共同选择器；其他孤儿与已删项目成员不产生幽灵提醒。
- 用户打开任务后集合减少，归零后红点消失；通知关闭也清空系统角标，应用内未读不变。
- 常驻 `ProjectDirectoryProvider` 唯一发送角标，隐藏侧栏/打开设置仍同步。Root 旧缓存投影已移除，完整身份避免跨窗口重复计数。

## 全平台统一链路

```
[Host] projectService.readTree() → ProjectTree.tasks[].unreadAt（tasks-index SQLite 权威）
    │  常驻 ProjectDirectoryProvider → 共同未读集合
    ▼
usePlatform().syncWindowUnreadCount(snapshot)              IPC: zcode:sync-window-unread-count
    │  （Web 不发送；成员变化即同步，关闭通知发送空快照）
    ▼
[Main] desktopMainIpcPlatform.ts → handleWindowUnreadCountSync
    │  windowUnreadCountMap（每窗口身份快照；跨窗口去重；关闭时清理）
    ▼
syncApplicationUnreadBadge(map)                     desktopWindowLifecycle.ts
    │
    ├─ darwin → app.setBadgeCount(total)
    └─ win32  → 对每个 BrowserWindow 调 setOverlayIcon + 托盘红点
```

统计与同步共用既有平台合同，Main 按平台选择系统 API。

## Windows 实现

Electron 在 Windows 通过 `BrowserWindow.setOverlayIcon(image, description)` 支持任务栏角标（Shell `ITaskbarList3::SetOverlayIcon`）。与 `setBadgeCount` 不同，**overlay 不负责渲染数字**，必须自绘徽章图。

- **位置**：overlay 由系统固定绘制在任务栏按钮右下角（与 Windows 更新盾牌、Outlook 同步状态同一机制），API 无位置参数，无法绘制右上角效果；右上角只在托盘角标上可行（自绘可控）。
- **观感**：任务栏 overlay 按 Windows 固定显示尺寸提供原生 1x（16×16）与 2x（32×32）`NativeImage` representation，不再把普通 32px 硬边圆交给 Shell 盲缩。红点为纯红、无描边、4× 超采样抗锯齿，逻辑直径约 7px。同一个安装包运行时按系统 build 自动选画布圆心：Win10（build < 22000）在画布内右下锚定，补偿旧任务栏的 overlay 落点；Win11（build ≥ 22000）在画布内居中，避免 Shell 已放到图标角上后再次右下锚定造成二次偏移。无障碍 description 仍携带具体数量（如 "3 unread tasks"）。
- **托盘角标**：Windows `Tray` 在应用图标右上合成纯红点（无数字）。当前代码把基图缩放到 32px 后合成约 8px 红点，并缓存未读图；`tray.setImage` 换图，归零恢复原图。macOS 使用 Dock 角标。
- **多窗口**：所有窗口统一显示全局未读总数（与 macOS Dock 显示应用级总数一致，符合"完成了几个会话就显示几"的直觉）。无任务栏按钮的窗口（CUA 指示器、更新状态窗等 skipTaskbar 窗口）设置 overlay 无副作用，不单独排除。
- **清零**：`count = 0` 时任务栏传 `null` image 移除角标，托盘恢复原图。
- **性能**：角标只在"任务完成 / 用户查看任务"时变化，更新频率为事件级；徽章图按 label 缓存在内存，单次更新是一次查表 + 一次 Shell 调用 / 一次托盘换图。
- **无障碍**：overlay `description` 传静态英文描述（主进程无 i18n 管线，v1 不做本地化）。

## 平台矩阵

| 平台    | 机制                                      |
| ------- | ----------------------------------------- |
| macOS   | `app.setBadgeCount`（Dock 数字）          |
| Windows | `BrowserWindow.setOverlayIcon` + 托盘红点 |

## 测试与验证

- 单测：label 解析（0/1~9/10+）、像素渲染尺寸/边距与关键像素颜色（含红点模式无数字）、预乘 alpha 混合、托盘换图（红点合成、清零恢复原图、无托盘 no-op）、win32 分支对 `setOverlayIcon` 的调用（含清零传 null、多窗口、跳过已销毁窗口）、darwin/linux 分支仍走 `setBadgeCount`。
- 手工验收目标（Windows）：后台完成 → 任务栏/托盘红点；全部查看或关闭通知 → 消失/恢复原图；多窗口使用去重集合。
- 2026-11-03 的组件浏览器与 Main helper 回归通过，详见 [桌面界面回归修复](../specs/windows-ui-regressions.md)。OS Shell 红点实际绘制尚未真机复验，不能据此宣称完整原生验收。

## 边界与已知限制

- 关闭到托盘使用现有托盘提示，隐藏窗口的任务栏按钮不显示；真正销毁窗口后清理其投影。
- 移动 Web 不发送本机系统角标；桌面统计已连接目录中的远端未读成员，沿用 Host/identity 隔离。
