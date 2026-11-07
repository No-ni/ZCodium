# 本地菜单合并执行计划

本计划合并已接受的菜单测试与两个独立复验，复用一次当前源码编译。每个 spec 仍由独立、串行的 WDIO worker 执行并按现有启动流程重置合成 HOME；不合并业务状态，不修改产品或原 canonical 断言。计划数为 5 specs / 43 it，实际结果只按 NDJSON 与 hook 记录统计。

| 文件 | 已接受用例 | 前置与范围 |
| --- | --- | --- |
| `qa-local-menu-actions-20261106.test.ts` | QLA01–12，12项 | 已修当前语言文案和真实 submenu 点击；偏好、帮助、关于、记忆、归档、Browser/CUA设置、Hooks、市场源取消 |
| `qa-residual-local-menus-20261106.test.ts` | RLM-01–13，13项 | 公开合成对话经真实 UI 导入；命令中心、复制、未读、导出、非法文件恢复、MCP/Commands取消、Skills草稿 |
| `qa-short-local-menus-20261106.test.ts` | SLM01–15，15项 | 原生帮助/开发工具/清除取消、项目排序、复制、引导、Bot取消、文件操作、Review/office、白板隐藏、受限PTY、聊天查找与预览负测；需静态READY才执行 |
| `ui-shell/side-pane-full-view.test.ts` | SPFV-E2E-001/002，2项 | 001创建Terminal tab，002依赖该tab。原64px断言失败与产品单行合同分开；新raw JS观察器采实际DOM，不修改布局 |
| `browser-permission/browser-permission-site-settings.test.ts` | 1项独立复验 | 首次站点默认geolocation查询应denied；新隔离session复验首次granted候选。仅query状态；不访问实际位置/摄像头。首条断言失败时后续允许/重置如实未执行 |

上述路径的前三项位于本目录 `manual-review/pending/`，最后两项位于 `packages/desktop/test/e2e/`。全局 grep 仅匹配前三组编号、SPFV001/002及精确站点权限标题。前三组不发送模型请求；SPFV和权限复验 `skipProvider:true` 也不发送请求，因此保持 pending 默认的唯一 `common.json` replay 兜底，不加载旧fixture池、不切capture。

root 是唯一 UI 执行者，前一 Browser run 完成且同身份 Electron 无残留后启动。使用新的 `qa-menu-20261106-menu-final`；全部 profile、缓存、合成workspace与证据仍在当前工作树。`-OpenSidePane` 提供这些菜单/布局用例共同需要的可见侧栏前置；不再把此开关用于无需求的Subagent设置复验。

`-SafeTerminal` 在编译/启动前审查PS7、模块路径、缓存路径与profile；short suite仍独立复验真实Host继承后才操作PTY。只执行本树合成文件读取与echo，不执行用户profile、外部命令或模型电脑操作。文件选择、帮助链接、剪贴板与危险确认均按各原计划的确切mock出口处理。取消/入口/隐藏负测不扩称真实删除、注册、网络或完整编辑通过。

执行命令（short suite 尚未READY时不得启动五文件批）：

```powershell
$qaSpecs = @(
  '../../docs/testing/qa-2026-11-06/manual-review/pending/qa-local-menu-actions-20261106.test.ts',
  '../../docs/testing/qa-2026-11-06/manual-review/pending/qa-residual-local-menus-20261106.test.ts',
  '../../docs/testing/qa-2026-11-06/manual-review/pending/qa-short-local-menus-20261106.test.ts',
  './test/e2e/ui-shell/side-pane-full-view.test.ts',
  './test/e2e/browser-permission/browser-permission-site-settings.test.ts'
)
& .\docs\testing\qa-2026-11-06\run-menu-tests.ps1 -RunId qa-menu-20261106-menu-final -Bootstrap -OpenSidePane -SafeTerminal -Specs ($qaSpecs -join ',') -Grep '(?:(?:QLA|RLM-?|SLM)\d{2}:|SPFV-E2E-00[12]|滑杆入口打开设置标签页；允许后立即生效，重置后回到询问)'
```

不把静态注册、预检或43项计划数写成UI通过；hook阻塞时只记实际抵达的用例。失败保留原始错误、截图/窗口帧与JSON，先区分QA合同、连接/时序和产品问题，再决定是否需要最小复验。该批次不提交、不推送、不打安装包。
