# 原生上下文压缩验收覆盖

2026-11-12。规则来自已授权的[实施契约](../specs/native-context-compression-implementation.md)、[产品方案](../specs/native-context-compression.md)、[90 项参数](../specs/native-context-compression-parameters.md)与[趋势页面](../specs/native-context-compression-trends.md)。本表只登记 NCTX，不覆盖已有 Provider 验收记录。

手机 admission 的源码回归应执行 `mobile.ts` 中实际的关闭回调，确认详情与 Popover 已隐藏后才进入任务首页；提取回调的测试夹具必须显式装配这一依赖。源码回归与提交前静态检查单独记录，不计入下面的产品 E2E 场景数。

最新重点回放 [JJskJz][JJskJz] **所选 4 场全部通过，0 fail / 0 skip，另 28 场未选，exit 0**；[逐场结果][JJskJz-results]与[退出收据][JJskJz-exit]一致。Read/新任务默认 auto、PNG 发送缩图与原图预览、手机 320/390/736px 触摸联动及真实在途 reload/hide-show、手机参数主题/中英文/system selected 与 reloaded 均完成原断言。桌面与手机 3000 条账本另在 [0t3rov][0t3rov]通过。以下各轮失败保留历史身份，不拼成完整 32 场通过。

当前最新完整产品轮仍为第六轮：**32 场，28 通过、4 失败、0 跳过**，[报告][R6]与[逐场结果][R6-results]均已保存。第七轮 [FzMwnE][R7]已结束并中断（interrupted）：**实际 10 场，9 通过、1 超时失败、0 跳过；其余 22 场未执行**，[逐场结果][R7-results]仅有这 10 条。第七轮只补首 9 场的产品证据，不能以第六轮历史结果或源码修复补齐新编译产品的 32 场。候选仍在 `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-native-context-compression.test.ts`；[case-local 结果][R6-cases]的 `humanReviewed=false`、`promoted=false`，没有人审、promotion 或 CI admission。

托盘修复后的 [24LYLb][24LYLb]已完整执行所选 **8 场：5 pass / 3 fail / 0 skip，选中未执行 0 场、另 24 场未选，exit 1**。本轮手机已到达共享 Root 的任务页与可读 Main 查看记录，首错是趋势几何 helper 的页面序列化错误，后两场是复用 Page 的 Home 入口等待超时；不再登记为此前的 bootstrap 阻断。当时手机恢复、设置和账本未通过，不能以五项成功补齐完整 32 场或手机覆盖；[case-local][24LYLb-cases]仍未人审或 promotion。

较早重点 [9zSF2H][9zSF2H]已完整执行所选 **6 场：4 pass / 2 fail / 0 skip，选中未执行 0 场、另 26 场未选，exit 1**。[逐场记录][9zSF2H-results]、[case-local][9zSF2H-cases]与[退出收据][9zSF2H-exit]一致；手机 3000 条账本首次整场通过，当时恢复与系统语言失败。复用 24LYLb 的产品编译和已有驱动，source、独立复用证明与产品结果分层保留，不累计补齐完整 32 场。

第八轮 [部分结果][R8-partial]和[逐场记录][R8-results]仅有 **25 场、21 pass / 4 fail / 0 recorded skip，另 7 场未执行**。没有 summary 或退出收据，退出值和终止原因未知。实际复用了第七轮编译与已有驱动；独立哈希核对覆盖 renderer/Host/Main，不包含原 collector 未登记的 CLI 编译指纹。第七轮手动维护卡顿在同编译第八轮没有复现，仍不能确认根因。

第九轮按最新要求只选 **13 场重点场景，实际执行 10 场：9 pass / 1 timeout / 0 skip，另 3 场未执行**：[报告][R9]、[逐场结果][R9-results]、case-local 结果及退出收据一致，exit 1。空态、Read 初始化、手动/自动维护、Stop/关闭 auto/保存参数三种在途中断、opaque PNG 降采样与原图预览、桌面 3000 条账本通过。手机在 `bootstrap-request` 后停留于“读取桌面工作区失败”，尚未挂载共享 Root 或执行恢复主断言；Main 诊断也是读取超时，不能记为 `mobileTaskView=null` 或生命周期修复失败。随后 WebDriver 与 teardown 同样超时，手机设置、手机账本及模型原图回取没有执行记录。其余 19 场未选，不计 skip；新的产品结果不改变 source-only 或人工待审边界。

第九轮后的两次定位回放分别保留实际结果，不另补齐 32 场：[gvELa2][gvELa2] **选 5 场、执行 3 场，2 pass / 1 timeout / 0 skip；选中未执行 2 场，另 27 场未选**。Read 与 opaque PNG 通过，手机仍在初始 bootstrap 准入等待 60000ms 失败，手机设置和模型原图回取未执行。[GOGcoE][GOGcoE] **选 2 场、执行 2 场，1 pass / 1 timeout / 0 skip；选中未执行 0 场，另 30 场未选**。Read 通过，手机仍在同一准入边界失败。两次的 summary、[逐场记录][gvELa2-results]、[逐场记录][GOGcoE-results]、case-local 结果与退出收据一致，均 exit 1；之后 WebDriver、after-all 和 deleteSession 也超时。两次均未进入共享 Root、恢复/设置或 Main 查看主断言；未执行大账本仍出现同类准入失败，只缩小了复现前置，不能据此确认根因。

构建证据须与运行计数分开：第九轮[源码指纹][R9-build]为 `fresh-stable`，覆盖 renderer/Host/Main，不含 CLI 编译指纹；suite SHA 与[静态 13 场选择][R9-selection]一致。两次定位的[构建收据][gvELa2-build]、[构建收据][GOGcoE-build]均明确为 `unverified-reused-build`、`sources={}`。其 5734 项已保存输出指纹与第九轮一致，但没有补成独立的源码到复用构建验证，不能作为最新源码的新通过证据或累计为独立覆盖。

GOGcoE 期间的 [main-watch-S8WVRB][main-watch]只有 Inspector 的 `Debugger.enable` 成功应答；20 次 pulse 中，前 4 次 `exception=true` 且没有返回 value，后 16 次 timeout，没有暂停栈。异常响应不等于健康 heartbeat，超时也不能单独证明 Main 同步死循环或具体 bootstrap 函数故障。手机结构采集仍为 Main `read-timeout`，不是读取成功的 `mobileTaskView=null`；这项现场记录不新增产品通过。

随后三次现场定位 [s0tiym][s0tiym]、[2rd4y7][2rd4y7]、[PEXPbP][PEXPbP]均为 **选 2 场、实际执行 2 场，1 pass / 1 timeout / 0 skip，选中未执行 0 场、另 30 场未选，exit 1**。各轮 summary、逐场记录、case-local 状态与 completion 一致：`NCTX-01/06` Read 初始化通过，`NCTX-18/26/55` 手机初始准入等待 60000ms 超时，未到达共享 Root、真实 Main 查看或 reload 主断言；不累计为手机覆盖。三次构建收据均为 `unverified-reused-build`，不增加最新源码编译通过证据。

定位证据按层级保留：[s0tiym GUI 采样][s0tiym-gui]在阻断时未见 menu/movesize/capture 状态；[2rd4y7 的 Eqzb9p 原生栈][native-dialog-stack]记录 `NtUserMsgWaitForMultipleObjectsEx → DialogBoxIndirectParamW → COMCTL32 → electron.exe`，确认 Main 主线程停留于原生 DialogBox。PEXPbP 最终工具 stdout 则读到 `Uncaught Exception`、`invalid buffer size` 及 `trayImage → syncWindowsDesktopTrayUnread → syncApplicationUnreadBadge → handleWindowUnreadCountSync → IpcMainImpl`，结论登记在 [WINUI22][tray-regression]。**最终错误文本及函数栈来自当时工具输出，未保存原始 UIA JSON**；[PEXPbP 早期 Inspector 采样][PEXPbP-inspector]不含这份最终文本，不能作为已归档的错误原文。原生栈本身不证明错误消息或业务函数栈。

[NativeImage 数值 probe][nativeimage-probe]使用 Electron 44.7.0、Windows 实际屏幕 scaleFactor **1.5**，未创建 BrowserWindow：真实仓库 ICO 为 256×256，缩至 32×32 后有 1x 表示、4096 字节，默认与显式 1x 重建均成功；失败运行的 staged 图标缺失，得到空图、0×0、0 字节，按 32×32 重建复现 `invalid buffer size`。另一个 **synthetic 2x-only** 图像逻辑尺寸为 32×32，但默认与显式 1x bitmap 均为 16384 字节，按固定 32×32 重建均失败；这不是另一块真实 200% 屏幕。该 probe 只证明资源、表示和字节契约，不能推断 125%/200% 实屏、安装包、macOS 或手机产品验收。

三次失败回放当时的 E2E staging 仅复制 `out`，未复制隔离 Main 开发路径所需的 `build/icon.ico`；这与 probe 的缺失 staged 输入相符。后续按 WINUI22 保留已发布 ICO、增加空图/实际尺寸/字节保护并补齐平台图标 staging。配对 Dialog 关闭屏障只是测试时序收口，**不是此次 Main 原生错误的修复或手机通过证据**。修复后的产品结果另列，现有失败和此前各轮边界保留。

WINUI22 [源码冻结索引][tray-source-index]保存旧 HEAD **1/3、exit 1** → 当前工作树 **3/3、exit 0、0 skip**：有效 ICO 在两组均通过，旧空图和仅 2x 输入复现 `invalid-buffer-size`，修后完整 `0→1→8→0→1` 未读序列保持基础图、零无效位图构造或缓存。回归执行真实 `desktopTray` / `unreadBadgePixels` 与 NativeImage，Tray/Menu 为受控端口，没有原生窗口；不算安装包、全部 DPI 或手机链路通过。[平台图标 staging 回归][tray-staging] **5/5、exit 0**，只登记准备阶段的资源契约，不替代产品回放。

[24LYLb summary][24LYLb]、[逐场记录][24LYLb-results]、[case-local][24LYLb-cases]与[退出收据][24LYLb-exit]一致。五项成功为真实 Read 初始化、桌面常规设置四宽度/浅深主题/中英文、opaque PNG 降采样与原图分块预览、桌面 3000 条账本分页/SVG/原始点详情，以及模型原 PNG 回取。手机恢复在 `readTrendGeometry` 的页面序列化出现 `ReferenceError: __name is not defined`；后两手机场在 `showMobileTaskHome` 等待 sidebar 30s 失败，设置和账本主断言未执行。[手机结构记录][24LYLb-mobile]已到达 `onboarding-ready` 与 `task-open`，后者的 Main readable/connected/viewPresent/taskMatches/workspaceMatches 均为 true；这些阶段事实不等于在途 reload、隐藏/恢复整场通过。本轮 Main 读取有响应，[运行日志][24LYLb-log]记录 teardown 与 `deleteSession` 正常返回，未重现此前 Main/WDIO 一起挂起的边界。

本轮[编译指纹][24LYLb-build]为 renderer/Host/Main 的 `fresh-stable`：3469 项源码、5744 项输出、`changedFiles=[]`。[同一运行日志][24LYLb-log]第 3310/3314/3318/3326 行分别记录 CLI 的 dynamic-workflow-runtime/core/adapters/bootstrap 包 build，后续命令为 `tsc`，即这些 CLI 包本轮重新执行编译；collector 仍没有 CLI 源码或输出指纹，不能把三域 `fresh-stable` 泛化为 CLI 复用验证。后续复用仍以独立源码/输出哈希核对为准，不预填下一轮成功。

[页面回调序列化冻结索引][page-serialization]区分旧临时 probe **3/7 通过、4/7 ReferenceError/module-name-unavailable** 与当前正式脚本 **7/7 通过、0 fail/skip**，不把临时 probe 写成正式新脚本已跑红。实际 `tsx 4.21.0 keepNames` 编译审阅 68 个 suite 可达模块、34 个 Page evaluate/waitForFunction 调用点、29 个独立回调 payload，绿例 `vulnerable=[]`。`readTrendGeometry`、`readParameterGeometry`、`readSettingsUi` 和 `readNativeContextLargeLedgerSvg` 的浏览器上下文布局/几何/SVG 数值断言均成功，另三项为原控制回调。函数经 `toString` 传入无模块 `__name` 的独立 JSDOM realm；元素边界、getBBox/getTotalLength 是受控几何端口。这是序列化和数值 source 证据，不是真实浏览器布局、SVG 或手机产品通过。

[关闭 helper 单文件回归][mobile-close-source]单次执行 **5/5、0 fail/skip、exit 0**，其中原桌面三场保持、新增手机两场。AST 转译执行真实 `closeNativeContextMobileDetails`，受控 JSDOM Page 将关闭按钮/Escape 回包与 DOM hidden 分开：未隐藏时不返回，显式提交关闭后才返回，已关闭时无额外 click/Escape/hidden 等待。没有用 sleep 同步；该回归只证明 helper 关闭屏障，不代替手机导航、Main 查看或后续场景通过。

[复用前独立核对][build-reuse-before]为 `status=matched`：3469 个 packages 源码与 5744 个 desktop/out 输出匹配 24LYLb receipt，变化数为 0；同时冻结 1767 个 CLI 源码和 3338 个 dist 输出作为当前 replay 的前快照。[运行中复核][build-reuse-during]再次 matched，实际 staged app 的 5744 个输出亦全数相等，无缺失、变化或额外文件，CLI 与前快照无变化。CLI 两次快照只证明本次 replay 稳定，原 collector 没有 CLI 编译指纹的缺口仍在；不以当前 CLI 哈希补写历史编译事实，也不改写 reporter 的 `unverified-reused-build`。

9zSF2H 四项成功为真实 Read 初始化、opaque PNG 降采样/分块原图预览、桌面 3000 条账本以及同一手机 Page 的 3000 条账本。[手机账本数字][9zSF2H-ledger-mobile]与整场通过记录一起支持有界分页、真实 SVG 极值/未知缺口、事件和原始点详情，不泛化为手机恢复已通过。手机恢复在布局前置的真实 `locator.tap` 失败：第一估算圆点被同 request 的发送估算圆点覆盖，在途请求/reload/hide-show 主断言尚未执行。手机设置已完成 **390/320px、浅深主题与中英文四种组合**的参数/底栏/三图/返回断言并生成 32 张布局 PNG，随后首次选择 `system` 时等待 Host 偏好与 Electron OS 解析值一致超时，尚未 reload；该轮子集为 partial，整场 fail。[失败 PNG][9zSF2H-settings-failure]只证明当时 UI 为系统默认/中文，日志截断的 Setting 返回数组不足以确认错误 owner 或旧广播覆盖。两项首错不再是序列化或 bootstrap 阻断；[运行日志][9zSF2H-run]记录 Main 查询、清理和 `deleteSession` 正常返回。当时计划的四场定向复测随后执行，实际结果见下节。

Windows 产品 E2E 使用真实 Desktop、同一个 window-scoped Host/CLI、实际请求捕获和确定性 Provider 回放。共享 suite 计划每轮复用环境、一次手机 persistent context、一次 Electron 冷重启；R7 没有到达手机和冷重启场；有源码改动时统一重新编译，复用驱动。离线大账本和图片均为工作树内合成数据，维护费用数字是实际消费的回放 usage，不表示向真实模型 API 付费。Runtime/SQLite、受控 Model/statusSink、React/JSDOM 和 helper 回归各按自己的层级登记，不能作为产品 E2E、macOS 真机、实体触摸或真实模型摘要质量的替代证据。

## 最新重点收口

各轮均完成所选场景；未选场景不计 skip。计数来自各自 summary、逐场结果与退出收据，不能累计为新的唯一产品总数。

| 运行             | 所选/执行 | pass / fail / skip | 另未选 | exit | 实际边界                                                                                |
| ---------------- | --------- | ------------------ | ------ | ---- | --------------------------------------------------------------------------------------- |
| [l1tS3u][l1tS3u] | 4 / 4     | 2 / 2 / 0          | 28     | 1    | Read、PNG 通过；手机触摸失败，system 在选择前的 OS 枚举校验失败                         |
| [0t3rov][0t3rov] | 6 / 6     | 5 / 1 / 0          | 26     | 1    | 新编译；两端 3000 账本、三宽触摸和在途恢复通过；system 选择通过，重载后测试导航前置超时 |
| [5bDGL4][5bDGL4] | 4 / 4     | 3 / 1 / 0          | 28     | 1    | 同编译；system selected/reloaded 全断言通过；手机恢复末段首页导航前置超时               |
| [JJskJz][JJskJz] | 4 / 4     | 4 / 0 / 0          | 28     | 0    | 同编译，146827ms；Read、PNG、手机触摸/在途恢复和手机设置全部通过                        |

`l1tS3u` 的新增枚举确认 Electron OS 期望为 `undefined`，而 Host/UI 偏好均为 system、解析均为中文。WDIO Electron service 移除回调首参，Main 仅暴露 `electron`；测试由 `({ app })` 改为 `(electron) => electron.app...`，从同一 Main 独立读取 OS。先选与 OS 不同的固定语言，再选择 system，保留 OS/Host/UI、完整默认配置、任务策略/revision 与零新增 Provider 请求断言。

产品图表改为用真实 mouse/touch 事件坐标映射原始请求 index，touchEnd 读取 changedTouches，不依赖未随移动触摸更新的 Recharts hover index；保留唯一 selection owner、键盘与 hover Tooltip。0t3rov 的 [320px][touch-320]、[390px][touch-390]、[736px][touch-736]保留数字：requestCount=3，previousIndex=2 → touchedIndex=1，详情及三图 indices 均为 `[1,1,1,1]`，返回趋势保持选择。图外、非法几何、多触点不选，不使用采样 ordinal 代替原始请求。

0t3rov 的 system 已到 selected-converged；重载后 DOMContentLoaded 早于共享 Root 的导航就绪，测试等待 sidebar 超时。5bDGL4 补 pane 可见及严格 session 身份等待后，system selected/reloaded 全部通过，但手机在 hide/reload/show 后的同一 Home helper 仍超时；该失败现场没有保存当时 back 可见性的 boolean，不据此声称捕获了 back=false。最终共享 `showMobileTaskHome` 先等待可见 sidebar 或 Back，必要时点真实 Back，再等待 sidebar；只修测试导航时序，产品恢复和语言断言保持。

[触摸/序列化/键盘源码冻结][pointer-source]单次合并 **20/20**（5+7+8）；有效旧 pointer RED 为 1/5，最初几何夹具失败不算产品红例。最终类型守卫后仅 pointer 5/5 复验，不累计为 25 个唯一场景。[首页 helper 源码冻结][home-source]执行真实 TypeScript AST 与受控 Locator，同五场 **旧源 4/5 → 修后 5/5**；这些 source/JSDOM 结果不替代浏览器产品断言。

0t3rov 的[桌面账本][ledger-0t-desktop]与[手机账本][ledger-0t-mobile]各 loaded=2970、drawn=85、cacheSegments=4、events=4；桌面 allPages=15、recordPages=5。数字与各自整场通过记录共同证明有界分页、三图极值/未知缺口、事件和原始点详情，不能扩大到任意账本规模。

0t3rov 的[原编译收据][build-0t]为 renderer/Host/Main `fresh-stable`，3469 项 packages 源码、5754 项 Desktop 输出；CLI 原 collector 未采编译指纹。[首次复用前][reuse-0t-before]、[5b 后/下一轮前][reuse-0t-between]、[JJ 运行中实际 staged app][reuse-0t-during]与[JJ 后、根 typecheck 前][reuse-0t-after]均 matched，missing/changed/extra 均空；CLI 1767 源码/3338 输出只证明回放前中后稳定。原 reporter 的 `unverified-reused-build` 不改写，不补称 CLI 原构建已哈希核验；根 typecheck 随后覆盖 out，不能再将其输出当作该产品构建证明。

JJskJz 的成功隔离 HOME 已由既有 onComplete 清理，当前可归档的是 summary、test-results.ndjson、completion 和独立复用证明；不链接已删除的该轮 case-local、阶段 JSON 或 PNG。前述触摸、账本和 system 阶段数字归属保留它们的运行，不能说属于 JJskJz。实体手机、macOS、真模型质量、剩余异步故障组合及人工 review/promotion/CI admission 均不在这次重点通过范围。

## 产品执行历史

| 产品轮            | 实际结果                                                                                                      | 保存证据                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 首轮              | 19 场：1 pass / 18 fail / 0 skip                                                                              | [zE3aVx][R1]                                                                                   |
| 第二轮            | 32 场：13 pass / 19 fail / 0 skip                                                                             | [X6iFbn][R2]                                                                                   |
| 第三轮            | 32 场：18 pass / 14 fail / 0 skip                                                                             | [GvVZ0R][R3]                                                                                   |
| 第四轮            | 32 场：22 pass / 10 fail / 0 skip                                                                             | [d6v88K][R4]                                                                                   |
| 第五轮            | 32 场：27 pass / 5 fail / 0 skip                                                                              | [wQ9PfS][R5]                                                                                   |
| 第六轮            | 32 场：28 pass / 4 fail / 0 skip                                                                              | [kU95iV][R6]                                                                                   |
| 第七轮            | interrupted；实际 10 场：9 pass / 1 timeout / 0 skip；22 场未执行                                             | [FzMwnE][R7] / [逐场结果][R7-results]                                                          |
| 第八轮            | 部分结果；25 场：21 pass / 4 fail / 0 recorded skip；7 场未执行，退出未知                                     | [部分证据][R8-partial] / [逐场记录][R8-results]                                                |
| 第九轮            | 重点部分结果；选 13 场，实际 10 场：9 pass / 1 timeout / 0 skip；3 场未执行，exit 1                           | [4UncAx][R9] / [逐场结果][R9-results]                                                          |
| 定位 gvELa2       | 选 5 场、实际 3 场：2 pass / 1 timeout / 0 skip；2 场未执行、27 场未选，exit 1；复用构建未验证                | [报告][gvELa2] / [逐场结果][gvELa2-results] / [退出][gvELa2-exit]                              |
| 定位 GOGcoE       | 选 2 场、实际 2 场：1 pass / 1 timeout / 0 skip；0 场未执行、30 场未选，exit 1；复用构建未验证                | [报告][GOGcoE] / [逐场结果][GOGcoE-results] / [退出][GOGcoE-exit]                              |
| 定位 s0tiym       | 选 2 场、实际 2 场：1 pass / 1 timeout / 0 skip；0 场未执行、30 场未选，exit 1；复用构建未验证                | [报告][s0tiym] / [逐场结果][s0tiym-results] / [case-local][s0tiym-cases] / [退出][s0tiym-exit] |
| 定位 2rd4y7       | 选 2 场、实际 2 场：1 pass / 1 timeout / 0 skip；0 场未执行、30 场未选，exit 1；复用构建未验证                | [报告][2rd4y7] / [逐场结果][2rd4y7-results] / [case-local][2rd4y7-cases] / [退出][2rd4y7-exit] |
| 定位 PEXPbP       | 选 2 场、实际 2 场：1 pass / 1 timeout / 0 skip；0 场未执行、30 场未选，exit 1；复用构建未验证                | [报告][PEXPbP] / [逐场结果][PEXPbP-results] / [case-local][PEXPbP-cases] / [退出][PEXPbP-exit] |
| 修复后重点 24LYLb | 选 8 场、实际 8 场：5 pass / 3 fail / 0 skip；0 场未执行、24 场未选，exit 1；手机失败已到任务页/helper 阶段   | [报告][24LYLb] / [逐场结果][24LYLb-results] / [case-local][24LYLb-cases] / [退出][24LYLb-exit] |
| 手机重点 9zSF2H   | 选 6 场、实际 6 场：4 pass / 2 fail / 0 skip；0 场未执行、26 场未选，exit 1；手机账本通过，恢复与系统语言失败 | [报告][9zSF2H] / [逐场结果][9zSF2H-results] / [case-local][9zSF2H-cases] / [退出][9zSF2H-exit] |

第七轮首 9 场对应下表第 1–9 行：空态、Read 历史、90 字段、JSON/草稿、两作用域四宽度、默认捕获、导出与桌面设置已通过。第 10 场 `NCTX-04/06/11/16/49` 手动维护在 180001ms 超时，随后 WDIO 不再响应并结束会话；其余第 11–32 行没有执行记录，不能记作 skip、已通过或已复测 blocked。手机、账本、图片、自动维护、中断及冷重启的最新完整轮证据仍为 R6；超时/断链根因尚未确认。

第三轮的前次启动 `az7Uil` 在 onPrepare 读取已删除的 tracked 源文件时失败，**0 场产品测试执行**，不计作另一轮 32 场。报告器用真实工作树 Git 夹具红 2/4、修后 [4/4](../../.run-logs/project-only-validation/nctx-e2e-source-deleted-green-VpSiDv/logs/validation.log)，只忽略 ENOENT；tracked/untracked、构建期间删除与其它 IO 错误仍检测，没有关闭源码指纹或复用旧 build。

第六轮大账本已通过 seed/resume 独立版本及物理事实的前置对账，随后在分页 envelope 仍误比 seed 版本处失败：恢复 owner 为 revision 1，而冻结 seed 为 revision 0；后续 SVG、聚合和点详情未执行。修复后 envelope 严格对独立 `resumeExpected`，item 仍对冻结 seed，实际收集函数回归红 0/4→[绿 4/4](../../.run-logs/project-only-validation/nctx-r6-ledger-page-green-I3vUBx/logs/validation.log)；分页 source 回归不能代替产品。R8 桌面 3000 条账本已实际通过全部分页、SVG 极值/未知缺口和原点详情，该轮手机账本未完成；最新 [9zSF2H] 的桌面与手机账本均通过。原 ledger 恢复 recipe 的证据继续有效，但[分页修复索引][ledger-page]已合法改动原 13 文件快照中的 `ledger.ts` 和趋势 spec，不能声称原 13 个 SHA 全部未变。

第六轮手机已配对并读到共享 Root 的真实 pane/session，但在首启 preflight 的 Home/chat 可见屏障超时；Main readable/connected、`mobileTaskView=null`，不能把 pane 存在算作真实查看通过。后两手机场因没有已准入 Page 被 blocked。新 JSONL/PNG 才明确暴露 App 收到 switcher、唯一 Shell 调用未透传，窄屏因此走宽屏分支；旧第五轮采集异常没有足够证据定位此原因。App 透传修复与 Shell/Reporter source 回归不替代产品查看。R8 的 Home/首启屏障已通过，点击任务进入聊天时真实错误边界显示 `SessionDataLayer 已释放，不能再 acquire`；后续手机设置和账本没有完成主断言。手机单次挂载契约与 Popover teardown 先用真实源码红绿回归，再定向复测 Main 查看、reload、设置与账本。

## 32 场实际产品断言

下列 `covered / pending-review` **仅指这一行列出的 setup/action/assert**，不是该行 NCTX 标签的全部规则。本表保留第六轮完整历史 artifact；R7 第 1–9 行通过、第 10 行超时、第 11–32 行未执行，见上节；不据 R6 结果推定 R7 后续通过。同一标签的未验子规则在后两节另列。

| 序  | Accepted 标签       | 实际设置、操作和断言范围                                                                                            | 第六轮状态                          | 证据                            |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------- |
| 1   | NCTX-03             | 空草稿打开入口/Popover；未知显示、auto 默认、立即压缩禁用、短图可见；零 Provider 请求                               | covered / pending-review            | [R6]                            |
| 2   | NCTX-01/06          | 真实 Read 构造完成历史；新任务 auto，canonical 工具及主请求、完成 usage 和 owner 对账                               | covered / pending-review            | [R6]                            |
| 3   | NCTX-23/24          | 枚举 90 字段，普通表单与完整 JSON 使用同一个 strict 配置；有效工具表与产品署名链接只读核对                          | covered / pending-review            | [R6]                            |
| 4   | NCTX-27/60          | 非法 JSON/未知字段/依赖与 NaN 拒绝；未加载 JSON、两作用域、跨页签/Escape 的草稿保留                                 | covered / pending-review            | [R6]                            |
| 5   | NCTX-21/23/57/60    | task 参数在 1024/736/390/320px 的真实鼠标、Tab/键盘、末字段、JSON 和底栏可达                                        | covered / pending-review            | [R6]                            |
| 6   | NCTX-21/23/57/60    | defaults 参数在相同四宽度的真实鼠标/键盘与底栏；作用域独立                                                          | covered / pending-review            | [R6]                            |
| 7   | NCTX-20/23          | defaults 与 task 分别保存；ACK+fresh 的版本/完整配置与同 Local Host 对账；真实后续新任务捕获默认，原任务不突变      | covered / pending-review            | [R6]                            |
| 8   | NCTX-24/60          | 原生配置导出与取消；工作树文件完整、无 policyVersion，取消不落文件/不提交草稿                                       | covered / pending-review            | [R6]                            |
| 9   | NCTX-21/23/56       | 桌面常规设置进入 defaults；四宽度、浅深主题、中英语言和返回原任务可达                                               | covered / pending-review            | [R6]                            |
| 10  | NCTX-04/06/11/16/49 | 真实手动维护；完整 offered refs、唯一维护请求、成功块、独立 4800/110 usage、原文读取/引用及下一主请求用摘要         | covered / pending-review            | [R6]                            |
| 11  | NCTX-04/06/11/16    | 两次主请求播种后开启 auto；第二轮安全点一次维护，不点立即压缩；第二及后续主请求含摘要且关联真实 operation           | covered / pending-review            | [R6]                            |
| 12  | NCTX-07/25          | 真实维护 SSE 在途用现有 Composer Stop；cancelled、候选无效、原执行费用、原文与 capture 前缀保留                     | covered / pending-review            | [R6]                            |
| 13  | NCTX-07/25          | 相同在途维护关闭 auto；policy-changed、候选无效、费用与原文保留                                                     | covered / pending-review            | [R6]                            |
| 14  | NCTX-07/25          | 相同在途维护保存参数；旧 policy 候选作废，已接收 usage 与原文仍可读                                                 | covered / pending-review            | [R6]                            |
| 15  | NCTX-28/31          | opaque PNG 真实上传/最终发送降采样；image 记录、独立主观察关联、512KiB 原图分块/hash 和 UI 只读预览                 | covered / pending-review            | [R6]                            |
| 16  | NCTX-29/41          | 同 bytes 两张上传；各自 canonical part/ref、来源 message 与响应 anchor 分开，逐图最终 bytes 对账                    | covered / pending-review            | [R6]                            |
| 17  | NCTX-32             | 透明 PNG 的发送副本实际解码仍有 alpha；原图 hash/尺寸不被副本覆盖                                                   | covered / pending-review            | [R6]                            |
| 18  | NCTX-10/19/55       | 原图/来源/记录有界分页、跨任务 ref 拒绝；真实策略更新后旧 revision 页拒绝；零额外 Provider 请求                     | covered / pending-review            | [R6]                            |
| 19  | NCTX-46/47/48       | 实际 input/cache 真 0 与缺 cache/vision 字段分别保留；零分母不显示 0%，known→unknown→known 回放                     | covered / pending-review            | [R6]                            |
| 20  | NCTX-12/36/44/53    | 稳定 old/latest fork；仅前缀数字/图片来源，子 ref 本地化、策略保留，父未来不进入子视图                              | covered / pending-review            | [R6]                            |
| 21  | NCTX-45/56/57       | 三图同范围/选择，真实 SVG 连续与未知缺口、系列切换、键盘、记录定位/返回；桌面四宽度；只读不提交                     | covered / pending-review            | [R6]                            |
| 22  | NCTX-58             | 离线 3000 观察 fixture 经公开 resume；seed/resume 事实前置已到达，分页 envelope 误比 seed 后中止，SVG/点详情未运行  | failing / partial                   | [R6]、[分页修复][ledger-page]   |
| 23  | NCTX-18/26/55       | 唯一手机 Page 配对及 pane 前置；Home/chat 超时，Main view 为 null；在途请求/reload/hide-show未执行                  | failing / partial                   | [R6]、[手机结构证据][R6-mobile] |
| 24  | NCTX-21/23/56       | 手机常规设置/defaults、参数/主题/语言及 system 往返                                                                 | blocked by case 23 / pending-review | [R6]                            |
| 25  | NCTX-58             | 同一手机 Page 的 3000 账本分页/SVG/原始点详情                                                                       | blocked by case 23 / pending-review | [R6]                            |
| 26  | NCTX-28/38/44       | 关闭 auto 后原图 UI 只读；唯一真实 Electron 冷重启，恢复完整 manual 策略、历史数字和原图 hash                       | covered / pending-review            | [R6]                            |
| 27  | NCTX-38/44          | 冷恢复首个真实主请求保留 manual 和四张既有发送副本，原图片观察仍在                                                  | covered / pending-review            | [R6]                            |
| 28  | NCTX-30/42          | 模型实际调用 context_read_image；同 callId ToolPart 与下一 wire 原 PNG bytes/hash/尺寸，一次原图豁免、独立主 usage  | covered / pending-review            | [R6]                            |
| 29  | NCTX-34/40/41/43    | 成功证明后省略、最新真实用户图保护、manual 保持、关闭 omitSeen 与改编码重送；只成功提交才更新旧省略                 | covered / pending-review            | [R6]                            |
| 30  | NCTX-33             | 同 Provider 非 vision 原图回取明确拒绝、零第二次 wire/无成功 receipt；恢复真实模型后新消息成功，不清 restore intent | covered / pending-review            | [R6]                            |
| 31  | NCTX-15/45/48       | 真实深度 compact 建新段；当前主曲线/概览为空，旧数字和维护事件不串入当前段                                          | covered / pending-review            | [R6]                            |
| 32  | NCTX-33             | 在既有 future task 读取超硬预算原 PNG；不再缩原图、不切 Provider、无第二次 wire/成功 receipt；真实新 turn 继续可用  | covered / pending-review            | [R6]                            |

## Accepted 规则与剩余责任

规则接受不等于完整覆盖。本表覆盖 NCTX-01..60 的分组，`partial` 表示只有明确产品子集通过；`source-only` 不提升为产品 covered。

| 场景                         | 已验证产品子集（以注明轮次为准）                                                                                                          | 已有 source / 仍需单独验证                                                                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NCTX-01/03                   | 空态与真实新建 auto 两场 covered / pending-review [R6]                                                                                    | 只按实际创建前后断言登记，不据默认 repository 推断其它创建入口                                                                                                       |
| NCTX-02                      | product missing                                                                                                                           | 无 compact 旧任务首次 manual 与 file-backed 新 owner [L3 3/3][S60]；没有桌面 legacy 冷打开产品场                                                                     |
| NCTX-04/05/06                | 手动/auto 安全点、Read 配对/原文/后续 wire covered 子集 [R6]                                                                              | 全保护 auto/manual 零模型/零费用、同历史无收益 no-repeat [A4 4/4][S60]；不是产品失败，亦不是产品已覆盖                                                               |
| NCTX-07/08/09/22/25          | 三项真实在途中断及费用/原文 covered 子集 [R6]                                                                                             | 最终候选 storage-error/无半写 S1、Goal S9/S10/G1、完整 compact D2 仅 source；新 Core 工具 batch [1/1][core-batch] 单列，Bootstrap 最终 source 2/2 已冻结，分层见下节 |
| NCTX-10/19/28/29/35          | 上传、记录、原图/hash、跨任务 ref 与策略旧页拒绝 covered 子集 [R6]                                                                        | 同 path 跨 Host/identity/remoteSessionId、所有 Read/Bash/MCP/CUA 路径及 Responses 格式不能由 PNG 上传代替；原图/格式 source 见 [S60]                                 |
| NCTX-11                      | 原文引用只追加目标未提交草稿、发送前 owner/request 不变 covered / pending-review [R6]                                                     | 不扩大到整块解压或长期 pin                                                                                                                                           |
| NCTX-12/13/14/15/36/44/53/54 | 稳定 old/latest fork、manual 冷恢复、compact 当前空段 covered 子集 [R6]                                                                   | 长文本第 200 字符后真实新 ID 编辑、跨范围 fork、父并行/删除、回退及 compact 故障在 S4/B11/F5/D2；没有同等桌面操作验收                                                |
| NCTX-16/17/37                | 相同维护模型 happy path、非 vision/硬容量反馈 covered 子集 [R6]                                                                           | A 自动/B 手动/C 在途冻结 7 场所在 9/9 组、真实小窗/不可解析/no fallback S3；携图 Model→Goal→SQLite G1 1/1；不是 Composer A/B/C 产品交互或视觉质量                    |
| NCTX-18/26/55                | 桌面 stale revision/query covered 子集 [R6]；手机普通主请求在途 reload/hide-show、同 Host/CLI 完成观察 covered / pending-review [JJskJz]  | 维护 accepted 后 ACK 丢失/重连/重复命令、双设备旧 policy 冲突和分页迟到旧 owner 无本套产品强断言；普通主请求恢复不替代这些组合                                       |
| NCTX-20/23/24/27/60          | 90 字段/JSON、两作用域保存与草稿、future 默认捕获、导出 covered / pending-review [R6]                                                     | 只证明列出的表单/保存行为，不证明 90 项所有值及全部参数组合；实际消费者见参数实现映射                                                                                |
| NCTX-21/45/56/57             | 桌面四宽度/三图/键盘 covered 子集 [R6]；手机 320/390/736px 触摸联动及参数底栏/主题/中英/system selected 与 reloaded covered 子集 [JJskJz] | 只证明列出的宽度、操作与恢复；macOS、实体触摸及任意设备布局仍人工 pending                                                                                            |
| NCTX-30/33/42                | 模型原字节回取一次、非 vision/硬预算及后续新消息 covered / pending-review [R6]                                                            | UI 预览不授予模型发送豁免；更换 Provider/dialect 不由同 Provider 回放证明                                                                                            |
| NCTX-31/32/38/39             | PNG 降采样/alpha、改码、manual 副本保持 covered 子集 [R6]                                                                                 | 动画保帧、gate/边长与质量下限、entries/MiB 双缓存上限和取消驻留仅编码器 source；主题变化不重编码未专门产品取证                                                       |
| NCTX-34/40/41/43             | 成功 receipt、省略/保护、同 bytes 身份、manual/omitSeen/改码往返 covered 子集 [R6]                                                        | 首次失败/取消/重试、receipt CAS 回滚、换模型证明失效在 S12/R31/R10；负向最终 gate 通过不等于所有首次请求失败组合                                                     |
| NCTX-46/47/48/49/50/51/52/59 | 冻结主用量、真零/未知、图表缺口/记录返回、维护费用、图片实际 bytes covered 子集 [R6]                                                      | 逐 attempt 重试、多级合并摘要、部分未知用量、负收益及实际模型/预算/计数器分段在 S2/S3/S7/S8/U14/V16 等；不把维护 total 当 inputAfter 或字节当 vision token           |
| NCTX-58                      | 桌面与手机 3000 账本 covered / pending-review [0t3rov]；此前通过 [24LYLb]/[9zSF2H] 保留历史身份                                           | source S7 7/7、独立 resume 1/1、seed 8/8、选择 helper 3/3 与页版本 4/4 分层保留；JJskJz 未选该场，不扩大到任意规模、实体手机或 macOS                                 |

## Source 证据与计数边界

[60 项 source 子集与 36 份完结日志索引][S60]保留每组计数、断言、SHA 和历史失败，**不是 60 项完整产品通过**。主要高风险 source 为：L3 旧任务 3/3、A4 全保护/无收益 4/4、S1 最终候选故障 2/2、S2 维护拒绝/取消/作废 12/12、S3 模型冻结 7 场所在组 9/9、S4 长文本/原图 lifetime 2/2、B11 历史边界 11/11、F5 Runtime fork 5/5、D2 完整公开 compact 两类持久故障 2/2；Goal Runtime S9 22/22、receipt/migration S10 16/16、G1 携图 Model→Goal→SQLite 1/1。[正式短稿][source-draft]仅作为分层说明，最终计数以完结日志为准。[新增 source/static 补充索引][source-supplement]单列署名 2/2、分页 4/4、App→MobileShell 13/13、Core 1/1 与 Bootstrap 2/2；旧 36 份日志 SHA 不变，不增加 accepted ID，也不汇总重合/nested 为新产品总数。补充索引中的产品 pending 是生成时快照，产品结果以本表实际轮次为准。

新增 NCTX-09 [Core 实际工具 batch 1/1][core-batch]用默认 scheduler/executor、两个 typed gated ToolEntry 与 file-backed SQLite：两个 running ToolParts 时三次同 commandId 返回唯一 durable preparing；第一结果、第二工具与 final hold 都不触发维护；完整 assistant/step-finish 后唯一维护，history/来源/费用双向关联、原 canonical 不变，终态重放不新增事实。完成屏障只保留生产 drain 的原 Promise，不手动 drain 或加延时。它不证明 Bootstrap ordinary input 的 promotion，亦不是 Desktop/mobile 重复 click。旧 root lint 未保存 argv，另补唯一一次[显式 CLI 配置 3 TS lint](../../.run-logs/project-only-validation/nctx-core-tool-batch-cli-config-lint-pGwphc/core-cli-lint-evidence.md)，94 rules、0/0、四个冻结 SHA 不变；没有重跑 source/strict。

Bootstrap 新 source 最终冻结 continuous/replayable 两场 [2/2](../../.run-logs/project-only-validation/nctx-bootstrap-tool-batch-final-source-mxr0RE/children/source-tests-BG4Uh3/logs/source-tests.log)：实际 public Server→V4.command→CommandInbox，真实工具 batch、manual ACK/duplicate、完整主轮后维护，以及两个普通 queued input 的自动提升/模型/TurnComplete/SQLite promotedSequence FIFO。该组 strict、显式 CLI 配置 5 TS lint、6 目标格式与架构通过；[最终冻结索引](../../.run-logs/project-only-validation/nctx-bootstrap-tool-batch-final-evidence-2DCxEf/children/nctx-bootstrap-tool-batch-freeze-index-xgq4Uq/freeze-evidence-index.md)保留 argv/cwd/SHA/初期 fixture 失败；行为不再重复累计；不与旧 C7、Core 1/1 相加为新的 unique 总数。

[大账本独立恢复索引][ledger-resume]的首次 fresh Runtime 恢复 1/1、seed 8/8、公开选择 helper 3/3 均为 source。canonical seed 与含真实 ContextBuilder/系统前缀/shell 的 resumeExpected 分开，首次精确 1 CAS，再次 fresh owner 0 新 CAS；5940 条 canonical 来源、3000 观察、15 操作及 requestSeq 2970 不变。不是把 status 当 expected，也不允许 revision 0/1 宽松通过。[页版本 source 4/4][ledger-page]另证严格 envelope 与冻结 item 分层；不重写历史数字。

编码器首轮 49/51（两个 fixture 失败）与相关两文件复测 29/29，加其余首轮已通过 22 条，构成 51 条 unique 代表；**没有单次最终 51/51 全组日志，也不相加为 80**。S3 的 9/9 含与 S1 重合的候选 2 场；Q247 为单 projector 247/247，其中新增 native 7 场，其余是既有测试。旧 broad projector 280/281 由该单文件补齐，另五文件 34/34 未重跑，不能改写为 281/281 重新执行。S8 的四 child 10/15/5/5 共 35，15 已含 nested，不重复累加后续 C7。S14 旧 aggregate 20/21 保留当时 Node 24.18 与 search alias 装载失败，后续准确 Node 24.14 独立 5/5 补证，未发现旧全组重新 21/21 的日志；无版本记录的 generic store/fork 不反推 Node。

手机 ChannelRPC/registry、Root callback、Intl TSX/React/JSDOM 与平台/系统语言链的 source 证据保留在[手机冻结索引](../../.run-logs/project-only-validation/native-mobile-shared-root-freeze-20261112.md)、[Intl 索引](../../.run-logs/project-only-validation/native-mobile-intl-owner-final-evidence-20261112.md)和[系统语言链](../../.run-logs/project-only-validation/native-mobile-system-locale-final-evidence-20261112.md)。SettingsSync 只允许 `getFirstRunPromptState`/`markFirstRunPromptHandled`，其它同步/导入仍拒绝，[方法级权限 9/9](../../.run-logs/project-only-validation/nctx-mobile-first-run-capability-green-Cto6Du/logs/validation.log)。已 handled 且无弹窗时 `cancelled=false` 只证明不重复遮挡，不算这一轮执行 Cancel 写入；不为补覆盖重置 owner。

## 尚未由产品证明的高风险组合

即使后续 32 场全部通过，以下子规则仍须单独证据或继续标 source/人工 pending，不能由标题标签自动完成：

- 无字段旧任务在桌面首次冷打开 manual；全部受保护与无收益同历史不重复付费：L3/A4 source 已通过，没有相同桌面产品前置。
- 真正未完成 tool batch 下重复立即压缩及 ordinary FIFO：新 Core/Bootstrap source 分别登记；本套桌面没有 running 工具时重复 UI command 的产品场。
- 候选持久化故障、完整 compact 两故障、新 owner 恢复与 200 字符后编辑/rewind：S1/D2/S4/B11 source 已通过，32 场不注入这些产品故障/编辑操作。
- 自动 A/手动 B/在途 Composer C，以及小窗/不可解析/no fallback：S3 source 已通过；相同模型维护或非 vision 图片失败不能证明 A/B/C UI 冻结。
- Goal 暂停/预算、真实维护计量与 SQLite receipt 原子提交：S9/S10/G1 source 已通过，32 场没有同等产品 Goal 操作。
- 手机维护 accepted ACK 丢失→重连查询/重复命令、双设备旧 policy 保存冲突、native 页请求在途换 owner；本套及 source 60 索引没有相同完整组合的执行证据。普通主请求 reload、桌面 stale revision 和 registry lease source 各只证明自己的子集。
- 同 workspacePath 不同 workspaceIdentity/remoteSessionId 的跨 Host query/来源隔离；PNG 上传的跨任务 ref 拒绝不能证明这个组合。
- 原图所有附件/Read/Bash/MCP/CUA/Responses 路径，动画/未知格式/双缓存上限、首次图片失败/取消/换模型证明失效，以及所有计数器/模型预算分段：保留相应 source 子集，不推广为所有输入格式/平台的产品覆盖。
- macOS 原生、实体手机触摸、真实视觉模型摘要质量、生产远端链路：没有本套产品结果；Windows 设宽度、Chromium touch 模式、回放费用或截图均不能替代。

## 共享环境、回放与准入合同

维护回放只展开本 case 的 `E2E_NCTX_MAINTENANCE` 或 `E2E_NCTX_AUTO_MAINTENANCE`，从真实请求完整 offered ranges 取 refs；有界 JSON/来源/数量严格校验，串用、未知字段、越界拒绝。固定摘要只复述合成事实，最终工具 JSON 只含公开 schema 的 `ranges`，不额外夹带 replay `outputs`。自动场先 manual 播种并确认无维护，完成后真实 UI 开启 auto，以已确认策略为 before；下一请求安全点一次维护，避免前场残留触发错 fixture。

所有 session data、HOME/USERPROFILE/TEMP/TMP/AppData、logs、cache、Chromium profile/downloads 和 fixture 仅在工作树 sandbox，逐级检查链接/重解析点不越界。运行使用现有 Windows 启动链、单 shard、显式 common+case-local fixture；不 Linux/Docker 构建、不安装发布、不访问真实用户 .zcodium。query 经公开 ZCodeAgent/shared strict schema，不直接写 SQLite 伪造在线状态。

observation/record 页为 sequence DESC，首页省略 cursor、后续正整数 nextCursor 递减；source 是从 0 起的递增 offset，不能混用。公开 resume 的模型须用 manifest 证明的 providerId/modelId 经 `formatModelPickerValue` 生成完整选择字符串；裸 modelId 虽是 string，仍缺 Provider，不能猜或 cast。大账本 query envelope 精确对 resumeExpected，冻结 observation/operation item 对 seed，晚到 hash/未来 revision 拒绝。

手机在唯一 Chromium 启动前，沿真实 logo/sidebar 入口展开，等 panel/动画、已绘制入口和中心命中后发真实 WebDriver click，再恢复原侧栏状态；不 JS click/注入 store/隐藏遮挡/固定延时。首启只由真实 Cancel→公开 handled→同 Page reload 完成；无弹窗时如实记录。Home/chat、真实 pane/session、同 Host/CLI、Page Visibility 与 Main mobileTaskView 强断言保留。失败 collector 分段写 surface/Main/有限安全分类，close 前独立尝试 PNG，不吞掉首错误。

主 suite 每场 finally 清理草稿/策略，不吞断言；首轮统一收集后集中修复，有源码改动统一重编译，不边测边改共享环境。手机只复用桌面 attachment，不另起 Agent；desktop-continuous 和 web-remote-replayable 分别验收。冷重启只在兼容场景后一次：Provider/relay 不重起，先 flush/旧进程退出，再同 HOME/profile 恢复原图、策略和数字。

## 静态检查与历史待审材料

交付源码静态检查已完成，均为 Node 24.14.0、工作树 sandbox 的实际执行；本次仅更新验收文档及 SQL 末尾空白，不重复已通过的源码/产品测试。

| 最终检查               | 实际结果                                      | 日志                            |
| ---------------------- | --------------------------------------------- | ------------------------------- |
| 根 typecheck           | exit 0                                        | [GOPAY9][delivery-typecheck]    |
| 根 lint                | 5836 files，0 warnings / 0 errors，exit 0     | [ecRqBr][delivery-lint]         |
| changed architecture   | violations/baseline/new 均 0，exit 0          | [cexP7f][delivery-architecture] |
| Desktop typecheck:e2e  | exit 0                                        | [I3BErJ][delivery-e2e-types]    |
| 10 个改动目标格式检查  | exit 0                                        | [xSg8rZ][delivery-format]       |
| freshness 唯一网络重试 | main 与 origin/main ahead/behind 均 0，exit 0 | [gOKldp][delivery-freshness]    |

完整 CLI lint 的最新已执行结果仍为 **75 warnings / 88 errors、exit 1**，见下方 R7 日志和分类。88 项 max-lines 均在 HEAD 已存在，新越界 0；59 未改、29 本地改，warning 未完整归因。根 lint 通过不替代 CLI 全量通过，未以通过为由修改规则或无关代码。文档格式/本地链接与最终 `git diff --check` 另在交付索引登记；没有提交、推送或打包。

第七轮前最终门禁已经完结：[根 typecheck](../../.run-logs/project-only-validation/nctx-r7-root-typecheck-7sCo8o/logs/validation.log)、[根 lint](../../.run-logs/project-only-validation/nctx-r7-root-lint-i6VjNT/logs/validation.log)、[完整 E2E strict](../../.run-logs/project-only-validation/nctx-r7-full-e2e-types-huJcZ9/logs/validation.log)和[changed 架构](../../.run-logs/project-only-validation/nctx-r7-root-architecture-9zteU9/logs/validation.log)均 exit 0；根 lint 5827 文件、0/0。[完整 CLI 本配置 lint](../../.run-logs/project-only-validation/nctx-r7-full-cli-lint-EypQjw/logs/validation.log)仍 exit 1：1808 文件、75 warnings/88 errors。[R7 分类索引](../../.run-logs/project-only-validation/nctx-r7-cli-lint-classify-fixed-9Sxr3j/children/nctx-r7-cli-lint-evidence-zRO5hP/cli-lint-evidence.md)验证 88 个失败文件 SHA/计数与 R5 的实际 HEAD 分类一致（59 未改、29 本地改、新越界 0）；复用已有 HEAD lint，不再跑 88 文件。初次分类脚本正则语法错误另留证，不算 lint 或生产红例。该静态结果不预填第七轮产品通过。

第六轮前[完整根 typecheck](../../.run-logs/project-only-validation/nctx-r6-root-typecheck-9OG5Ol/logs/validation.log)、[完整 E2E noEmit](../../.run-logs/project-only-validation/nctx-r6-full-e2e-types-ZBuKB8/logs/validation.log)及[根 lint](../../.run-logs/project-only-validation/nctx-r6-root-lint-vwxxDv/logs/validation.log)实际通过；根 lint 为 5824 文件、0 warnings/0 errors。已保存的第五轮 [CLI 全入口 lint](../../.run-logs/project-only-validation/nctx-round5-final-cli-lint-WsMFZY/logs/validation.log)仍 exit 1（1808 文件、75 warnings/88 errors），不能用根 lint 替代。其 [HEAD 分类](../../.run-logs/project-only-validation/nctx-r5-cli-lint-classify-t9wbyy/children/nctx-r5-cli-lint-classification-f572zV/artifacts/cli-lint-classification.md)与[签名/行数增量](../../.run-logs/project-only-validation/native-r4-cli-final-log-classification-IkQgnu/children/cli-lint-final-classification-98Hwa0/classification.md)保留旧超限及修改后的计数变化；全 lint 仍失败，不把相同错误数写成全部与本轮无关。后续门禁按新的实际日志追加。

初期 17 场 [静态结果](../../.run-logs/project-only-validation/native-context-e2e-static-vwrt54/results.json)、追加 auto 后 18 场 [静态结果](../../.run-logs/project-only-validation/native-context-e2e-static-VZDGpp/results.json)、52/61 项维护解析及早期 fixture 计数都是当时源码快照，不能冒充后来 32 场已完整通过。所有候选、人审、真实 API、macOS/实体触摸与正式 CI admission 继续按上文边界登记；没有因 source 通过执行 promotion。

[R1]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-zE3aVx/artifacts/summary.md
[R2]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-X6iFbn/artifacts/summary.md
[R3]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-GvVZ0R/artifacts/summary.md
[R4]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-d6v88K/artifacts/summary.md
[R5]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-wQ9PfS/artifacts/summary.md
[R6]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-kU95iV/artifacts/summary.md
[R6-results]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-kU95iV/artifacts/test-results.ndjson
[R6-cases]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-kU95iV/home/ZCodeProject/.zcode-e2e/conversation-session-native-context-compression/evidence/case-results.json
[R6-mobile]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-kU95iV/home/ZCodeProject/.zcode-e2e/conversation-session-native-context-compression/evidence/mobile/native-view-evidence.jsonl
[S60]: ../../.run-logs/project-only-validation/nctx-final-source-evidence-audit-final-Ab3M7L/children/nctx-final-source-evidence-index-BTGRnv/source-evidence-index.md
[source-draft]: ../../.run-logs/project-only-validation/nctx-formal-docs-source-draft-NZxetr/children/nctx-formal-docs-source-draft-odEazW/formal-docs-source-draft.md
[core-batch]: ../../.run-logs/project-only-validation/nctx-core-tool-batch-final-evidence-aHaiJd/fixtures/nctx-core-tool-batch-evidence-G02sbX/evidence.json
[ledger-resume]: ../../.run-logs/project-only-validation/nctx-ledger-resume-final-evidence-GC4ISX/ledger-resume-evidence.json
[ledger-page]: ../../.run-logs/project-only-validation/nctx-r7-ledger-page-freeze-4bgp3g/children/nctx-r7-ledger-page-freeze-index-Hz3Iqe/freeze-index.md
[R7]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-FzMwnE/artifacts/summary.md
[R7-results]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-FzMwnE/artifacts/test-results.ndjson
[source-supplement]: ../../.run-logs/project-only-validation/nctx-source-supplement-index-final-1W6hom/children/nctx-source-supplement-index-bTzqXt/source-supplement-index.md
[R8-partial]: ../../.run-logs/project-only-validation/nctx-r8-partial-evidence-D8t7HP/round8-partial-evidence.md
[R8-results]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-ZkX0pP/artifacts/test-results.ndjson
[R9]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-4UncAx/artifacts/summary.md
[R9-results]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-4UncAx/artifacts/test-results.ndjson
[R9-build]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-4UncAx/artifacts/build-source-evidence.json
[R9-selection]: ../../.run-logs/project-only-validation/nctx-focus-selection-XcyD0j/selection.json
[gvELa2]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-gvELa2/artifacts/summary.md
[gvELa2-results]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-gvELa2/artifacts/test-results.ndjson
[gvELa2-exit]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-gvELa2/completion.json
[gvELa2-build]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-gvELa2/artifacts/build-source-evidence.json
[GOGcoE]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-GOGcoE/artifacts/summary.md
[GOGcoE-results]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-GOGcoE/artifacts/test-results.ndjson
[GOGcoE-exit]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-GOGcoE/completion.json
[GOGcoE-build]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-GOGcoE/artifacts/build-source-evidence.json
[main-watch]: ../../.run-logs/project-only-validation/native-context-main-watch-S8WVRB/events.jsonl
[s0tiym]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-s0tiym/artifacts/summary.md
[s0tiym-results]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-s0tiym/artifacts/test-results.ndjson
[s0tiym-cases]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-s0tiym/home/ZCodeProject/.zcode-e2e/conversation-session-native-context-compression/evidence/case-results.json
[s0tiym-exit]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-s0tiym/completion.json
[s0tiym-gui]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-s0tiym/children/native-context-live-diagnostic-pZG2Dd/gui-events.jsonl
[2rd4y7]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-2rd4y7/artifacts/summary.md
[2rd4y7-results]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-2rd4y7/artifacts/test-results.ndjson
[2rd4y7-cases]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-2rd4y7/home/ZCodeProject/.zcode-e2e/conversation-session-native-context-compression/evidence/case-results.json
[2rd4y7-exit]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-2rd4y7/completion.json
[PEXPbP]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-PEXPbP/artifacts/summary.md
[PEXPbP-results]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-PEXPbP/artifacts/test-results.ndjson
[PEXPbP-cases]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-PEXPbP/home/ZCodeProject/.zcode-e2e/conversation-session-native-context-compression/evidence/case-results.json
[PEXPbP-exit]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-PEXPbP/completion.json
[PEXPbP-inspector]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-PEXPbP/children/native-context-live-diagnostic-4KughU/inspector-events.jsonl
[native-dialog-stack]: ../../.run-logs/project-only-validation/native-context-stack-Eqzb9p/stack.jsonl
[nativeimage-probe]: ../../.run-logs/project-only-validation/nctx-nativeimage-probe-P4RzZm/nativeimage-results.json
[tray-regression]: ../specs/windows-ui-regressions.md
[tray-source-index]: ../../.run-logs/project-only-validation/nctx-tray-image-final-evidence-75ELjv/children/windows-ui-tray-image-index-xNynkH/freeze-index.md
[tray-staging]: ../../.run-logs/project-only-validation/nctx-tray-staging-final-T4mNQM/logs/validation.log
[24LYLb]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-24LYLb/artifacts/summary.md
[24LYLb-results]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-24LYLb/artifacts/test-results.ndjson
[24LYLb-cases]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-24LYLb/home/ZCodeProject/.zcode-e2e/conversation-session-native-context-compression/evidence/case-results.json
[24LYLb-exit]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-24LYLb/completion.json
[24LYLb-build]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-24LYLb/artifacts/build-source-evidence.json
[24LYLb-mobile]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-24LYLb/home/ZCodeProject/.zcode-e2e/conversation-session-native-context-compression/evidence/mobile/native-view-evidence.jsonl
[24LYLb-log]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-24LYLb/logs/e2e.log
[page-serialization]: ../../.run-logs/project-only-validation/nctx-page-serialization-final-evidence-XiQ5RI/freeze-index.md
[mobile-close-source]: ../../.run-logs/project-only-validation/nctx-mobile-close-source-green-i8erCG/logs/validation.log
[build-reuse-before]: ../../.run-logs/project-only-validation/nctx-build-reuse-proof-Bht9DK/reuse-proof.json
[build-reuse-during]: ../../.run-logs/project-only-validation/nctx-build-reuse-proof-0uIVhF/reuse-proof.json
[9zSF2H-run]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-9zSF2H/logs/e2e.log
[9zSF2H]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-9zSF2H/artifacts/summary.md
[9zSF2H-results]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-9zSF2H/artifacts/test-results.ndjson
[9zSF2H-cases]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-9zSF2H/home/ZCodeProject/.zcode-e2e/conversation-session-native-context-compression/evidence/case-results.json
[9zSF2H-exit]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-9zSF2H/completion.json
[9zSF2H-ledger-mobile]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-9zSF2H/home/ZCodeProject/.zcode-e2e/conversation-session-native-context-compression/evidence/large-ledger-mobile.json
[9zSF2H-settings-failure]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-9zSF2H/home/ZCodeProject/.zcode-e2e/conversation-session-native-context-compression/evidence/native-settings-mobile-failure.png
[l1tS3u]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-l1tS3u/artifacts/summary.md
[0t3rov]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-0t3rov/artifacts/summary.md
[5bDGL4]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-5bDGL4/artifacts/summary.md
[JJskJz]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-JJskJz/artifacts/summary.md
[JJskJz-results]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-JJskJz/artifacts/test-results.ndjson
[JJskJz-exit]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-JJskJz/completion.json
[touch-320]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-0t3rov/home/ZCodeProject/.zcode-e2e/conversation-session-native-context-compression/evidence/native-context-mobile-touch-320.json
[touch-390]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-0t3rov/home/ZCodeProject/.zcode-e2e/conversation-session-native-context-compression/evidence/native-context-mobile-touch-390.json
[touch-736]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-0t3rov/home/ZCodeProject/.zcode-e2e/conversation-session-native-context-compression/evidence/native-context-mobile-touch-736.json
[ledger-0t-desktop]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-0t3rov/home/ZCodeProject/.zcode-e2e/conversation-session-native-context-compression/evidence/large-ledger-desktop.json
[ledger-0t-mobile]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-0t3rov/home/ZCodeProject/.zcode-e2e/conversation-session-native-context-compression/evidence/large-ledger-mobile.json
[pointer-source]: ../../.run-logs/project-only-validation/nctx-trend-pointer-and-pages-green-oIfuJJ/freeze-index.md
[home-source]: ../../.run-logs/project-only-validation/nctx-mobile-home-ready-source-green-CVbnnQ/freeze-index.md
[build-0t]: ../../.run-logs/project-only-validation/native-context-desktop-e2e-0t3rov/artifacts/build-source-evidence.json
[reuse-0t-before]: ../../.run-logs/project-only-validation/nctx-build-reuse-proof-F4ZaUX/reuse-proof.json
[reuse-0t-between]: ../../.run-logs/project-only-validation/nctx-build-reuse-proof-MGzRqy/reuse-proof.json
[reuse-0t-during]: ../../.run-logs/project-only-validation/nctx-build-reuse-proof-DiNreR/reuse-proof.json
[reuse-0t-after]: ../../.run-logs/project-only-validation/nctx-build-reuse-proof-bBNCKz/reuse-proof.json
[delivery-typecheck]: ../../.run-logs/project-only-validation/nctx-delivery-root-typecheck-GOPAY9/logs/validation.log
[delivery-lint]: ../../.run-logs/project-only-validation/nctx-delivery-root-lint-ecRqBr/logs/validation.log
[delivery-architecture]: ../../.run-logs/project-only-validation/nctx-delivery-architecture-cexP7f/logs/validation.log
[delivery-e2e-types]: ../../.run-logs/project-only-validation/nctx-delivery-desktop-e2e-types-I3BErJ/logs/validation.log
[delivery-format]: ../../.run-logs/project-only-validation/nctx-delivery-target-format-xSg8rZ/logs/validation.log
[delivery-freshness]: ../../.run-logs/project-only-validation/nctx-delivery-freshness-retry-gOKldp/logs/validation.log
