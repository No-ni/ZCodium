# 内置浏览器地址栏操作与更多菜单规格

> 状态：已实现（2026-07-31）；2026-11-08 补充 Main 侧 file URL 原生出口合同（QA-BUG-003）
> 范围：`packages/ui` 统一内置浏览器 chrome；不修改 Browser Use 协议、guest 生命周期或远控消息流。

## 1. 目标

内置浏览器在地址栏右侧提供“在默认浏览器中打开”能力，同时收敛窄侧栏中的操作密度。

地址输入框固定使用 `h-7 rounded-lg`（28 CSS px 高、8 CSS px 圆角）；外层工具栏继续使用 `h-12`（48 CSS px），由工具栏垂直居中地址框和操作按钮。

新建浏览器 tab 后立即显示空置态，底层 `<webview>` 只挂载、不显示。地址栏内容在回车前属于未提交草稿：输入、粘贴或清空草稿均不得关闭空置态或提前显示 `<webview>`；只有确认提交合法 URL、恢复既有 URL 或接收外部导航请求后，才进入已导航状态并显示 `<webview>`。

`<webview>` 节点自身固定使用 `#FFF` 背景，不区分加载状态或 ZCode 明暗主题。空置态继续提前挂载 guest，但节点从创建时就同时使用内联 `visibility:hidden` 与 `display:none`，阻止 Electron guest surface 在 CSS 类生效前合成白色首帧；确认导航后解除隐藏。不得增加额外覆盖层或向 guest 网页注入 CSS，网页声明的背景正常绘制在该白色底之上。

地址栏操作的完整优先级固定为：

```text
自由尺寸 -> 选择元素 -> 在默认浏览器中打开 -> 调试
```

实际 chrome 只常驻前两个操作，第三个位置固定为“更多”菜单：

```text
+---------- address ----------+ [自由尺寸] [选择元素] [更多]
                                                       |
                                                       +-- 在默认浏览器中打开
                                                       +-- 调试
```

## 2. 交互合同

- “自由尺寸”和“选择元素”继续保持现有图标、激活态、禁用态和顺序。
- “更多”是地址栏右侧第三个常驻图标按钮，支持鼠标和键盘打开。
- 菜单按完整操作优先级展示被折叠的两个动作：
  1. 在默认浏览器中打开。
  2. 打开调试工具。
- “在默认浏览器中打开”使用当前已加载页面 URL，不使用地址栏里尚未提交的草稿。
- 仅当前页面为 `http:`、`https:` 或 `file:`，且 guest 已就绪时允许外部打开；`about:`、`data:`、空页和未就绪状态保持禁用。该门禁只判协议与就绪状态，不判断 file URL 的 host，也不拼本地路径；`file:` 的最终裁决在 Main，见 §3.1。
- “打开调试工具”沿用现有 guest ready 门禁与 `webview.openDevTools()` 行为。
- 点击任一菜单项后菜单关闭；错误或 detached guest 继续使用既有安全调用和 UI logger 诊断边界。

## 3. 平台与状态边界

外部打开复用 `IPlatformService.openExternal`。渲染层只表达「在默认浏览器中打开」的意图，不做协议之外的出口分流：

```text
  BrowserToolbar menu
  -> UnifiedBrowserView 读取当前 guest URL 并校验 http/https/file
    -> IPlatformService.openExternal(url)
      -> Desktop: preload send(PlatformChannels.OpenExternal)
        -> Main 原生出口 owner
           -> file:      -> fileURLToPath 解码 -> shell.openPath
           -> http(s):   -> shell.openExternal
           -> 其他协议   -> 不调用任何 shell 出口（fail-closed）
      -> Web fallback: window.open
```

- 不新增 UI 直接访问 `window.zcode`。
- 不新增 Desktop main / host process 业务状态，也不新增同步 IO。
- Desktop `desktop-continuous` 与手机 `web-remote-replayable` 的 stream、snapshot、queue、owner/lease 语义均不变化。
- Web 当前不暴露 embedded-browser capability；共享组件仍保持平台注入兼容。
- 出口分流只发生在 Desktop Main 的原生出口 owner（`desktopMainIpcRemote` 及其调用的 main 侧模块）；渲染层不解析 file URL、不拼本地路径，也不新增 `window.zcode` 直连。

### 3.1 Main 侧 file URL 合同（QA-BUG-003）

历史缺陷：Main 曾对 `http:`/`https:`/`file:` 统一调用 `shell.openExternal`，本地 file URL 被当成外部 URL 交给系统关联程序，`shell.openPath` 一次也没有被调用。合同固定为：

- `file:` 一律转本地路径，只走 `shell.openPath`；不得把 file URL 本身交给 `shell.openExternal`。
- 合法 file URL 的 host 只允许空或 `localhost`（大小写均可）。WHATWG URL 解析会把 file URL 的 `localhost` 归一为空串，因此实际判定条件是解析后 `url.hostname === ""`；其他 host（如 `file://server/share/x.html` 这类 UNC 或远端主机）一律按「不支持」处理，不得打开。
- 路径用 Node 标准库 `node:url` 的 `fileURLToPath` 解码：百分号（含字面 `%` 的 `%25`→`%`）、空格 `%20`、中文多字节、Windows 盘符（`file:///C:/...`→`C:\...`）都由该函数负责，不手写 `decodeURIComponent`，也不做字符串拼接。
- `http:`/`https:` 继续走 `shell.openExternal`，URL 原样传递，不解码、不改写。
- 其他协议（`about:`、`data:`、`javascript:`、`ms-settings:` 等）维持现有拒绝行为，且不得调用任何 shell 出口。

### 3.2 fail-closed 与错误语义

- 判定顺序固定：解析 URL → 协议白名单 → file host 白名单 → 解码本地路径 → 调用对应原生出口。任一步失败都只记录 Main 侧 warn 日志后返回；不降级成 `openExternal`，不猜测或修正路径。
- `PlatformChannels.OpenExternal` 是单向 `ipcRenderer.send`（契约 `response: void`），`IPlatformService.openExternal` 也返回 `void`。因此被拒绝的请求不会变成 renderer 异常、Promise 拒绝或 UI 错误提示：按钮点击即结束，失败只体现在 Main 的安全日志里（稳定 reason，不回显完整本地路径或 URL）。
- 渲染层门禁（`isDefaultBrowserOpenableUrl`）保持不变：它只决定按钮可用性和是否调用平台；host/UNC 的最终裁决在 Main，渲染层不重复实现也不放宽该规则。
- 不为此新增运行时依赖，不新增 IPC 通道或请求字段，不新增 Desktop main / host 业务状态或同步 IO。

## 4. 验证

- 组件测试约束常驻操作只有“自由尺寸、选择元素、更多”，并验证 DOM 顺序。
- 菜单测试约束“在默认浏览器中打开”位于“调试”之前。
- `http/https` 当前页面点击外部打开时，精确调用一次 `platform.openExternal(currentUrl)`。
- 未提交地址栏草稿不能覆盖当前页面 URL。
- `about/data` 与 guest 未就绪时外部打开禁用且不调用平台；所有 `file:` 页面在渲染层仍允许调用平台（host 与本地路径的裁决在 Main，见 §3.1）。
- 调试菜单项继续调用当前 guest 的 `openDevTools()`。
- Main 侧正式回归 `packages/desktop/test/e2e/browser-open-external-file-url.test.ts` 保持原断言不放宽：中文与空格路径的 file URL 必须经 `shell.openPath` 收到解码后的本地路径，且 `shell.openExternal` 零次。
- Main 侧单元回归 `packages/desktop/test/desktopExternalOpenRouting.test.ts` 覆盖：中文 + 空格 + 字面百分号 + 盘符解码、`localhost` 与空 host、拒绝 UNC/远端 host、`http/https` 只走 `openExternal`、其他协议零 shell 出口、出口抛错只记日志不外抛。
- 必跑定向 Vitest、`pnpm typecheck` 与 `pnpm lint`。
