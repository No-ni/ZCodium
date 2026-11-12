# 手机共享 Root 接入

此模块只借用配对客户端 port，并将可信 workspace descriptor/同实例 accessor 注入既有 Root。
不创建 socket、Host、CLI、conversation store、已接受输入队列或项目目录副本。

`openSharedWorkspace` 必须先完成 bridge handshake 与整组 capability prepare，再返回可复检
scope/generation 的 accessor。失效同步通知调用方撤下旧 Root；旧 callback 与迟到请求不得
更新新 bridge 的导航、查看、草稿或 slot。恢复只保留导航意图，正文与 queue 由 SessionDataLayer
按 web-remote-replayable 重新读取。桌面 continuous 不经过此入口。

Root 首次渲染前同步登记同代 accessor，清理按实例执行；borrowed registry entry 不拥有协议
disposer。窗口身份变化取消在途接入并重置恢复意图，同窗口清单刷新不重挂相同 scope。
内部 controller/平台装配 port 位于 app 层，不扩张公开配对传输契约。草稿完成仅由真实 Root
初始化触发，经当前实例与导航代际围栏一次转发；slot 发布和 bridge 就绪不冒充草稿完成。
草稿发起方租约在所有准备 IO 前后和撤下旧 Root 前最后复检；同步准入时完成所有权交接。
交接导致发起组件卸载不取消新 Root，之后只由目标 slot/access/导航代际控制初始化与通知。
准备期间取消仍拒绝；新导航、配对窗口或目标失效不得完成旧交接。
调用开始后的错误反馈由 controller 单次结算；未交接时复检 source/caller，已交接时复检目标
导航与窗口代际。原 Root 手机 await 消费拒绝，不能再由旧 mounted/alive lease 取消或重复反馈。
旧操作失效不通知；完成仍只来自新 Root 的真实草稿初始化。
已有 task 和无草稿 slot 也交接同一初始化租约。相同 bridge 内的 task/草稿导航仍使旧 slot
失效，switcher 的读取、用户动作与 Reporter/订阅回调都复用该 slot 租约；旧清理静默忽略。
成功 reconnect 仅允许原窗口及未被替换的导航意图，不要求已经被重建的旧 bridge 保持有效。

Root.ProjectDirectoryProvider 读取已装配的窗口目录代理，窗口与 Runtime 仍各持既有业务事实。
跨 workspace 与新任务只使用既有可信清单/公开 Host admission，不接受客户端 cwd 扩大访问范围。
跨工作区打开携带的 unread CAS 由目标就绪后的新 slot/access 发给既有 WindowController；
完整 descriptor 地址与 expectedUnreadAt 保持，写入失败不撤销已打开目标。
项目树行可省略 remoteSessionId；path/identity 严格匹配，显式错误 session ID 拒绝，实际 CAS
仍由当前可信 descriptor 的 remoteSessionId 寻址，不以任务行缺省值覆盖连接身份。
浏览器平台只使用已有 browser primitive 与严格 platform-request allowlist；所有失败提示为安全分类。

实施/验收规则见 `docs/specs/native-context-mobile-entry.md`。源码及静态验证不得冒称手机产品通过。
