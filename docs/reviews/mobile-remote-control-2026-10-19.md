# 手机远控审查与修复记录

审查基于当前工作区源码。覆盖 LAN/relay 配对、窗口 SID 路由、Host attachment、RPC 分片与桥换代、工作区清单、V4 会话恢复和发送确认。以下为首轮六组修复；第二轮异常边界复核记录见文末。

| 问题                              | 复现与影响                                                                                                                                       | 修复及回归证据                                                                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1：LAN 并发鉴权互相干扰          | 两个页面交错获取 challenge 后，后者覆盖前者 nonce；失败 proof 也会清除另一页面的 challenge。原实现还允许重复握手、SID 不一致的响应和未鉴权查询。 | nonce、有效期和鉴权状态归各自 socket；校验当前绑定和一次性 proof。`lanEndpoint.test.ts` 通过真实 loopback WS 验证并发扫码、失败隔离、SID、过期和重复握手。         |
| P1：LAN 释放与复用缺少状态通知    | 桌面释放设备 handle 后手机仍认为已配对；复用同 SID 时只更新桌面为 waiting，手机不会重建旧桥。重复 dispose 旧 handle 还能释放新设备。             | 释放立即通知 waiting，复用根据当前手机连接通知 matched；离线不转发数据，handle 操作校验自身身份。真实 WS 测试与 Chromium/WebKit 浏览器均验证恢复、禁发和草稿保留。 |
| P1：LAN 持久 SID 恢复后请求丢失   | 停止再启动已有手机在线的 LAN 配对，不触发新注册回调；Main 缺少 SID → runtime 路由，bootstrap 超时。                                              | transport 启动前为持久 SID 恢复路由。真实 manager 与 LAN socket 回归验证同 SID 重启前后 bootstrap 均路由到原窗口。                                                 |
| P1：工作区变化后保留旧 attachment | 开桥后关闭本地/远端工作区、替换路径/identity/session 或断开远端，Main 只推送清单，没有撤销原 bridge。                                            | 清单变化时同步释放受影响 attachment，通知对应 bridge 失效；标签更新不重建桥。manager 回归验证七种 scope 变化与标签稳定性。                                         |
| P2：自定义 relay 路径无法连接     | 桌面配置 `/remote/socket?route=phone`，手机仍固定访问 `/ws`。                                                                                    | 二维码保留同源 WS 路径及 query，旧链接仍默认 `/ws`；拒绝跨源/网络路径。真实 manager/loopback relay 配对和手机 URL 解析测试通过。                                   |
| P2：ready 前降级阻塞恢复          | open 响应前 bridge-degraded 只释放 ChannelClient，旧 open Promise 仍占串行位置，新恢复须等待 30 秒超时。                                         | 降级立即结束对应 open 请求；正常 scope 切换仍串行。fake socket 回归不推进时钟即可重开，迟到旧 ready 不接管，并行 bootstrap 不被取消。                              |

## 所有权与修改范围

- `desktop`：endpoint 持有唯一配对表，socket 持有 challenge；Main 持有窗口 runtime/SID 路由及单一 attachment。LAN 类型和 socket 处理分开，保持原公开入口，满足每文件 400 行限制。清单推送沿用原函数，归入消息路由模块。
- `web`：客户端持有 pending open 和桥代际；二维码仅提供同源连接路径。不增加新的业务队列、状态副本或自动重发。
- Host、CLI CommandInbox 和会话投影继续拥有原业务状态。`desktop-continuous` 与 `web-remote-replayable` 保持各自交付语义。
- 先更新 `docs/specs/web-remote-control-mobile.md`，再补失败回归、实现修复；新增 LAN 套件已加入现有手动 desktop workflow，未触发 workflow。
- 功能图现有 workspace identity 与两种 delivery boundary 种子未改变；本次没有引入新的产品关系。
- 代码、回归脚本和 workflow 合计增加 845 行、删除 258 行，净增 587 行（包含 LAN 拆分文件及新增回归，不含 spec 和本报告）。

## 实际验证

- 使用 `mise.toml` 指定的 Node 24.14.0 和 `corepack pnpm`。
- 18 个 Vitest 文件、209 项通过：手机客户端、LAN/relay、Main manager/Host bridge、共享 RPC、清单同步和桌面 projection。
- CLI bootstrap 的 5 项 node:test 通过：resident session 复用、CommandInbox 同 ID 幂等与 admission 顺序、命令结果查询、桌面 continuous 与手机 replayable 的同一 runtime 流。
- `node scripts/ci/web-remote-control-window-sync-smoke.mjs` 通过：全部工作区、运行任务、关闭二维码后持续同步、工作区移除与空清单、停止后丢弃更新。
- `node scripts/ci/web-remote-control-mobile-smoke.mjs` 通过：完整生产 Vite 双入口与真实 CSS，真实 LAN/HMAC/Channel RPC；Chromium 与 WebKit 均通过会话初始前缀、增量、分页、延迟/丢失 ACK、待确认发送、真实 LAN handle 释放/恢复、跨目标草稿隔离和远端 session 更换。包含触摸滚动、窄屏/横屏、断线后权威快照；无未捕获浏览器异常。
- `corepack pnpm typecheck`、`corepack pnpm lint`、`corepack pnpm architecture:check --changed` 通过。Lint 0 错误/0 警告；架构基线违规 0、新增违规 0。修改文件格式与 `git diff --check` 通过。

本地浏览器证据保存在 `node_modules/.cache/mobile-audit-2026-10-19/`。可查看 [LAN 断开后草稿与禁发](../../node_modules/.cache/mobile-audit-2026-10-19/device-waiting-keeps-draft.png) 和 [WebKit 恢复后会话](../../node_modules/.cache/mobile-audit-2026-10-19/webkit-device-matched-recovered.png)；同目录 `videos/` 包含浏览器录制，均为合成测试数据，不随 Git 提交。

## 验证边界

浏览器业务服务使用 fixture；CLI 回归执行真实 gateway/inbox，但不连接真实模型或用户数据库。manager 的 bridge 调度使用受控 Electron/Host port。本轮未验证实体手机、公网 relay 部署或已安装桌面包，不将测试通过等同于这些环境已验收。

开工 freshness 检查因 GitHub fetch 连接被重置未完成，未声明当前分支已与远端最新状态同步。没有提交、推送或制作桌面安装包；浏览器构建临时目录由烟测清理。

## 第二轮复核：新增六组修复

第二轮重新检查源码和首轮改动，按 spec → 失败回归 → 修复执行。新增 19 项回归，保留首轮全部改动。

| 问题                                               | 复现与影响                                                                                                                    | 修复及证据                                                                                                                                                                                 |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1：remote 目标缺少会话身份仍创建 local attachment | 清单为 remote/connected 但 remoteSessionId 缺失，Main 返回 ready 并创建 local scope；空白 identity/session 也可进入开桥流程。 | bridgeController 在创建端口前要求完整非空远端身份。真实 manager 与 loopback relay 验证缺失/空白两种字段的四个负例均不创建 Host attachment。                                                |
| P1：损坏 HTTP URL 导致未处理异常                   | 静态处理器对 `/%`、不完整 UTF-8 编码调用 decodeURIComponent，抛出 URIError；relay 的 async HTTP handler 没有接住该拒绝。      | LAN/relay 返回 400，非法 URL 的 HTTP/upgrade 入口也进行校验。LAN 静态处理器三例与 relay 真实 HTTP 三例验证后续页面和健康服务正常。目录前缀越界的初步怀疑未复现，没有将其记录为已确认漏洞。 |
| P1：WebSocket 分片超限后仍继续接收                 | 应用层只在完整 message 到齐后检查大小；超过配置上限但 fin=false 的分片不会触发该检查。                                        | LAN、relay server 与桌面 relay client 为 WebSocket 接收器配置原物理上限。两个真实 WS 测试验证未鉴权超限首片立即关闭 1009；桌面 client 验证构造参数沿用配置。                               |
| P1：手机未经校验使用坏载荷，RPC 解码异常使请求挂起 | null wire/data 触发未处理拒绝，不完整清单进入 UI；外层 CRC 正确但内层 base64 损坏时，服务请求无法结束。                       | 复用共享 wire/app schema；坏载荷不能解除 pending。当前 RPC 坏帧或字节解码失败走原 bridge-degraded 路径，旧 stream 不影响新桥。三项协议回归及两种浏览器验证正常响应、草稿和发送能力保留。   |
| P2：Host 退出后 attachment 清理中断                | Attach 发送失败时两个未移交端口未关闭；Detach 发送失败使本地 port.close 无法执行，并把错误抛回窗口停止流程。                  | Attach 失败释放两个端口；Detach 失败仍关闭本地端口，dispose 幂等。两项受控 Electron/Host 回归验证关闭次数和不重复 detach。                                                                 |
| P2：relay 旧鉴权结果串入新连接，退避次数不归零     | 动态 crypto 加载期间断线换 socket，旧 proof 经全局 sendFrame 发向新 socket；成功鉴权后下一次断线继续扩大退避。                | proof 完成后核对原 socket、OPEN 状态、SID、auth 对象和清档状态；auth_ack 重置 connectAttempt。可控 socket/计时器回归在修复前分别复现串线与错误退避。                                       |

状态所有权不变：Main 管理窗口传输与 attachment；socket 管理鉴权代际；手机管理 bridge/pending 与草稿；Host/CLI 继续管理 session、projection 和 CommandInbox。没有增加 Agent、Host、自动业务重投或第二套队列。改动模块为 desktop、web、relay；仍通过已有公开 shared 契约交互，功能图的 identity 与 delivery boundary 无变化。

第二轮验证使用 Node 24.14.0 和 corepack pnpm。freshness 此次通过：main 与 origin/main 同步，ahead/behind 均为 0。21 个 Vitest 文件共 228 项、CLI bootstrap 的 5 项、窗口清单同步 smoke、typecheck、lint、architecture:check --changed 均通过；Lint 0 错误/警告，架构基线和新增违规均为 0。

手机 smoke 补充异常 wire/app 载荷注入，以同 socket 后续合法响应作为完成屏障，验证页面未崩溃、草稿未清除且仍可发送。严格校验还发现旧 fixture 清单缺 activeWorkspaceKey、bridge descriptor 多带 label；已修正为生产协议形状，并在 fixture 出站统一执行 schema 校验，异常注入单独经原始 socket 发送。

完整生产 Vite 双入口手机 smoke 最终退出码为 0，Chromium 与 WebKit 均通过：异常消息处理、初始流式前缀、增量/分页、延迟或丢失 ACK、查询暂不可用时同 ID 手动重试、LAN 真实释放/复用、跨目标草稿、remoteSessionId 换代及窄屏/横屏布局。窗口同步 smoke 首次因缺少默认 Playwright 浏览器未启动，指定本机 Chrome 后通过；手机 smoke 首次因上述旧 fixture 字段不符合 schema 失败，修正后全部通过。

本次证据目录为 `node_modules/.cache/mobile-audit-round2-2026-10-19/`，包含 Chromium/WebKit 异常载荷处理截图和视频；两张异常载荷截图已实际查看，正文、草稿与发送栏正常。两轮累计源码、测试与 workflow 增加 1380 行、删除 294 行，净增 1086 行（不含 spec 和本报告，包含首轮 LAN 文件拆分）；其中第二轮净增 499 行。修改文件格式检查和 `git diff --check` 通过。

验证范围仍是浏览器、loopback 网络、受控 Electron/Host 与 CLI gateway/inbox。实体手机、公网 relay、安装包和真实模型/用户数据库未执行验收；不把上述通过等同于所有部署环境均无问题。未提交、推送、触发 workflow 或打包桌面应用。

## 第三轮复核：连接替换与释放

在保留前两轮工作区改动的基础上，继续检查配对、断开清理、握手队列和 UI 恢复。freshness 检查通过：main 与 origin/main 同步。实现前已更新手机远控 spec，所有新增缺陷均先通过失败用例复现。

| 问题                                  | 复现与影响                                                                                                                                       | 修复与证据                                                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1：断线后旧 Host attachment 未释放   | LAN 手机断开、页面替换、relay 手机断开及桌面 relay socket 出错时，Main 仅更新展示状态，旧服务端口和订阅继续存在。                                | 非 paired 状态先摘除并 dispose 旧 attachment，清空原传输缓冲；展示宽限不延长 attachment 生命周期。四项真实 socket + manager 回归均在修复前因收不到 DetachServicePort 失败，修复后立即收到且只释放一次。 |
| P1：在线连接替换缺少失效通知          | relay 替换仍在线的 device/mobile 后只发 matched；旧 socket 的 close 被正确隔离，但另一端因此不知道原桥已失效。LAN 手机替换也未向 Main 报告断开。 | relay 双向替换先通知 peer waiting，再发布新绑定 matched；LAN 替换先通知设备旧手机断开。真实 WS 验证事件顺序、旧 close 不误伤新绑定及替换后仍能转发。                                                    |
| P2：切换目标被旧 open 阻塞            | A → B → A 时，B 的 ready 未返回，最后一个 A 仍等待 B 的 30 秒超时。                                                                              | open 取消归入已有 bridge 释放入口；仍通过原串行队列发送，迟到 B ready/Initialize/响应不影响 A。无须推进 fake clock 即出现 A/B/A 三次 open，普通 bootstrap 和终态错误语义保持原回归通过。                |
| P1：快速 waiting/matched 后界面不恢复 | 浏览器同一事件批次收到两次状态通知，React 合并 waiting；effect 只依赖最终 paired 字符串，旧 RPC 已销毁但 bootstrap 与订阅均未重建。              | 两处恢复 effect 依赖现有连接 snapshot，普通渲染不创建新状态。Chromium/WebKit 均验证重拉 bootstrap、重新订阅、首帧前禁发、首帧后恢复、草稿保留且无自动提交。                                             |

改动模块为 desktop、relay、web；状态所有者未变：配对表负责 socket 绑定，Main 负责单一 attachment，手机负责 bridge/open 与连接事件投影，Host/CLI 负责会话和 CommandInbox。两种 delivery profile、workspace identity 和功能图中的依赖边界不变。时序图与验收规则见手机远控 spec 的第三轮章节。

相对本轮开工时的工作区，源码与测试增加 156 行、删除 15 行，净增 141 行；不含 spec 和本报告，不重复计入前两轮改动。

实际验证（Node 24.14.0、corepack pnpm）：21 个 Vitest 文件 **234 项通过**；CLI bootstrap **5 项通过**，包括 continuous/replayable 共用 runtime 与命令幂等；Chromium/WebKit 完整手机 smoke、Chromium 窗口同步 smoke、typecheck、lint、architecture:check --changed 均通过。Lint 0 错误/警告，架构基线违规 0、新增违规 0。

浏览器新增场景首次复现 bootstrap/会话不恢复。修复后一次验证因测试 marker 拼入已有流式正文、却按完整文本匹配而失败；测试改为门控新订阅首帧，直接验证禁发与恢复，最终两种浏览器均退出码 0。该场景主动在单个浏览器事件批次注入协议通知；配对替换的真实网络事件顺序另由 relay loopback 回归覆盖。

本轮证据在 `node_modules/.cache/mobile-audit-round3-2026-10-19/`，包括 [Chromium 快速换代恢复](../../node_modules/.cache/mobile-audit-round3-2026-10-19/batched-pair-recovered.png) 与 [WebKit 快速换代恢复](../../node_modules/.cache/mobile-audit-round3-2026-10-19/webkit-batched-pair-recovered.png)。实体手机、公网 relay、安装包和真实模型/用户数据库未验证。改动未提交、未推送。

## 第四轮复核：停止、持久化与被踢终态

保留前三轮改动继续审查。freshness 通过，main 与 origin/main 同步；修改前架构基线和新增违规均为 0。先更新 spec，再用失败回归确认以下四类问题。

| 问题                                              | 复现与影响                                                                                                                                 | 修复及验证                                                                                                                                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1：并发保存把不同窗口的配对凭据混在一起          | 挂起 A 的密钥写入后保存 B，再释放 A，最终读到 B 的 SID 与 A 的 hash；load/clear 也能插入半写入过程。                                       | 现有 auth storage provider 串行执行完整 load/save/clear/rotate。受控 IO 测试验证最终为完整 B、读操作等待保存、clear 后无晚到 hash，失败不会堵住后续操作。                                                                |
| P1：凭据写盘失败留下混合记录并产生未处理拒绝      | 已保存 A 后，B 的 settings 成功而 credential save 失败，原实现仍可读到混合记录；manager 的后台 save 未捕获拒绝。                           | 保存失败尽力清除半份记录并保留原始错误给调用方；manager 捕获后台失败并仅记录固定文案和窗口 ID。测试先复现未处理拒绝，再验证当前内存配对仍能 HMAC 鉴权与 bootstrap，日志不含模拟敏感异常或 hash。                         |
| P2：LAN 停止遗漏未鉴权 socket，且启动可能迟到复活 | 未发 auth_init 或只收到 challenge 的连接不在已配对 mobile 槽中，stop 不会关闭；紧接 start 调用 stop 后，bind 完成又恢复 running/listener。 | endpoint 关闭全部 wss clients，拒绝停止期间的新 upgrade，同时关闭各 listener；stop 等待原 bind 完成，后续 start 等清理完成。真实 WS 验证未鉴权连接关闭、停止后不复活、重新启动可鉴权，以及已配对连接只产生一次断开通知。 |
| P1：桌面被 relay 替换后自动抢回同一 SID           | KICKED 或 4002 仍走普通退避重连，旧实例会与接管者相互踢下线。                                                                              | 被替换时停止心跳和重连、清除当前 socket 引用，隔离迟到 ACK；dispose 不注销新实例的绑定。fake clock 推进 60 秒无新连接或心跳，真实 WS 4002 关闭后也无自动重连；普通故障恢复测试继续通过。                                 |

本轮只修改 desktop 模块实现及相应测试；新增 authStorage 回归加入已有手动 desktop workflow，未触发构建。持久凭据仍使用原 settings/credential key，顺序由现有 storage provider 管理，不新增每窗口持久副本或跨进程事务。LAN/relay 只管理连接，Host/CLI 的会话、CommandInbox 和 continuous/replayable 语义不变。相对本轮开工工作区，源码、测试与 workflow 增加 349 行、删除 47 行，净增 302 行（不含 spec/本报告，不重复计前三轮）。

验证使用 Node 24.14.0 与 corepack pnpm：22 个 Vitest 文件 **246 项通过**；CLI bootstrap **5 项通过**；Chromium/WebKit 完整手机 smoke 通过，覆盖异常消息、快速换代、发送确认与丢失 ACK、真实 LAN 释放/复用、跨目标草稿、远端 session 更换和布局。增强已配对 stop/restart 断开次数断言后，相关 44 项回归再次通过。初次 typecheck 暴露测试 spy 参数类型，Lint 暴露 manager 行数限制；已修正类型，并收拢同一凭据清理回调及脱敏日志，未添加规则豁免。

本轮浏览器证据目录为 `node_modules/.cache/mobile-audit-round4-2026-10-19/`。真实 WS 测试使用 loopback relay fixture；浏览器复用真实手机入口、LAN 协议与 Channel RPC，业务服务为合成 fixture。实体手机、公网部署、安装包、真实模型与用户数据库均未验证。改动未提交、未推送、未制作桌面安装包。

最终 typecheck、lint、architecture:check --changed、修改文件格式检查和 git diff --check 全部通过；Lint 0 错误/警告，架构基线和新增违规均为 0。
