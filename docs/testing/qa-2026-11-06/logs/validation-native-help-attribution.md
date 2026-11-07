# 原生帮助菜单的当前命令与取消语义

2026-11-07只读核对当前工作树源码；本记录没有点击菜单、打开外部链接、调用清除或重启。它用于编写针对性QA，不能计为原生菜单UI通过。

| 动作 | 当前入口与命令 | 执行位置 |
| --- | --- | --- |
| 更新日志 / What's new | `desktopApplicationMenu.ts:273`，无显式MenuItem.id；`DesktopCommandIds.OpenChangelog`值为`openChangelog` | `desktopCommandHandlers.ts:322–330`通过shell.openExternal打开本fork的CHANGELOG；dispatcher:437–439 |
| 切换开发者工具 | MenuItem.id=`help.toggle-dev-tools`，role=`toggleDevTools`；命令`toggleDevTools` | `desktopApplicationMenu.ts:311–314`；`desktopCommandHandlers.ts:460–462`切换目标窗口webContents开发者工具 |
| 清除所有数据 | `desktopApplicationMenu.ts:332–333`，无显式MenuItem.id；命令`clearAllData` | `desktopCommandHandlers.ts:506–510`调用`clearAllDataAndRelaunch` |

命令枚举在`packages/shared/src/platform.ts:529,535,540`；菜单的中英文显示在`packages/shared/src/desktopMenu.ts`。菜单显示“关于ZCode”的遗留文本仍存在，与当前About dialog内容须分别核对，不能按旧UI spec的已移除菜单项一并运行。

清除确认对话框的源码契约在`desktopCommandHandlers.ts:80–92`：按钮为`["Cancel","Clear All"]`，defaultId与cancelId都为0。仅response===1继续；response=0或其它值立即return。取消发生在plugin sandbox清理、credentialsDir递归删除、各窗口localStorage.clear、session.clearStorageData以及app.relaunch/app.exit之前。

QA可在隔离应用中真实派发该命令、观察原生对话参数并返回0，验证上述写入/重启动作没有发生；需明确这是受控原生dialog取消回调验收，不是假称真实用户点击或清除确认分支验收。本轮不执行确认清除，不能据取消通过认定清除数据与重启功能已验收。
