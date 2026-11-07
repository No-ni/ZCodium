# 本地菜单交互补充测试计划

本计划先于外置 pending 测试代码落盘。测试当前 ZCodium fork 的真实菜单动作与设置保存；原产品与正式 E2E 文件不修改。执行文件为 `manual-review/pending/qa-local-menu-actions-20261106.test.ts`。主测试进程负责串行新建隔离 profile、构建当前源码并执行；本计划的静态审查或导入成功不代表 UI 验收通过。

| ID | 验收动作 | 状态所有者与恢复 | 明确边界 |
| --- | --- | --- | --- |
| QLA01 | 底部偏好 → 语言：英文/中文/系统；检查菜单选中及实际显示 | `localePreference` 设置；最后恢复英文基准，suite 收尾恢复原偏好 | 使用真实 submenu/radio，不直接调用测试 action 写偏好 |
| QLA02 | 底部偏好 → 主题：浅色/深色/系统；检查 radio、文档主题与本地偏好 | UI store/localStorage；finally 恢复原值 | 主题选项文案按当前 `Light theme`/`Dark theme` |
| QLA03 | 底部偏好 → 界面模式：办公/编码，检查菜单及持久化 | UI store/localStorage；finally 恢复原值 | 不发送任务、不触发 office 工作流 |
| QLA04 | 底部偏好 → 界面缩放：实际大小、放大、缩小与复原；读 main zoom | Main window webContents；通过真实菜单恢复初始 level | 不修改系统显示设置或窗口外 UI |
| QLA05 | 帮助 → 文档/社区/报告问题/功能请求，每项捕获准确目标 | Main `shell.openExternal` 完整 mock；finally restore | 只断言 fork URL，不打开浏览器，不创建 issue/消息，不真实联网 |
| QLA06 | 帮助 → 当前 About ZCodium、版本、截图与关闭；无自有更新源时更新项隐藏 | Main 的独立 About BrowserWindow | 不注入 update state、不检查/下载更新；无源前置不满足则明确拒绝该断言 |
| QLA07 | 记忆总开关即时保存；已加载 catalog 时 scope 菜单/刷新 | shared settings 即时保存，scope 仅 viewer 局部选中；finally restore | 不创建记忆、不选模型、不触发模型请求；空 catalog 无 scope 时记为 LIMITED |
| QLA08 | 常规设置中的归档开关关闭时仍可选 3/7/14/30 天；选 30 天再开关并验证保存 | shared settings；恢复 days 后恢复 enabled | 全合成空 profile，无真实用户任务；不执行删除/全量归档 |
| QLA09 | Browser 控制开关已就绪时切换并恢复；Windows 导入入口隐藏 | 本轮 builtin plugin enabled config | 不导入 Chrome 用户数据、不清缓存、不更改证书策略、不导航公网；插件不可用记 BLOCKED |
| QLA10 | Computer Use 总开关及 composer 显隐开关切换并恢复 | 本轮 builtin plugin enabled config 与隐藏标记 | 限 Windows；不触发 Helper、TCC、摄像头/屏幕权限、系统设置、电脑工具；插件不可用如实失败或 BLOCKED |
| QLA11 | Hooks loading/connecting 收敛后检查空态或列表；新建草稿填写后取消 | `HookForm` 局部状态；取消不保存 | 不保存或执行命令；比较本轮 config 内容指纹，避免把过渡截图判成 bug |
| QLA12 | 插件商店当前空态/本地卡状态；新增市场源对话框风险 gate、输入隔离目录后取消 | Add dialog 局部状态；取消无配置写入 | 不要求 public 卡；不刷新网络/下载/提交市场源/调用 native picker |

## 路径、网络与证据

执行前必须使用 `run-menu-tests.ps1` 同一隔离环境与 `-Bootstrap`：全部 HOME、APPDATA、TEMP、Node/tsx/Corepack/pnpm/npm/XDG cache 和 artifacts 均在当前工作树，原生文件选择被 bootstrap mock 到唯一 `DEFAULT_WORKSPACE`。拒绝 symlink/junction/reparse 与 inherited NODE_OPTIONS。使用新 RunId，不与已经运行的 worker 共用 profile。

外置 spec 不发 prompt；Provider replay 仅作为安全兜底。每项至少保存动作前及关键结果 PNG/JSON，含 UI controls、选择、偏好 projection、实际 assertion coverage 与恢复结果。每个 worker 用独立目录避免覆盖。`LIMITED/BLOCKED` 的案例 JSON 保留原因，Mocha 标记 pending，不把入口可达写成操作通过。

交互动作前用现有 Electron capturePage recorder 采集窗口序列：成功时仅清理本例自己创建的帧；失败时保留 PNG 帧、时间轴和本地 SVG SMIL 帧动画。当前 PATH 和本地依赖目录均未发现 ffmpeg，因此 MP4/WebM 未编码，证据明确受限；SVG 仅称帧动画，不能写成标准视频/录屏通过，不下载编码器。录制目标仅本应用窗口；About 额外独立 capturePage。所有输出、frameDir 和清理目标均先验证工作树边界和重解析点。

## 执行方式与记录限制

相对 `packages/desktop` 的精确 spec 路径：

```text
../../docs/testing/qa-2026-11-06/manual-review/pending/qa-local-menu-actions-20261106.test.ts
```

通过本轮已审查 runner 的外置 pending 路由执行，打开其 manual-review contract，但不要将 canonical 测试改用此模式。调用 pnpm 时不要插入单独 `--`；安装的 WDIO parser 实测显示其后 mochaOpts 会变位置参数，导致 root-hook 不加载。`-Bootstrap` 追加真实 UI 项目前置，不修复 BUG-004。初始 fixture 迁移错误与菜单交互失败分别记录。

菜单/控制 testid 与文字来自当前 `WorkspaceSidebarFooter.tsx`、`WorkspaceHelpMenuButton.tsx`、`MemorySettingsSection.tsx`、`TaskAutoArchiveSettings`、`BrowserSettingsSection.tsx`、`ComputerUseSection.tsx`、`HooksSection.tsx`、`HookForm.tsx` 与 `PluginAddMenu.tsx`。设置即时保存不能按旧“保存按钮”合同验收；公开市场自动拉取和旧官方帮助合同均不纳入本轮验收。

已执行 target-only TypeScript program（本 spec 与依赖 diagnostics 均为 0）和真实本地 tsx import，注册 12 项但未执行 hooks/tests/UI；[证据](logs/e2e-preflight-local-menu-static.json)。主测试进程运行前，套件从当前隔离 artifact 根读取同 worker 的最新成功 bootstrap after JSON，并核对其 DB 与 env 指定本轮 HOME 完全一致；不从 glob 返回的路径决定测试写入目标。
# menu-final 补测修正

2026-11-06 worker 0-0 的12项均未执行：beforeAll在切语言后检查退出菜单时调用旧WDIO元素的isDisplayed而stale。外置QA改成单次renderer DOM可见性/菜单状态快照，不再向旧handle询问可见性；真正点击仍用新WDIO handle并只对原生stale重查。beforeAll失败也保存当前PNG/状态。此修正不改变产品菜单、settings或bootstrap；待root串行重跑验证。

## menu-reviewed 结果与限定补测

2026-11-06 18:21UTC，worker 0-0 已退出：QLA01–04、06、09–12 共9项通过，QLA05/08两项失败，QLA07一项 LIMITED/pending。运行源码 SHA256 `07f2557d74b5d4068d1e48b8c86929a3573cfc2659fe8997fb40cb5b122bd31c`。原 [日志](logs/e2e-qa-menu-20261106-menu-reviewed.log) 与 `runtime/qa-menu-20261106-menu-reviewed/evidence/qa-local-menu-actions-0-0` JSON/PNG保持不变。

QLA08 的现场已选 Archive management，当前 `TaskAutoArchiveSettings` 实际由 `GeneralSectionContent` 渲染（settingsPageHelpers.tsx:448），因此仅修外置测试入口为 general，开关、四种时长、即时持久化与恢复规则不变。

QLA05 的首项 Product docs 已捕获正确 fork URL；User community 真实菜单点击后没有回调。Main 依 `readDesktopHelpConfig` 从开发 `appPath/../../config/default.json` 读取社区/反馈配置，WDIO staged app 只复制 main/host/renderer，没有仓库级配置。因此先仅在 QLA05 读取实际 Main appPath/isPackaged/resourcesPath，按同一生产公式计算路径；实际 appPath 必须在本 run `.e2e-cache/<RunId>/app`，配置 target 必须在本 run `.e2e-cache/<RunId>`，落共享目录、项目外或未知布局即 BLOCKED，不写入。目标既存即 BLOCKED，拒绝覆写。所有源、目标、祖先和目录先作 realpath/reparse 审查。

唯一可写初始化是将已审 `config/default.json`（SHA256 `8540f76782cf74d436dacd0f9d8bbd612a713dc951da9e1a1d38d9fef0882a86`；两 locale 社区与反馈仅本 fork URL）以独占 `wx` 写入缺失 target。复制前独占证据记录 source/target SHA、Main事实和 target 不存在；写后再次审路径并核 SHA。配置只属于新合成 run，不修改产品、runner或共享目录、不备份、不打开公网。之后仍以真实菜单和完整 `shell.openExternal` mock 验四项精确 URL。该 QA 前置不等于已证明发布包存在问题；下一串行独 grep QLA05/08，实际 UI 结果待执行。
