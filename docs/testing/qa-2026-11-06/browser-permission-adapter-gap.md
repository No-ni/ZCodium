# BUG-005 Desktop 权限 adapter 接线缺口

`qa-fix-20261107-browser-retry` 实际结束于 `2026-11-06T21:45:54.768Z`，exit 1，2 用例均失败。该现场的 Main 权限策略已让未授权 guest 查询得到 `denied`，站点设置和产品气泡的 renderer 接线仍缺失。初始调查只读源码、已有日志和截图；先补 [治理 spec](../../browser-use/2026-10-08-embedded-browser-permission-governance-spec.md) 六接口、状态所有者与事件顺序，随后获准补线并完成真实源守卫红绿。本文保留补线前失败，末节记录修复、源守卫及根任务执行的真实 UI 复验；本调查 agent 未启动应用或构建，只读复核复验结果。

## 已确认的路径与停点

- canonical 用例先通过 geolocation 默认 `denied`、真实滑杆入口及独立设置标签页；日志 `21:44:28.915Z` 返回容器存在，`21:44:28.920Z` 返回正确合成 origin。随后在 `browser-permission-site-settings.test.ts:91` 找不到 `site-permission-setting-geolocation`，允许、保存及重置均未抵达。[原日志](logs/e2e-qa-fix-20261107-browser-retry.log)、[原用例](../../../packages/desktop/test/e2e/browser-permission/browser-permission-site-settings.test.ts)、[结果 NDJSON](runtime/qa-fix-20261107-browser-retry/evidence/test-results.ndjson)。
- BPF01 的请求前查询为 geolocation/notifications=`denied`，result=`null`。页面已真实挂载；`qa-browser-permission-bugfix-20261107.test.ts:108` 等待产品气泡超时，尚未点击拒绝或发起第二次请求。[请求前 JSON](runtime/qa-fix-20261107-browser-retry/evidence/bug005-prompt-16644-1794001521648/01-default-denied.json)、[请求前截图](runtime/qa-fix-20261107-browser-retry/evidence/bug005-prompt-16644-1794001521648/01-default-denied.png)、[原 pending 用例](../../../packages/desktop/test/e2e/manual-review/pending/qa-browser-permission-bugfix-20261107.test.ts)。该截图是发起通知请求之前的页面，不能当作请求后无气泡的截图。
- [summary](runtime/qa-fix-20261107-browser-retry/evidence/summary.json) 与 NDJSON 一致：2 实际、0 PASS、2 FAIL。原证据保留；默认拒绝通过的步骤不等于整项权限功能通过。

## 六个既有接口缺在平台与 preload

接口已在 [IPlatformService](../../../packages/shared/src/platform.ts) 第 1057–1079 行与 [client globals](../../../packages/client/src/globals.d.ts) 第 175–193 行声明。

| 接口 | Main 已有 channel / 操作 | renderer/preload 应有委托 |
| --- | --- | --- |
| `getEmbeddedBrowserSitePermissions()` | `GetEmbeddedBrowserSitePermissions` | 无载荷 `invoke`，返回实际快照 Promise |
| `setEmbeddedBrowserSitePermission(request)` | `SetEmbeddedBrowserSitePermission` | 原样传 `origin/permission/state` 并返回实际 Promise |
| `clearEmbeddedBrowserSitePermissions()` | `ClearEmbeddedBrowserSitePermissions` | 无载荷 `invoke`，不新增清理入口 |
| `resetEmbeddedBrowserSitePermission({ origin })` | `ResetEmbeddedBrowserSitePermission` | 精确单站点载荷 `invoke` |
| `onEmbeddedBrowserPermissionPrompt(handler)` | `EmbeddedBrowserPermissionPrompt` | `on` 转交事件；disposer 移除同一函数 |
| `resolveEmbeddedBrowserPermissionPrompt(request)` | `EmbeddedBrowserPermissionResolve` | `send`，不使用 `invoke`；Main listener 保留宿主 sender 校验 |

可证源码链：

1. [desktopPlatform.ts](../../../packages/desktop/src/renderer/src/desktopPlatform.ts) 第 114 行合并现有 browser adapter；[desktopBrowserPlatformBridge.ts](../../../packages/desktop/src/renderer/src/desktopBrowserPlatformBridge.ts) 第 3–26 行 Pick 和第 30–80 行对象均无上述六方法。现有旁路只提供浏览器生命周期、导入与清空浏览器数据，不含站点权限。
2. [宿主 preload/index.ts](../../../packages/desktop/src/preload/index.ts) 有既有 `onOpenBrowserUrl`（第 395 行）和浏览器数据 `invoke`（第 675–679 行），没有这六方法及它们的 `invoke/on/send`。因此仅在 renderer 加方法仍不能完成链路。
3. [useBrowserSitePermissions.ts](../../../packages/ui/src/hooks/useBrowserSitePermissions.ts) 第 22–24 行要求 get/set/reset 三能力都存在；当前为 false。[BrowserSitePermissionsPage.tsx](../../../packages/ui/src/browser-use/BrowserSitePermissionsPage.tsx) 第 35–36 行仅渲染 unsupported，权限目录与第 77 行 geolocation testid 不会出现。此为产品能力接线缺口，不是旧 selector。
4. [EmbeddedBrowserPermissionPrompts.tsx](../../../packages/ui/src/browser-use/EmbeddedBrowserPermissionPrompts.tsx) 第 125 行可选订阅缺方法，第 134 行 resolve 也缺方法；即使 Main 已发送事件，事件也不能进入既有 renderer store 或返回用户决定。
5. Main 数据处理器已经接入：[desktopMainIpcPlatform.ts](../../../packages/desktop/src/main/desktopMainIpcPlatform.ts) 调用 browser IPC 装配，[desktopBrowserViewIpc.ts](../../../packages/desktop/src/main/desktopBrowserViewIpc.ts) 第 269 行调用 `registerBrowserDataIpcHandlers`；[desktopBrowserDataIpc.ts](../../../packages/desktop/src/main/desktopBrowserDataIpc.ts) 第 35/38/61/66 行注册四数据 handler。无需重复注册。
6. [Main bridge](../../../packages/desktop/src/main/embeddedBrowserPermissionUiBridge.ts) 第 122 行向实际宿主发送申请，第 259–271 行注册 resolve listener 并校验 `event.sender.id === request.hostWebContentsId`。[Main index](../../../packages/desktop/src/main/index.ts) 已在 await 策略装配后才允许创建主窗口；本补线不改这一入口或添加授权 owner。

## 通知请求未证明的部分

当前 loopback 页面是受控 HTML，无远端资源；BPF01 先真实点击 guest，再以 `void Notification.requestPermission().then(...)` 发起，避免等待权限 Promise 而阻塞产品点击。guest 只用专用 preload；[embeddedBrowserJavaScriptDialog.ts](../../../packages/desktop/src/preload/embeddedBrowserJavaScriptDialog.ts) 第 123–142 行 wrapper 调用真实 `nativeRequestPermission.call(Notification)` 并回写结果，不伪造 Main 授权。

原证据仅保存请求前状态，未保存请求后的 Promise result、user activation、Main request handler 进入次数或 host/guest ID。原诊断日志无可关联的通知决策事件，不能据此证明 Main 没收到请求。已确认的缺订阅足以解释气泡不可达；下一轮用真实产品气泡及页面结果证明请求经过 Main、正确宿主回执和第二次询问，不新增权限请求诊断采集。保持原查询和交互断言；不改默认拒绝，不放宽 timeout，不调用真实通知、位置、摄像头、设备或屏幕共享。

## 最窄修复与回归计划

解除冻结后仅修改现有 `desktopBrowserPlatformBridge.ts` 与宿主 `preload/index.ts`，并新增独占 [真实源回归守卫](../../../scripts/ci/embedded-browser-permission-adapter.test.mjs)。治理 spec 已先行；遵循既有 shared channel/types，不修改 UI、store、Main 装配或 runner。

- adapter 扩展现有 Pick 与对象，六方法按对应 `window.zcode` 能力条件暴露；旧 preload 无能力时保持 `undefined`，不返回空成功、空快照或空 disposer。权限记录仍由 Main manager 唯一持有。
- preload 只补已有 `contextBridge` 对象的六个 typed 方法：四 `invoke`、一事件订阅/精确注销、一 `send`。载荷、Promise 拒绝、宿主 sender 边界原样保留；不暴露 `ipcRenderer` 或新全局，不新增缓存，不记录原文错误/站点/路径。
- 守卫用 TypeScript AST 从实际源码抽取现有 adapter 对象及 preload 的这六属性，转译后在隔离 VM 用受控 `window.zcode`/`ipcRenderer` 执行。红阶段应因真实缺属性失败；绿阶段验证六接口、四数据 Promise 的快照与拒绝透传、resolve 精确 channel/载荷、prompt 订阅和相同 listener 注销、旧 preload 能力缺失。不把复制的 mock 实现当生产回归。
- 使用根任务已审的本树隔离 validation runner 写独占红/绿日志；源码类型/Lint/architecture 门禁由根任务统一执行并记录真实结果。UI 仍由根任务用 fresh 独占 run、项目 bootstrap、显式有限 common replay 串行运行原 canonical+BPF01，不运行 camera prompt canonical。

补线前冻结时 SHA256（小写，保留原现场）：

| 文件 | SHA256 |
| --- | --- |
| `desktopBrowserPlatformBridge.ts` | `067875616aa888213bd33e7d71d700aa75e7a5d2a64ee8761bb34eb6adfe67ff` |
| `desktopPlatform.ts` | `1f637e8e004822eeb196938b1caaebc4c5efd1178afc82372913154d5143bde8` |
| 宿主 `preload/index.ts` | `8f61b3b7afa4e32267bd2efa99b36b69d7b75cf5ef2591201330b2c1eff9fcf0` |
| `useBrowserSitePermissions.ts` | `75d84af4d726b95d0d7cd166b1977514dc56d1644122b5857724cfc349ff0faa` |
| BPF01 pending | `b525750563933090f1a103f13935a6524fdf1f5219326af9d5ab7bb73844d9b3` |

## 补线与源守卫实际结果

安全环境沿用已审 `run-fix-validation.mjs`：固定 Node `24.18.0`、corepack pnpm `10.33.2`，HOME/TEMP/data/cache 均在本树 `.run-logs/qa-2026-11-06/validation`，禁用 cache 网络和包管理器自动管理；新增 alias 均先确认没有旧日志，不覆盖原 final 证据。

| 验证 | 实际结果 | 证据 |
| --- | --- | --- |
| `architecture-check`，修改前基线 | exit 0；violations/baseline/new 均 0 | [log](logs/fix-20261107/validation-architecture-check.log)、[JSON](logs/fix-20261107/validation-architecture-check.json) |
| `architecture-context embedded-browser-permission` | exit 0，读取 Main 现有 managed adapters 契约；改动文件仍属于存量 desktop，未新增 packages 源文件或更改模块覆盖 | [log](logs/fix-20261107/validation-architecture-context.log)、[JSON](logs/fix-20261107/validation-architecture-context.json) |
| 实际源守卫红阶段，`21:56:40.710Z`–`21:56:41.288Z` | exit 1；9 实际 = 2 PASS / 7 FAIL / 0 SKIP；六个实际 preload 方法均缺属性，另只读能力委托缺失 | [log](logs/fix-20261107/validation-tests-browser-permission-adapter-red-20261107.log)、[JSON](logs/fix-20261107/validation-tests-browser-permission-adapter-red-20261107.json) |
| 同组绿阶段，`21:57:35.715Z`–`21:57:36.448Z` | exit 0；9 PASS / 0 FAIL / 0 SKIP | [log](logs/fix-20261107/validation-tests-browser-permission-adapter-green-20261107.log)、[JSON](logs/fix-20261107/validation-tests-browser-permission-adapter-green-20261107.json) |

两阶段都是 `node --test --test-concurrency=1 scripts/ci/embedded-browser-permission-adapter.test.mjs scripts/ci/embedded-browser-permission-startup.test.mjs`；新增守卫为 8 唯一 test，既有 startup 为 1 test。直接 AST 抽取实际 adapter 对象和实际 preload 属性，在 VM 中只替换 `window.zcode` 与 Electron IPC 副作用；未加载 Electron、启动子应用、读取真实 profile 或发网络请求。四数据调用保持实际 Promise 和拒绝、prompt 只转交载荷且移除同一 listener、resolve 使用原 `send` channel、旧能力保持 undefined 均已通过。定向 `git diff --check` exit 0。

补线后源码已冻结，SHA256：

| 文件 | SHA256 |
| --- | --- |
| `desktopBrowserPlatformBridge.ts` | `d0067d39cc80c01f7de33f1db5a3f8af9524415f03332bd1cf9ec3fd345f008a` |
| 宿主 `preload/index.ts` | `6ee5ab8482a193f18e263aaf102f29d9f195c4fc2a26f4f3009c52fff0da7ad4` |
| `embedded-browser-permission-adapter.test.mjs` | `91d200e62363a7643e40267a58795c2a34c667ea2ebe47b6bb0f55ae511323f8` |

最终 typecheck/Lint/architecture 与 fresh UI 由根任务统一执行，该源守卫阶段不预记 PASS。源守卫不替代真实产品气泡/站点设置；多窗口、设备、屏幕、macOS 权限与重启持久化未在本补线中执行。

## 冻结后的通知与 guest 契约只读复核

根任务启动新的 `qa-fix-20261107-browser-adapter` 后，本节先只记录源码与已安装 API 类型的检查，没有预记该 run 或 BPF01 通过；源码、测试及 runner 保持冻结。随后实际结果独立记于末节。

- [BPF01](../../../packages/desktop/test/e2e/manual-review/pending/qa-browser-permission-bugfix-20261107.test.ts) 第 40–56 行从可见 webview 的 `getWebContentsId()` 获取实际 guest，随后用 `webContents.fromId(id)` 执行。第 107 行的末表达式为 `void Notification.requestPermission().then(...)`，即时结果是 `undefined`；`executeJavaScript` 不等待该权限 Promise，产品气泡可以由下一步真实点击处理。页面没有 `new Notification`、位置采集、媒体、设备或屏幕 API；本例验证授权决定而不触发真实通知显示。
- [权限策略](../../../packages/desktop/src/main/embeddedBrowserPermissionPolicy.ts) 第 160–161 行使用 `guest.hostWebContents?.id ?? guest.id` 与实际 guest ID；[Main bridge](../../../packages/desktop/src/main/embeddedBrowserPermissionUiBridge.ts) 第 122 行发送到该宿主，第 153 行将待决请求绑定宿主，第 265 行只接受该宿主的 sender。已有 adapter/preload 补线将同一事件送入既有 UI，未增加授权状态所有者。
- [UnifiedBrowserView](../../../packages/ui/src/browser-use/UnifiedBrowserView.tsx) 第 139–146 行在 attach/ready 后读取同一 guest ID，第 1118–1119 行仅为可见页挂载提示；[提示组件](../../../packages/ui/src/browser-use/EmbeddedBrowserPermissionPrompts.tsx) 第 140–145 行以 `prompt.guestWebContentsId === guestWebContentsId` 过滤归属。因此同窗、同一可见且已 ready 的 guest 静态路由一致；此次只读检查不代替实际事件抵达证据。
- 本树 hoisted [Electron package](../../../node_modules/electron/package.json) 版本是 `44.7.0`；[已安装声明](../../../node_modules/electron/electron.d.ts) 第 13588–13605 行要求同时安装 check/request handler，第 18956–18963 行规定 `hostWebContents` 为所有者且 ID 全应用唯一。这是已安装依赖/API 的版本，未由本节读取实际运行二进制版本，不能将历史源码注释里的 Electron 41 当作本次运行版本。
- 具体测试条件风险：BPF01 第 55 行未传 `executeJavaScript(code, userGesture)` 的第二参数，先前 guest 点击与请求之间还有权限查询和截图，第二次拒绝点击位于宿主。已安装声明第 18286–18297 行只说明某些 HTML API 的用户手势限制；它没有规定通知 API 必须如此，也没有证明本例缺瞬态激活。保留这一未证条件，不放宽气泡/页面结果断言，不增加诊断权限请求。下一轮真实产品气泡、拒绝后页面 `denied` 及第二次气泡的步骤证据即可验证 Main 请求与回执链。

## 补线后的真实 UI 复验

根任务执行的 `qa-fix-20261107-browser-adapter` 在 [summary](runtime/qa-fix-20261107-browser-adapter/evidence/summary.json) 记录 `completedAt=2026-11-06T22:06:57.843Z`、`exitCode=0`，2 实际 = 2 PASS / 0 FAIL / 0 SKIP；[NDJSON](runtime/qa-fix-20261107-browser-adapter/evidence/test-results.ndjson) 与 [完整运行日志](logs/e2e-qa-fix-20261107-browser-adapter.log) 一致。根任务随后确认外层 wrapper session `7965` 完整 exit 0。该结果来自冻结源码的 fresh 构建及独占合成 HOME，未覆盖旧失败证据。

- canonical 站点设置于 `22:05:52.413Z` 实际通过：滑杆入口、权限目录、允许后立即生效、单站点重置及默认拒绝均抵达。此前缺失的 get/set/reset 能力与 geolocation 控件已跨过；未扩大为重启后的持久化验证。
- BPF01 于 `22:06:49.329Z` 实际通过。请求前 [01 JSON](runtime/qa-fix-20261107-browser-adapter/evidence/bug005-prompt-30540-1794002794609/01-default-denied.json) 为两权限 `denied`、result=`null`；[第一次气泡](runtime/qa-fix-20261107-browser-adapter/evidence/bug005-prompt-30540-1794002794609/02-prompt.png) 与 [第二次气泡](runtime/qa-fix-20261107-browser-adapter/evidence/bug005-prompt-30540-1794002794609/03-prompt.png) 均只读视觉确认显示真实通知权限气泡及“不允许”按钮。两个 pending 时刻的 [02 JSON](runtime/qa-fix-20261107-browser-adapter/evidence/bug005-prompt-30540-1794002794609/02-prompt.json)、[03 JSON](runtime/qa-fix-20261107-browser-adapter/evidence/bug005-prompt-30540-1794002794609/03-prompt.json) result 仍为 `null`；每次均经真实点击拒绝并等待页面结果。
- 第二次拒绝后的 [04 JSON](runtime/qa-fix-20261107-browser-adapter/evidence/bug005-prompt-30540-1794002794609/04-denied-after-second-request.json) 为 result=`denied`，geolocation/notifications 仍为 `denied`；[04 最终截图](runtime/qa-fix-20261107-browser-adapter/evidence/bug005-prompt-30540-1794002794609/04-denied-after-second-request.png) 保存拒绝后页面。由真实两次气泡与拒绝后页面结果可验证 Main→实际宿主 UI→同宿主回执→guest 的链路；没有增加诊断申请或伪造权限状态。

本次 Windows 实际场景未被省略显式 `userGesture` 参数阻断；上述 API 条件检查不作为当前失败原因。没有采集瞬态用户激活，因此不对其它站点或平台的通知条件作推断。真实通知显示、真实位置/媒体/设备/屏幕、多窗口、macOS 和重启持久化仍未执行；最终全仓门禁结果由根任务与 validation 统一报告。源码和测试继续冻结。
