# Browser站点权限默认状态：首次现场与装配源链

状态：**两次独立真实guest query与源码装配断链已确认，登记BUG-005/P1**。只读调查，没有修改产品、权限policy或helper；UI由root唯一执行。本记录不宣称页面已经获得位置、摄像头、麦克风或其它实际敏感数据。

## 首次实际失败

`qa-menu-20261106-browser`的`browser-permission-site-settings.test.ts`于2026-11-06T17:37:37.759Z在第64行失败：`navigator.permissions.query({name:'geolocation'})`期望`denied`，实际`granted`。见 [实际NDJSON](../runtime/qa-menu-20261106-browser/evidence/test-results.ndjson)和 [原始log](e2e-qa-menu-20261106-browser.log)。此前页面导航/标题等待完成；该case在站点信息气泡、权限设置页、允许/重置操作之前停止，不能称这些后续动作失败。

页面是spec自己绑定127.0.0.1随机端口的合成HTML，脚本仅调用`navigator.permissions.query`。`readBrowserGuestWebContentsId`第146–163行从实际可见webview取得guest id，`runInGuest`第166–181行由Main的`electron.webContents.fromId`对该guest执行脚本，没有mock query返回值。没有调用`getCurrentPosition`、设备访问或外部站点。

## 当前源码装配

- `packages/ui/src/browser-use/BrowserViewportSurface.tsx:148`真实webview使用`partition="persist:zcode-embedded-browser"`；`packages/desktop/src/main/browserDataManager.ts:33`定义相同partition。
- `packages/desktop/src/main/index.ts:1745–1747`只向该partition安装Browser恢复bootstrap协议。`desktopNetworkPolicy.ts:54–95`为它配置代理/证书，未注册权限request/check。
- `embeddedBrowserPermissionPolicy.ts:128`定义policy；第154行注册request handler，第242行注册check handler；geolocation位于PROMPT_PERMISSIONS，默认check只对持久allow或sessionAllow返回true，否则false。设计注释明确无handler会让Electron默认批准，敏感权限应交给产品用户决策。
- 当前全`packages`源码检索（`.ts/.tsx`，排除out/test）中，`applyEmbeddedBrowserPermissionPolicy`仅有定义及type/contract示例；`createEmbeddedBrowserPermissionUiBridge`、`createEmbeddedBrowserSitePermissionStore`同样仅定义，没有实际创建/装配调用。`packages/desktop/src`的`setPermissionRequestHandler`/`setPermissionCheckHandler`只出现在本policy和独立pluginSandbox session；后者是不同partition，不能保护Browser guest。
- 本case所用`prepareV4ConversationE2E({skipProvider:true})`、Browser side-pane helper及`wdio.conf.ts`检索没有权限handler/geolocation mock或注入。没有将确定性policy mock单测通过扩认生产启动装配成功。

以上支持“存在policy实现但实际Browser partition未接线”的判断；首次运行query与该源链相符。负向文本检索不能独自证明所有动态路径，已执行的第二新run继续使用真实guest并保留各run源码/构建指纹边界，与首次结果共同确认，见下文独立复验。

## 受控独立复验与后续验收

root已授权并实际在menu-final新run复验原canonical单case，`skipProvider:true`及common-only无模型请求；17:49:11.280 UTC在同第64行再次query得到`granted`，见 [第二NDJSON](../runtime/qa-menu-20261106-menu-final/evidence/test-results.ndjson)与 [完整summary](../runtime/qa-menu-20261106-menu-final/evidence/summary.json)。第二独立新HOME、fresh构建与未装配policy源链相符，确认产品授权边界启动接线缺陷，登记P1。没有请求真实位置或摄像头，不能由此宣称实际拍照/定位/泄露已发生。

后续修复应在Browser partition可创建guest之前从唯一Main启动路径完成policy、UI bridge与安全本地同意store装配，并保留无handler/无prompt的fail-closed合同。验收应覆盖未授权query、请求时产品决策、allow-session/allow-always/block-always、站点设置更改/重置、profile重启与多tab路由；真实OS权限与真实设备访问单独需目标平台验收。当前未修改或实现该修复。
