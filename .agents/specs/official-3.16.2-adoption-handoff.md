# 官方 3.16.2 吸收实施交接

## 1. 目的、状态与授权范围

状态：**实施交接方案，尚未实施**。用户要求将前次推荐项，以及 Source Server / 常驻 daemon、数据库迁移框架、现有 Gemini / 自带 Key 额度 / 动态工作流 / 手机远控的增量一并纳入吸收范围，交给另一个会话执行。

本文件明确要吸收的产品能力、唯一状态所有者、适配边界、执行顺序和验收条件；不是已经完成的同步记录。本会话只调查并新增此文档，未修改实现、执行数据迁移、合并、提交、推送或构建。执行会话不得把本文件当成真实服务器安装、重启、旧用户数据合并、凭据覆盖、发行或更改长期规则的授权。

执行时自行完成，不派子代理，不启动动态 workflow；用户在本任务中明确要求不要派子代理。代码改动前加载 `architecture-governance`，更新对应行为 spec；修改 UI 读取 `DESIGN.md`，修改插件商店读取 `CONTEXT.md`。本文件作为总交接 spec，不能取代各模块的详细接口与用例。

## 2. 已核验基线

- 当前分支：`perf/linear-hotpaths`。
- 当前 HEAD：`18cc72cef7bec53eaa543b515e0c9332bc9cd05b`，2026-10-24。
- 根产品版本：`3.15.1`；CLI 顶层版本：`0.16.9`。
- 本轮 freshness 通过：与 `origin/perf/linear-hotpaths` 同步，相对 `origin/main` ahead 31 / behind 0。
- 官方吸收目标：`zai-org/ZCode@3c5b227649371507ddc4eb46ac5133afe6db1cab`，2026-10-20 的 3.16.2 源码快照。
- 前一官方快照：`0a1fc56d279fd1001f78387bd81aec1c26767411`，2026-10-19 的 3.16.1。
- 官方 3.15.1 tag 的实际提交：`aac4755666d09fdcd70272fcf063c077a639015f`；标签存于独立 `refs/upstream-tags/*`。
- 上述官方快照与本地 3.16 审计标签不在当前 HEAD 的祖先链中。当前是择项吸收，不是完整 3.16 parity。
- 工作树已有大量未提交修改和未跟踪文件，包括去官方依赖、安全日志、文档字体、本仓产品链接与 Provider 清理。执行前必须重新读取 Git 状态，保留全部无关改动；本文件不授权归档、丢弃或替别人提交这些修改。

官方历史是大源码快照，不能按 `chore: sync` 标题推导某项修复。执行前刷新官方引用并记录 SHA；本交接固定以上目标，不因 `upstream/main` 移动而自动扩大范围。不用历史同名 fork tag、不 merge `reference` 或第三方 fork。

## 3. 吸收总清单

| 项目                   | 吸收内容                                                                   | 当前判断与处理方式                                           |
| ---------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 工作流停止类错误       | 额度/认证错误与真正并发限流分开，不留下阻塞恢复的长冷却                    | 当前 governor 缺停止策略分支，优先补                         |
| 模型空响应             | 明确上下文超限、拒绝、内容过滤；保留 partial 与失败用量结算                | 当前空响应分类有缺口，优先补                                 |
| Bash 输出隔离          | 优先操作系统临时目录、不可用回退、启动前路径发布、取消/关闭结算            | 当前无 `bashOutputTempDir`，按本仓目录和生命周期适配         |
| 折叠卡片性能           | 隐藏 Radix Collapsible 内容跳过无意义几何测量                              | 同版本依赖仍使用旧测量，保留本仓动画修复并测量收益           |
| Windows 未读提示       | 任务栏 overlay、托盘提示及清除逻辑                                         | 当前无 Windows overlay；未读计数 owner 需先核对              |
| 文档共同阅读           | Word/Excel/PPT/PDF 侧栏、定位锚点、引用到对话、搜索与截取画面              | 当前无完整 `office-runtime`，吸收为独立功能                  |
| 模型与思考菜单         | 一个入口选模型并调档，窄屏布局、键盘与焦点行为                             | 保留已有模型/思考提交 owner，不另存选择状态                  |
| 侧栏完整视图           | 面板占满内容区、对话 tab、浮动输入与单 SessionPane                         | 当前无该模块，桌面限定                                       |
| ToolSearch             | 按需工具发现、Native/Local/Off 投影、恢复与权限边界                        | 当前缺该链；实验性、默认 Off，不保证省 Token                 |
| 模型目录增量           | MiMo v2.6 等官方新增模板与能力映射                                         | 择叶合入，不全覆盖用户配置或现有 Gemini 修复                 |
| Source Server / daemon | 桌面到现有 daemon 的主链、稳定 Source 身份、Profile、连接管理与恢复        | **纳入正式吸收**；复用已有 Server CLI，不重造 daemon         |
| 数据库迁移             | 通用协调、checksum、备份恢复、schema 守卫、Source 身份映射与受控旧数据合并 | **纳入正式吸收**；保留旧 checksum，不在开发时迁移真实数据    |
| 已有四类能力           | Gemini、自带 Key 额度、动态工作流、手机远控的未吸收修复与新架构集成        | **纳入增量吸收**；已等价实现的项目只复核和回归，不重复造能力 |

不吸收：官方账号/购买/加速卡/权益/官方额度控制面、官方分享或上传、自动 model-I/O 记录、遥测、官方 client config/rollout、官方 relay 与更新源、Linux 桌面或远端资源 producer。用户自选 Provider 的模型 API 和个人 API Key 额度允许保留。

## 4. 不变的产品与维护约束

1. Windows/macOS 是桌面构建范围；保留 Windows exe、macOS dmg、手动 `desktop.yml` 和四架构 artifact 契约。不新增 Linux 安装包、远端 artifact producer、下载/内嵌资源或新发行 workflow。
2. 通用 Server/CLI 和 transport 的跨平台源码契约可维护；这不等于允许提供 Linux 发行资源。Linux/WSL/Docker 的 Source Server 路径只连接用户已自行部署的兼容服务；缺服务或资源时明确返回不可用/需手动部署，不能自动下载、上传或准备 Linux runtime。不虚报一键安装可用。
3. 当前原生 Windows remote backend 因 POSIX 启动策略未支持；不能因 Server CLI 可在 Windows 运行而宣称 SSH 原生 Windows 远端可用。未实现 shell/transport 策略时保持明确拒绝。
4. 新增 Source Server 的安装/升级能力仅在允许的资源范围和明确用户动作下执行；本交接不立即运行服务器安装、系统服务注册、更新、重启或卸载。
5. 数据根保持 `.zcodium`；不自动读取合并 `.zcode` 或第三方数据根。同机 Desktop Local Host 与独立 daemon 不共用业务数据目录。`sourceServerId` 不作为另一份用户账号身份。
6. `ZCODIUM_UPDATE_ORIGIN` 未配置时跳过自动更新，不回退官方。Source Server 的 release resolver 只消费本仓/用户配置的源或显式本地 archive，并验证 target、版本、hash 与大小。
7. `workspaceIdentity?.trim() || workspacePath` 是隔离 key；`workspacePath` 用于 IO/cwd；`remoteSessionId` 是窗口路由句柄而非持久身份。
8. Main 只调度窗口/进程/attachment 和同步代际，不保存任务、快照或凭据。relay 只鉴权、配对、心跳、转发，不接管队列或数据迁移。
9. 执行只推送到 `origin = No-ni/ZCodium`，并且提交/推送/构建/Release 仍按单独授权处理；提交前展示中文文案。历史 spec 不是现行同步指令。

## 5. Source Server / 常驻 daemon 方案

### 5.1 产品收益与本仓起点

目标是让远端成为有稳定身份、可恢复连接的 Source：换 IP/连接线路不产生另一套任务；关闭桌面连接不等于终止远端任务；用户能看清在线、离线、版本不兼容和需确认的状态。

本仓已有：

- `packages/zcode-server-cli/src/supervisor/supervisor.ts`：Core 进程调度与 crash budget。
- `packages/zcode-server-cli/src/server-core/core.ts:40`：`standalone-server` 权威服务集合。
- `packages/zcode-server-cli/src/runtime/paths.ts:29`：server root、release、run 与控制端点。
- `packages/zcode-server-cli/src/runtime/installationOwnership.ts`、`server-core/serverIdentity.ts`：安装身份与 serverId。
- `packages/desktop/src/host/windowRemoteConnectionRegistry.ts:140`：窗口内 logical session 与现有 transport 退休边界。
- `packages/services/src/model-provider/providerProvisioningSource.ts:23` 和 Desktop provisioning coordinator：个人配置单向同步。

主要缺口是桌面现在仍走 `packages/server/src/remote/connect.ts:104` 的 detect/deploy/exec/stdio 链，没有完整接入上游 Source Server 管理与稳定身份。不要再造一套 Supervisor，也不要把现有 provisioning 当作全新功能。

### 5.2 必须连同吸收的层

- Shared：上游 `packages/shared/src/source-server/` 的兼容 manifest、连接状态/错误、进度、管理 DTO；扩展现有 `remote-workspace-identity.ts` 支持经握手验证的 `remote:server:<sourceServerId>:<path>`。
- Server：`packages/server/src/source-server/` 的 probe、transport adapter、单次探测、取消、channel、兼容服务接入。把官方硬编码 `~/.zcode/server` 改接本仓目录契约；不能新增第二套路径常量。
- Server CLI：吸收 ingress token、proxy-stdio、daemon 状态和 immutable release 收敛修复，保留现有安装所有权、停止等待、运行任务升级/卸载 guard 与失败回滚。
- Desktop Host：上游 `sourceServerDirectory`、`sourceServerConnectionManager`、`connectDesktopSourceServer`、`serverRemoteConnection`、恢复与 release resolver 的语义。按现有 owner 拆分，不全覆盖 Host 巨文件。
- Services：Source workspace alias/管理公共接口；远端项目入口、项目存储和任务归属的必要依赖。UI 经 hooks/公开服务读写，不直接访问 Repo。
- UI：连接管理、Source/Profile 显示、在线/离线/兼容失败/迁移待确认状态、项目入口与来源标识。只吸收远程主链需要的项目组织能力，不顺带改写全部分屏工作台。
- Client/Mobile：可选窗口目录服务组及能力就绪屏障；详见第 7 节。

### 5.3 唯一所有者

| 事实                                  | 唯一 owner                                    | 其他层只能做什么                                                   |
| ------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| Source/Profile 的持久记录             | Host 装配的 Directory/Repository              | UI 编辑草稿；Main 只路由                                           |
| Source 物理连接与连接代际             | Window Host 的 Source connection manager      | registry retain/release logical attachment，不另开同 Source socket |
| remoteSessionId、窗口附件与工作区绑定 | 现有窗口 registry/attachment owner            | Main 转发，手机 attachment                                         |
| daemon/Core 进程和 release 状态       | Server CLI Supervisor/runtime                 | Host 通过控制接口请求，不复制进程状态机                            |
| Provider 配置、任务组织态             | 对应 Source Environment 的正式 Store/Services | Controller 本地目录只保存入口/展示投影                             |
| 会话正文、工具、已接受输入            | Source 上的 CLI/runtime/CommandInbox          | Renderer 仅草稿与 optimistic overlay                               |
| 凭据                                  | Host/Source 正式配置与既有 CredentialStore    | Main、Renderer、relay 不保存/记录密钥                              |

现 registry 若保留 transport 字段，应只包装 Source manager 的 handle，由一个创建/关闭入口负责底层资源；不能出现 manager 和 registry 同时创建、重试和关闭同一条连接。过渡只按显式能力选择一个执行链，不能同时运行新旧 remote owner。

```text
用户选择保存的连接 Profile
  -> Window Host（成员 admission、取消代际）
  -> Transport Adapter（probe，必要时经用户动作安装/启动，openChannel）
  -> Source daemon 的 loopback ingress（目标用户 token）
  -> server-info / compatibility / capability ticket / Host 握手
  -> 校验 Source 身份，解析工作区 alias
  -> 已授权的个人模型配置同步屏障
  -> registry 发布 remoteSessionId 与 attachment ready
  -> Renderer/手机读取同一个 Source runtime
```

### 5.4 身份、凭据和恢复规则

- Source 身份来自目标安装的 `installationId/serverId`，不能用 IP、显示名或未经验证的 URL host 代替；本地路径 fallback 只对合法本地接口成立。
- 一个 Source 可有多个 Profile；Profile 标识线路与凭据引用。保存、移除、重加需 membership/generation 校验，旧响应不得复活已删除记录。
- 同一 Profile 握手得到不同 Source ID 时阻断并要求确认新 Source，不自动搬走旧任务或覆盖旧绑定。
- 使用 loopback ingress token 加既有 Host capability ticket；POSIX 文件权限按 0600/0700，Windows 保留对应用户隔离。token 不写入日志或业务快照。
- 断连只收尾物理连接与 RPC，不停止 daemon 或自动取消远端任务。未发布连接在失败出口释放一次，迟到关闭不影响新连接。
- 连接取消、旧 verifier/handle 迟到、最后一个 logical attachment 释放与 registry 关闭，继续满足当前退休 spec。
- 保留现有 owner/lease、stale run、commandId 幂等；崩溃后只恢复服务和可读事实，不自动续跑被中断的任务。
- 远端定时任务不是此阶段的新增能力；不要把窗口调度器暗中迁到 daemon。
- Source 连接安装锁必须是跨窗口/进程有效的锁或远端锁，不能沿用仅窗口内单飞就声称跨窗口部署互斥。

### 5.5 Provider 同步适配

当前本仓 envelope 已为严格 **schemaVersion 2**，只包含 `syncId` 与 `personalConfig`。Personal Config 中用户提供的模型 API Key 可作为用户选择远程运行的一部分传给其 Source；这不等于同步官方账号凭据仓库。

- 复用 `providerProvisioningSource/Target` 和 `ProviderProvisioningEnvironmentCoordinator`；不恢复上游 v1 的 accountSettings、OAuth credentials、官方 MCP credentials 或账号刷新。
- 目标正式 Personal Store/Registry 是执行事实；源仍从已成功持久化的本机配置读取，按 Environment lane 合并触发、重新读取最新值，不排每个事件的副本。
- 按稳定 Source Environment 登记同步，重连更新旧 remoteSessionId 的 registration。首次同步成功才发布适用的 workspace ready；已经在线后的同步失败只发布安全错误状态，不拆任务。
- 新 Source 如果已有独立 Personal Config，首次接管/替换必须在连接确认中明确范围并得到授权；未授权不静默清空目标。经授权成为本机配置镜像后，后续单向更新沿现有语义。
- 断连销毁旧 ChannelClient/协议，挂起的 apply RPC 明确拒绝；旧 lane 完成不得阻塞或污染新代际。
- 目标自身业务读取（模型列表、会话执行、额度）不能误用 Controller 本地服务。即使设置编辑页选定本机，也要明确“编辑本机”和“在目标执行”的分工。

## 6. 数据库迁移与旧身份合并方案

### 6.1 正式吸收的能力

吸收 `packages/shared/src/sqlite-migrations/` 的可复用能力，以及 schema.baseline / additive-schema 检查；同时实现 Source alias、迁移预检、受控合并、失败报告、重试与恢复能力。**包括旧数据合并的实现和 fixture 验收，不在开发时对真实用户数据执行合并。**

区分三类操作：

1. 现有 `.zcodium` 库的常规加法 schema 升级：沿既有 startup owner 执行，先迁移后发布 ready；没有待执行项不备份、不制造重复写入。
2. 新的项目/Source 组织字段和历史入口回填：先生成预检计划；涉及旧归属、顺序或身份的数据转换按该计划授权，不能在普通 getter、连接握手或页面打开中偷偷执行。
3. 跨路由身份合并、跨数据根导入、删除或冲突覆盖：显式确认目标 Source/path/计划后执行。`.zcode` 不默认扫描或导入，旧数据始终保留到确认。

### 6.2 checksum 兼容是前置门禁

- CLI 当前账本是 `schema_migration`，列为 `id/checksum/app_version/time_applied`；当前 checksum 为 `sha256(sql.trim())`，见 `apps/zcode-cli/packages/adapters/src/storage/session-store/migration-runner.ts:296`。
- Host 当前账本是 `tasks_schema_migration`，列为 `id/checksum/time_applied`；checksum 是 `sha256(JSON.stringify(冻结 checksumInput))`，见 `packages/services/src/session/tasksDatabase/migrations.ts:46` 和 `:98`。
- 上游通用 runner 默认按 SQL 算 checksum，**不能拿它重新解释本仓已发布的 Host 历史账本**。
- 冻结已发布 id、SQL、JSON 语义和结果；adapter 保留各历史校验器，只为新的迁移统一协调/备份/事务接口。新 id 从当前账本之后增加，不通过删除账本或改写 checksum 让升级通过。
- `previousIds` 只有经证明 SQL/语义完全一致才可沿用；不能用它吞掉不同迁移或把 alias 再次执行。
- 每个进程/数据库只有一个迁移事务 owner；`transactionOpen` 的提交归属必须明确。继续保留已有异步短 BUSY 等待、进度发布、成功提交计数和关闭资源边界，不恢复事件循环阻塞长等待。
- 上游 `touchedTables` 必填校验应吸收；Host 的 TS 回填需要冻结的语义标识，不能用 `function.toString()` 当稳定 checksum。

### 6.3 备份与恢复采用更严格策略

- 只备份本次待修改的真实历史表，含行数/hash、schema/版本和账本定位；新空库不制造空备份。
- 备份只写 `.zcodium` 下已约定或用户明确选择的目录；不照搬上游自动枚举其他卷并写文件的默认行为。
- 上游有“空间不足仍继续迁移”的行为，本仓对有真实旧数据的转换/合并采取 **备份失败即阻断**，不给静默跳过兜底。
- 只清理由此 runner 创建且验证完整的过期备份，未完成的恢复材料不能因保留数量策略被删；不自动清理用户文件。数据安全备份与“不备份安装包 artifact”不是一回事。
- `restore` 是显式工程操作：停用写者、核对库身份/schema、验证快照、事务恢复、外键检查；失败回滚，不能在业务运行中直接删父表造成级联丢失。
- 上游表级 restore 恢复行并调整 ledger，不代表自动撤销所有 DDL。涉及 schema 逆转需完整 SQLite 备份/对应恢复步骤；没有验证不能宣称可降级。WAL 活跃库不得只裸复制主文件。
- 任务库与 CLI 转录库、配置目录不能谎称单事务原子：采用 durable phase ledger，恢复点可重入，完成全部受控阶段后才发布 alias。

### 6.4 Source alias 与合并的事件顺序

外部 attachment 使用稳定 Source 身份，内部持久化可以继续保留既有 canonical key，避免一接入就全量重写数据。

- 无历史变体：按验证后的 Source 身份建立新 workspace。
- 单一旧变体：保留原持久化 key，登记稳定 Source 到该 key 的映射，不为换线路复制任务。
- 多个旧变体：预检现有 canonical 规则、重复任务/消息、配置目录、automations/off-peak 绑定和冲突；确认前不做写合并。
- 已有 canonical 映射不因另一条线路出现而改选；新变体需新的预检。
- 同路径不同 Source/OS 用户永不合并。只按路径判断不够，必须验证 Source、legacy hint、数据库 generation 与计划基线。
- 计划审批绑定 `Source + workspace + planHash/generation`（拟新增合同，名称实施时按架构确定）；审批后数据变化则计划过期，重新预检，零合并副作用。
- 冲突默认阻断，不选择“更新者覆盖”或自动取消/清除既有任务。失败仅阻断该 workspace，不把全部 Source 判离线。
- 取消/放弃表示不执行该计划，不等于删除旧数据。旧入口的读取兼容保留，但不能同时创建两套活动 runtime 来读写同一事实。

```text
readonly preflight（Source/路径/现有变体/冲突/库 generation）
  -> 展示可审阅计划与影响
  -> 用户确认目标数据转换
  -> 同一 owner 重新校验计划并停止相关写者
  -> backups-created
  -> task-db-merged
  -> session-db-merged
  -> config-dirs-merged
  -> alias-published
  -> completed / 可恢复失败报告
```

拟新增预检/执行授权端口必须为严格 DTO，不能把上游 `resolveWorkspace` getter 内的自动合并原样搬入。上游参考为 `SourceServerWorkspaceAliasRepo`、`sourceServerWorkspaceService`，按前述 gate 改造。

## 7. 已有四类能力：吸收增量，不重复重造

### 7.1 Gemini

已有原生协议、目录 metadata 持久化、精确 OpenCode 上限、工具 thoughtSignature 回放。以 `.agents/specs/google-generative-ai-provider.md` 为不变量。

吸收/核对新增模型目录、reasoning 映射与明确结束原因处理；执行会话输出逐项“上游新增 / 本仓等价 / 缺口”表。保留用户手动上限优先、未知 metadata 不填零、不按模型名虚报音视频/PDF 能力、默认思考不发送错误的 budget=0。每个 tool-call 的真实 providerOptions/signature 沿当前 history/persistence 保留，不能因 ToolSearch 或统一模型结果投影而丢签名，也不伪造签名兼容旧会话。

### 7.2 自带 Key 额度

已有 `UsageStatsService` opaque context、`useCodingPlanQuota`、固定准确厂商 HTTPS 端点与失效隔离；不拿官方账号额度服务替换它。

- 吸收真正影响个人 Key 的响应/展示修复，并把工作流停止类错误修复与额度恢复一起验收。
- Source 接入后，额度读取属于目标 Host/Environment。目标具备其自己的 ApiClient/ProviderSettings 能力时才查询；没有依赖 fail-closed，不借本机 Key 或本机结果。
- Controller 本机配置编辑页与激活 Source 的额度页来源必须明确，切 Host/Key 清旧快照、迟到响应丢弃。
- 仍无轮询、全局额度缓存、额度持久化或购买/重置 RPC。

### 7.3 动态工作流

已有 holes 原子提交、stale 审批、冻结模型绑定、持久 journal、owner/lease 与恢复语义。

吸收停止错误不冷却、模型调用/工具投影的缺口、Source workspace 绑定与可用目录/保存工作流增量；按实际 diff 确定，已等价实现的只回归。运行中并发设置、holes、修订和恢复始终由原 run/journal 决定，不能多建会话状态或自动恢复用户手停的 run。本地动态工作流可用性保持，不恢复官方订阅/client config gate。

ToolSearch 作为单独实验项：默认 Off；Native 仅真实能力支持时启用，Local 走既有 executor/校验/审批/Hook；发现历史、compact、权限变化与冷恢复测试齐全后才提供入口。

### 7.4 手机远控

已有本仓 LAN/自托管 relay、分片、CRC、ACK/replay、手机布局与 V4 conversation 投影；不替换为官方 OAuth/relay 页面。

新增 Source 的项目目录与窗口内容时吸收上游 `windowProjectDirectory` 的**整组可选能力**：

- owning Window Host 提供 window-project、window-remote-projects、window-project-changes，同一来源读写/变化流；手机不创建 Source 目录缓存或新 owner。
- 桥显式声明能力后才创建 proxy，发布前 `getCapabilities` 校验版本和就绪；“构造得出 lazy proxy”不是服务存在证据。
- 未声明能力沿旧手机目录行为；已声明但服务缺失或版本错误则明确失败，不能混入本地/Source 的另半套目录。
- 断线、换 attachment/remoteSessionId 时释放旧订阅、旧缓冲和旧 pending RPC；继续同一 CommandInbox 接纳、commandId 去重与 authoritative projection 对账。
- 实时桌面 continuous 不加手机 replay 缓冲；手机 replayable 不退化为仅直播。ACK 只释放已确认前缀，buffer bounded，旧 run/Source/attachment 事件不污染新页。

```text
Desktop Renderer（continuous） ─┐
                              ├─> 一个 Window Host attachment owner
手机 LAN/用户 relay（replayable）┘       -> 一个 Source 连接
                                       -> 同一个 CLI runtime / CommandInbox
```

## 8. 前次推荐项的实施要点

- 工作流 governor：复用 adapters 的同一 `resolveWorkflowModelFailurePolicy`，不是写另一份配额码表。停止错误只 ended；真限流照常 throttled；恢复不是重置卡/账号入口。
- 模型空响应：补 `createEmptyContextExceededError`、rawFinishReason 分类、stream finish 前失败终态、generate 路径一致和失败 usage。保留本仓净化 logger，不复制官方原始 response/body 输出。
- Bash：同时修改前台、后台、workflow child 的输出路径准备与关闭等待；临时目录 failure fallback 只对明确文件系统不可用原因，不吞逻辑故障。保持后台结果可读取。
- Radix：在当前 lockfile 的 `@radix-ui/react-collapsible@1.1.12` 上补测量优化，不移除本仓 transition-none 与淡入修复；依赖变更只改目标 patch。
- Windows badge：先确认现有计数是窗口私有还是全局投影，不能照搬 max 或 sum；保留 macOS，零数清除、窗口销毁/托盘重建、高 DPI/Windows 10/11 要验收。
- Office：吸收 `office-runtime`、四 viewer 技能、内置插件 MCP/UI manifest、锚点和本地 assets；保持只读、realpath 限制与资源 CSP，不允许 symlink 越界/面板外网。插件仍从随包 seed 安装，本地字体检查不恢复 CDN。
- 合并模型/思考入口：选择与档位按一次用户提交上下文归属同模型；桌面/窄屏/手机保持焦点与无障碍，不新增选中状态 owner。
- 完整视图：一个 SessionPane/composer；布局切换不重挂、不移 DOM，不丢草稿/附件/审批；仅桌面注册快捷键，不让手机出现不可用入口。
- 文件导航偏好可一并窄范围吸收：同 workspace 的显隐偏好由 store 独占；紧凑布局自动收起是 pane 局部覆盖，不污染用户全局偏好。

## 9. 实施阶段与合入方式

遵守 `docs/specs/maintenance-model.md`：官方同步使用 merge，不 rebase；不能用整树 `ours` 合并伪装成吸收，也不能以全文件覆盖破坏本仓优化。

### 阶段 0：前置检查与隔离

1. freshness、实际 Git 状态、远端 URL、Node/pnpm、当前源码 owner 复核。
2. 先处理实现工作区与当前并行修改的隔离；不可在脏工作树直接切分支/merge。可用独立 worktree，明确它是否包含当前未提交成果；不能把 HEAD-only worktree 当当前完整产品。
3. 按维护模型，从包含用户已确认现有成果的 main 建 `sync/official-3.16.2`。当前性能分支与未提交审计成果未进 main 时，先明确整合基线；未经授权不替用户提交/合并这些工作。
4. 固定官方 SHA，按依赖和本仓审计边界 merge/解决冲突，分阶段审阅与验证。不恢复已删除模块让测试通过。
5. 更新详细 spec 与架构受控上下文；新增 Source/SQLite/窗口目录的 feature graph seed 只引用实际落地符号，先记录 `graph-drift-candidate`。

### 阶段 1：独立修复与已有能力增量

先完成 workflow stop、模型结束分类、Bash、Radix、Windows badge、目录/推理映射；把 Gemini/额度/工作流现有能力的缺口表与回归补齐。此阶段不触碰旧用户数据或远端部署。

### 阶段 2：迁移基础设施与兼容 fixture

完成冻结 checksum adapter、异步 admission、备份/restore、schema baseline 守卫。用临时库验证所有已发布 ledger，包括任务/自动化/off-peak 与 CLI 消息/part；不借真实数据测试。

### 阶段 3：Source 底层与身份

Shared DTO/identity、daemon ingress/兼容、transport、connection manager、registry ownership、Profile/Directory 与 alias。先通过预部署兼容服务路径；明确未授权安装、无 Linux 资源、原生 Windows shell 未支持的失败态。

### 阶段 4：受控迁移与配置同步

上线 preview/confirm/execute/report/retry/restore gate，证明单变体不重写、多变体先确认、故障可恢复。接既有 provisioning v2、目标额度与模型执行，验证断连挂起 RPC/尾随同步，不恢复 v1 账号能力。

### 阶段 5：连接 UI 与手机窗口目录

接 Source/Profile/项目入口、身份更换与迁移确认；手机可选窗口目录与 replay/订阅代际。先 GUI fixture，再允许目标服务范围内的真实集成测试；真实用户数据操作另外确认。

### 阶段 6：产品增强

Office viewer → 模型/思考菜单 → 侧栏完整视图；ToolSearch 独立验收、默认 Off。避免同时改变项目目录、composer 和 stream owner 而无法归因。

### 阶段 7：全量门禁与记录

复跑根/CLI、定向与全仓 CI、UI/E2E；审计端点、秘密、目录、许可与平台产物。维护记录分别列吸收、等价已有、适配、剥离、未执行。根版本按确立的官方基线统一处理，发行仍另行确认；没有 commit/push/build 授权则仅交付源码与验证记录。

## 10. 代表性验收矩阵

以下是**待执行验收**，不是已通过结果。

| 场景            | 设置与动作                                        | 必须断言                                                            | 证据层                           |
| --------------- | ------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------- |
| 工作流恢复      | 配额 Stop + 长 Retry-After，恢复后再请求          | 无额度冷却、请求可准入；真限流仍减并发                              | governor/adapter，使用可控时钟   |
| 空超窗          | stream/generate 无输出 + raw context finish       | 一个失败终态、usage 保留、不重复原样重试；partial 不丢              | model adapter + runtime          |
| Bash            | tmp 成功/拒绝/准备中取消/后台关闭                 | 发布实际路径后才启动，无迟到进程或误丢输出                          | exec adapter + 独立子进程        |
| ledger 兼容     | 当前发布迁移与既有历史账本临时库                  | 原 checksum 通过，新项一次执行，损坏明确阻断                        | 真实 SQLite fixture              |
| 并发升级        | 两实例/两进程同库且备份需异步                     | 事件循环可响应，锁内重读、一次提交、ready 不早发                    | SQLite + 进程/进度               |
| 备份故障        | ENOSPC/权限失败/备份 hash 错                      | 旧数据零合并，不能 skipped 后继续；恢复失败回滚                     | 文件/SQLite                      |
| 多库迁移故障    | 在每个 phase 注入失败并重启                       | 重入安全，alias 最后发布、重复任务/消息不产生                       | 两库+配置目录+ledger             |
| 身份隔离        | 同路径两个 Source/用户，多 Profile 同 Source      | 前者隔离，后者同 canonical；身份变化先确认                          | 握手+alias+RPC                   |
| 计划过期        | preview 后新增变体或库 generation 改变            | execute 拒绝，零写副作用，重新预检                                  | API+SQLite                       |
| 连接生命周期    | connecting 取消、旧 close、window close、断连重连 | 恰好一次释放，旧 handle 不复活；daemon 任务不被 tab close 杀死      | transport+registry+Supervisor    |
| 跨窗口连接      | 两窗口同 Source connect/安装                      | 一个有效部署锁边界、无双写/重复任务                                 | 两 Host/目标控制夹具             |
| provisioning v2 | 多 workspace、离线改 Key、重连、apply 未完成断线  | v2-only、最新配置、挂起 RPC 收口、无账号 IO/Main secret             | 真实 Store+RPC+Host              |
| 目标额度        | 本地切 Source/Key 后旧响应到达                    | 来源正确、旧快照清空、无本机 fallback、无轮询                       | service/hook/GUI                 |
| Gemini          | 签名工具续轮、冷恢复、metadata 保存/手动覆盖      | 真实签名保留、模型能力不虚报、旧无签名明确失败                      | mock provider wire+history+Store |
| mobile 目录     | 能力缺席/完整/声明但损坏，换 attachment           | 整组来源一致，就绪后发布，旧订阅关闭，无新 runtime                  | Channel+bridge+GUI               |
| 两种交付        | 同 Source 桌面和手机；丢 ACK/断线/重发 busy input | continuous/replayable 分工、CommandInbox 幂等、草稿只在权威接纳后清 | runtime+RPC+双入口 GUI           |
| 平台资源        | Linux/WSL/Docker 无预部署；无自有源               | 无 build/download/upload/install Linux 资源，无官方 fallback        | source guard+网络出口捕获        |
| Office          | 本地文件/锚点/选区/重开/越界 symlink              | 只读、定位正确、无外网、跨 workspace 不能读取                       | tools+filesystem+插件 UI         |
| 完整视图        | 上传中/草稿/权限卡切视图和返回                    | SessionPane 单实例、焦点/附件/审批不丢，手机无入口                  | GUI+实例计数                     |
| Windows badge   | 0/多个窗口/销毁/托盘重建/DPI                      | 来源语义正确、无翻倍、清除/图像正确                                 | unit+Windows 真机                |
| ToolSearch      | Off/Local/Native/compact/权限移除/冷恢复          | wire 与能力一致，schema 不截断，沿原 executor，默认 Off             | model wire+runtime+GUI           |

剪枝：官方账号 OAuth/购买重置、Linux 资源发行、任务自动续跑、同机 daemon 与 Desktop 共享业务根、未支持的 Windows remote shell 不在验收成功集合；必须有明确拒绝/禁用守卫，不能直接跳过后宣称全支持。

## 11. 已存在的验证入口与拟新增入口

### 当前可用入口

- `node scripts/check-workspace-freshness.mjs`。
- `corepack pnpm typecheck`、`corepack pnpm lint`、`corepack pnpm fmt:check`、`corepack pnpm architecture:check --changed`。
- `corepack pnpm --dir apps/zcode-cli typecheck` 与 `corepack pnpm --dir apps/zcode-cli lint`；执行前读取当时 package.json，记录 registry/check 与 lint 的真实失败，不把未对照的诊断归为既有。
- `node --test scripts/ci/personal-provider-provisioning.test.mjs scripts/ci/coding-plan-api-key-quota.test.mjs`。
- `node scripts/ci/coding-plan-quota-smoke.mjs`、`node scripts/ci/self-managed-models-smoke.mjs`、`node scripts/ci/web-remote-control-mobile-smoke.mjs`、`node scripts/ci/web-remote-control-window-sync-smoke.mjs`；先读脚本的启动/环境要求，临时端口和目录必须结束清理。
- `corepack pnpm exec vitest run --config packages/ui/vitest.config.ts packages/desktop/scripts/remoteWorkspaceSessionServices.test.ts`。
- `apps/zcode-cli/packages/adapters/test/google-generative-ai.test.ts`、Bootstrap 的 `test/web-remote-command-inbox.test.ts`、`test/web-remote-v4-stream.test.ts`、`test/dynamic-workflow-run-holes.test.ts` 等通过既有 node:test/source runner 运行，不能被旧 dist 掩盖。
- Server 的 `test/remoteConnectionLifecycle.test.ts`、`remoteHandshakeHandoff.test.ts`、SSH 验证生命周期，Desktop 的 `src/host/windowRemoteConnectionRegistry.test.ts` 保留回归。
- 上游新增 `packages/server/test/sourceServerTransportAdapter.test.ts`、Source alias tests、ingressToken/proxyStdio tests、shared migration contract tests、schema guard tests可作迁移参考，但本仓没有全部这些测试，不直接声称可运行或通过。

### 拟新增或适配（实施后才运行）

- Source Server 连接/daemon/兼容和 capability integration 门禁。
- 冻结 ledger 兼容、备份阻断、跨库 phase 恢复与显式授权门禁。
- Source UI/迁移确认、mobile window directory、provisioning v2 真实断连 GUI 门禁。
- Office viewer、完整视图、模型/思考菜单和 Windows badge 对应定向及 GUI 场景。

建议接入当前 `scripts/ci/*.test.mjs` 与 `source-test-runner.mjs` 的可执行源测试体系；需要新包测试入口时在 manifest 明确声明，不假定仓库存在统一 `pnpm test:unit`/全量 E2E 命令。Node 24.14.0、pnpm 10.33.2 按 mise；CLI node:test 与 UI Vitest 不混用。Windows Shell 用 PowerShell 7。

全量 CI 在实现完成后执行并记录通过/失败/跳过；真实 SSH/WSL/Docker、macOS/Windows 系统服务、实体手机、真实模型 Key、安装包未执行时必须逐项标注。旧文档的测试数字不算本轮验收。

## 12. 交付检查清单

执行会话最终交付应包含：

- [ ] 对照官方 SHA 的吸收/已有等价/适配/剥离清单，附当前实现与测试证据。
- [ ] Source/daemon、迁移和既有能力各自 spec、公开接口、owner 图及批准/未批准的数据边界。
- [ ] 新的 Source 与 SQLite 模块架构 context/边界检查；feature graph 的实际落地 seed 与一跳关系。
- [ ] 冻结 checksum、现有净化日志、provisioning v2、Gemini 签名、CommandInbox 与手机 ACK/replay 的回归未被覆盖。
- [ ] Linux 资源/官方网络/账号/购买/遥测/更新回退的否定守卫仍有效。
- [ ] 根 typecheck/lint/fmt/architecture 与定向/全量测试真实结果，失败有前后对照才归因。
- [ ] 写入 `docs/specs/maintenance-model.md` 的新同步记录，不改写旧阶段结论。
- [ ] 明确未执行真机、安装、真实旧数据迁移、外网 Provider、commit/push/build/Release 的项目。

本交接本轮验证：已完成 freshness、Git/源码/manifest/spec 的只读核对；新增此文档。没有执行实现测试或真实数据/服务器操作，不能把本文的计划验收写成已通过。
