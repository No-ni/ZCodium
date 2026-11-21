# standalone CLI 的 managed CDP 浏览器

模块拥有现有 headless CDP adapter，实现 SDK BrowserControlPort；与 Electron 内嵌浏览器
是不同的平台适配器。旧 package/index 导入入口和能力表保持，登记不扩大产品能力。

- ManagedCdpBrowserControlPort 唯一持有 browser、launchPromise、generation、pending、
  closing 和 sessionPromise/session Maps；每个 ManagedCdpSession 持有原 context、tab 与
  dialog。内部命令函数接收同一 session，不创建额外 owner 或缓存。
- 原 list/execute 才启动浏览器；工厂与模块导入不启动。executable 与 Playwright loader
  保留注入，测试只用 fake loader；不新增下载或嵌入平台资源。
- generation、关闭检查、请求准入、取消、session 清理与最后的 browser close 顺序保持。
  有限 close 等待仍由原 port 管理，不能用新 timeout 改写 pending/实例事实。
- session command 分派只执行原 tab/dialog/page 操作；原 port 负责 withMeta、errorResult
  和异常归因。协议身份与 continuous/replayable kind 贯穿原调用链，不新增 replay 存储。
- DOM/action 适配只依赖 SDK 公开值与同模块 Playwright 适配；不引用 Runtime、Host 或 UI
  具体实现。模块不持久化任务、历史或个人凭据。
