# 官方 3.16.2 Source Server 接入适配

## 范围与固定边界

固定只读来源 `zai-org/ZCode@3c5b227649371507ddc4eb46ac5133afe6db1cab`。实现位于包含原未提交成果的 `C:/vibecoding/zcodium-adopt-3.16.2`；原工作区不改、产品版本不改、不提交/推送/打包。旧整体 merge 预检有 987 个冲突，本轮逐模块适配不是完整 upstream parity。

复用独立 Server CLI 的 Supervisor、Core、安装身份和窗口 Host 的 attachment/CommandInbox。只连接用户已部署且已启动的兼容 Source daemon；不隐式启动/注册服务、不安装/升级/下载/上传 Linux 资源、不提供官方更新回退。缺安装和未运行分别返回明确的手动部署/启动状态。SSH 原生 Windows shell 继续明确拒绝，通用 CLI Windows 源码契约仍维护。

## 唯一所有者与接口

- `SourceServerDirectory` 通过正式 Setting/Credential 服务持久化 Source/Profile；目标密码仅 Credential Store 持有，公开 DTO 只包含凭据引用，Main/Renderer 不保存凭据。旧 route history 的导入只能显式执行，不在 snapshot/getter 自动转换。
- `SourceServerConnectionManager` 独占 Source 物理连接、每次连接代际和取消；现有窗口 registry 保留 logical session/attachment 所有权，只持 manager 的 retain/release handle。两个 owner 不得同时创建/关闭 socket。
- Source daemon 业务数据位于其 server root 下独立 data base；不共享桌面 `.zcodium`，不自动导入旧根。Supervisor 独占 Core 生命周期；断开任何客户端都不停止 daemon 和远端任务。
- Source 上的 Store、任务库、CLI runtime/CommandInbox 是模型、额度、任务和已接受输入的事实；本地 Controller 只保留来源入口/展示投影。
- Source workspace alias 服务只读预检后显式确认，单旧变体可保留 canonical key，多个变体不能在 getter 内合并。跨库合并必须备份成功、可重入 phase ledger、alias 最后发布；真实用户迁移不在本轮执行。

## 身份与连接顺序

经 token + 一次性 Host capability 握手得到的安装 `serverId` 构造 `remote:server:<serverId>:<path>`。IP/Profile/remoteSessionId 不构成持久身份。`workspacePath` 只用于 IO/cwd/展示，所有隔离 key 沿 `workspaceIdentity?.trim() || workspacePath`。

```text
用户明确选择 Profile（配置同步策略与目标身份确认）
  -> Window Host Directory 成员与 generation admission
  -> transport probe（只读，缺服务/未运行明确拒绝）
  -> loopback ingress token -> server-info + compatibility
  -> 一次性 capability -> desktop-continuous RPC
  -> Directory 比较原 Source 身份（变化未确认零改绑）
  -> workspace alias 只读预检/已确认映射
  -> 已授权 provisioning v2 同步成功
  -> registry logical attachment ready
  -> Desktop continuous / 手机 replayable 访问同一 runtime
```

Profile 移除/更新先退休相应代际；旧 probe、握手、apply 完成不得复活已删 Profile 或新连接。未发布 handle 在所有失败/取消出口恰好释放一次。断线释放 ChannelClient/协议，使 pending RPC 拒绝；不取消 Source 任务。恢复仅恢复连接和可读事实，不自动续跑手停或中断 run。

### 连接 admission 与关闭补充

- 同 Profile/generation 的握手共享一个 flight，但每位等待者拥有自己的取消。单个取消仅退出该等待者；最后一位未接纳等待者退出才取消该 flight。取消代际不得复用，旧 flight 结束只删除自己。
- 物理 Source 连接发布后不再绑定发起 registry 请求的 AbortSignal；probe signal 只负责准备阶段，后续 RPC/channel 的关闭只由 manager 所有权决定。Source 的 logical release 仅减少引用，不停止 daemon。
- 同 Source 不同 Profile 可以共享已验证物理连接；返回的 handle 使用本次 Profile 的配置策略而非首次连接 Profile。删除一个非物理线路 Profile 仅退休其逻辑记录；物理线路删除/改变才关闭该线路，另一条线路后续显式重连。
- RPC 返回 `isClosed` 事实；manager 在任何异步屏障前订阅 close，并在发布前重新检查。未发布 close、迟到 close、同步 close 不得发布已死连接或清掉新代。
- Host shutdown 依次释放 logical registry、物理 Source manager、Directory，再释放本地 services；各阶段失败不阻塞其余阶段。Source 运行中的任务不调用远端 `disposeAllAndWait`。
- Source transport 实现仅在实际远端连接动作动态加载，不能由本地 Host 静态入口加载 ssh2 CJS 链。连接/flight/retain handle/options 的纯类型放在相邻 `sourceServerConnectionTypes.ts`，manager 继续公开 re-export 原 `ManagedSourceHandle`，不新增可变状态或连接入口；拆分后保持格式与 400 行门禁，不添加 lint disable。
- Directory 持久化成功后同步发布该次严格快照；manager 只接纳递增的 Directory generation，退休判定中不重新发起异步 snapshot。连接初始 bootstrap 快照迟到不得覆盖已发布的新快照。
- 显式身份确认改变 Source 时必须提升 Profile generation、清理旧 Source 的 preferred 引用并退休旧物理连接。仅绑定同一已展示新 ID 的确认 flight 可以接纳这一代际提升，普通旧 flight/handle 不能跨代继承；二次握手返回另一 ID 零改绑。
- 删除 Profile 清掉其自有 Credential Store 引用；改变 SSH 线路不把旧线路密码发送给新目标。凭据引用仅 Directory 产生，保存 Profile 不能注入任意 Key；settings 提交失败还原已改凭据。Source 记录可以没有 preferred Profile，删除时不自动选线或删除远端数据。
- 管理服务 dispose 后所有命令均拒绝，不允许迟到点击继续保存、删除或连接。UI 刷新使用请求序号与 Host generation 双门禁，旧请求成功或失败都不能覆盖较新快照。

## 配置同步与授权

窗口 Host 通过公开 `ISourceServerManagementService` 提供版本 1 能力、目录/安全状态快照、保存/删除 Profile、连接/断开及身份变化确认。它只调用现有 Directory/manager，不保存第二份业务状态。Desktop base attachment 显式构造可选 proxy；UI hook 在版本能力握手成功后才发布管理入口，其他 Host 不猜测 lazy proxy 等于存在。设置页使用 base Window Host 而非当前 Source 的 settings 服务。确认请求绑定 Profile/generation/已展示的新 Source ID；二次握手返回另一个 ID 必须再次拒绝。

保存 `configurationMode=mirror-personal` 是显式 opt-in：UI 先展示个人模型配置和 Key 将替换目标个人配置的范围，并由用户确认；此前始终 target。设置模式只改 Profile，不直接从 Renderer发送 envelope；下一次 workspace attachment 仍走 Main 既有 provisioning v2 首次同步屏障。Profile连接按钮仅打开物理服务，不宣称任务/配置已 ready，不安装/启动 daemon。

严格 schemaVersion 2，仅 personalConfig + syncId；不恢复官方 accountSettings/OAuth/MCP credentials。首次连接默认使用目标已有配置，只有用户选择“用本机个人模型配置镜像此 Source”才执行已有单向 provisioning 通道。目标已有内容必须在确认界面明确展示替换范围；未确认不清空。mirror 的首次 apply 成功才发布该策略下的 workspace ready，在线后同步失败只发布安全状态，不拆任务；lane 使用稳定 Source Environment，重连更新 registration，旧代际结果丢弃。

- Main 接到 Host descriptor 后先保留 `preparing` route，保留同一 Host 对象与 pending connect 关联直到配置屏障和 renderer ready 均成功；成功才使 route 可 attachment，Desktop 重挂与手机使用同一个判断。准备阶段取消、Host 关闭或 route 换代后，迟到成功不得调用 renderer attachment 或发布连接成功。取消先退休 Main 关联，再关闭本次 logical session；旧 Host exit 只清理自己的对象，不能清掉同窗口的新 Host 请求或 route。
- Environment lane 只由 coordinator 持有；注册用对象身份校验而非单独 ID。旧 dispose、旧 execute 成功/失败不能删除或完成同 ID 的新 registration；首次失败不记作已完成，失败执行者退休于调度目录，下一次显式连接可重新执行。最后注册退休时，仍在执行的 flight 仅保留到结算以防重连并行 apply；flight 结算后立即删除空 lane，不保存配置、凭据或无界离线 lane。执行 callback 同步产生的新触发也必须进入已注册的同一 drain。
- Host 在运行 provisioning 命令前再次验证 Source 的当前 Profile `mirror-personal` 授权；`target` 模式拒绝，不因 Main 的环境 key 合法就允许 apply。Profile ID/generation 只作为 Host 私有执行 authority 随已验证连接 handle 传递，不加入 Renderer descriptor；读取本机 envelope 后、发送 target apply 前再核当前 Directory 和 logical scope，代际退休拒绝本次 apply。

## 代表性验收

先补真实失败回归，再实现：严格 DTO/无秘密；同 Source 多 Profile 同身份、同路径不同 Source 隔离；身份变化未确认零持久化；并发取消/移除/旧 close 不影响新代；TCP/proxy-stdio EOF 只关 attachment；token 空/错误拒绝、capability TTL/一次性有效；兼容失败明确状态；无 Linux install/download/官方 URL；配置未授权零 apply、v2-only、断线 pending apply 拒绝；Desktop continuous 与手机 replayable 共用 CommandInbox。测试全部 OS temp/临时库/本地 loopback，不操作真实服务器或用户数据。2026-10-28 起入口边界更新：临时库与 temp 目录一律经 `scripts/ci/project-test-sandbox.mjs` 绑定的项目内 sandbox（含 `packages/desktop/scripts/sourceServerRpc.test.ts` 经根 wrapper 执行），系统 TEMP 写法仅为历史证据；产品行为与协议语义不因入口迁移改变。
