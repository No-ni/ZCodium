# 官方 3.16.2 手机窗口目录能力组适配

固定来源 `zai-org/ZCode@3c5b227649371507ddc4eb46ac5133afe6db1cab`。只在 adopt 工作区实施，不提交、推送、打包或操作真实服务器。当前仓没有上游 `project-storage` / 虚拟项目系统；本项吸收整组窗口目录能力与握手边界，目录 DTO 沿当前工作区/远程历史契约，不伪造完整上游虚拟项目 API。

## 所有者与范围

- 当前窗口 tab store 是已打开工作区成员的所有者，现有 `SyncWebRemoteControlWorkspaces` 是唯一目录投影出口；Main 只将已校验载荷和递增投影代际转发到同窗口 Host，不保存新的业务目录。Host 新 facade 只保存该条链路的只读派生投影，连接事实以现有 window registry 为准，不读取 Source 的 settings，也不以全局 lastWorkspaceSession 冒充当前窗口。
- 同一 IPC 入口内两类写入必须分级：`manager().syncWorkspaces` 写的是手机可见工作区清单，属必选链路；窗口目录投影属可选能力。固定顺序为「清单 schema 校验 → 必选清单写入 → 代际计算 → 投影严格校验 → 可选投递」。这里的清单校验不是宽松模式：`webRemoteControlWorkspaceSyncSchema` 仍是 `.strict()` 字段集，只是不补投影才有的跨字段规则（key 与身份一致、remote 条目必须带完整 identity、目录内不得重复身份）。投影失败不得回滚或跳过必选写入，也不得把异常抛回渲染端——渲染侧只有一条 warn，抛出去等于清单永久过期。残余边界如实记录：清单 schema 自身不通过时整条同步仍会抛回渲染端，必选写入也一起丢，这是协议严格性的有意代价，不为它增加兜底分支；渲染侧载荷由 `buildWebRemoteControlSyncPayload` 单点产出，字段变更必须同时改清单 schema。
- 严格投影校验只作用于投影：清单 schema（`webRemoteControlWorkspaceSyncSchema`）不补投影的跨字段规则，否则一条只影响显示的旧标签页形态会被升级成非法清单。legacy 标签页只带 `remoteSessionId`、没有 `workspaceIdentity` 时，必选清单仍照常写入，投影只跳过投递本身。
- 被拒绝的投影不占用代际：不写入 `projectionGenerations`，下一次合法载荷仍按同一 Host 的当前起点 +1，不出现倒退或被吞掉的空号。Main 侧 `projectionGenerations` 与该 Host 的 `generation` 单调门属同一条链的同一所有者，不新增第二份目录状态。
- 拒绝日志只允许窗口号、代际、候选条目数、zod 原因码与 schema 字段名；不得包含真实路径、identity、`remoteSessionId` 取值或 zod 报错原文（received/expected 片段）。
- 可选 `windowProjectDirectory` 必须一次构造整组 `window-project`、`window-remote-projects`、`window-project-changes` 服务。当前产品只需要只读目录快照与变化通知；现有桌面工作区编辑命令不更换所有者，不增加手机任意打开/删除/配置写入通道。
- 当前 attachment 的 file/git/terminal/model/task 服务保持 Source 语义，窗口目录能力不替换这些服务、不暴露完整 broadcast send/claim 或 Credential/配置同步接口。
- 目录变化只来自同窗口既有目录投影提交与 registry 的连接变化。只读 changes capability version=1，通过已存在 Host MessagePort 传输。

```text
window tab store -> existing SyncWorkspaces
  -> Main manifest schema (strict fields, no directory cross-field rules) -> required manager.syncWorkspaces   (mandatory, always first)
  -> per-Host generation -> strict directory schema -> optional postMessage -> Host projection facade
                               rejected directory: skip postMessage only, leave generation unwritten
window registry -------------------------------------------> connection facts
                                      -> three channels on existing attachment
Main only declares the complete supported group in ready envelope
mobile pre-open ChannelClient -> receive Initialize (possibly before ready)
                            -> validate ready group -> capability get(version 1)
                            -> same ChannelClient becomes ready
source task runtime/CommandInbox -> continuous desktop / replayable mobile
```

## 接纳与失败

- 手机在 open 前创建唯一 ChannelClient/装配器；ready 后添加可选代理只能使用这一个 client，禁止新建并覆盖单槽 onRpcMessage、seq、ACK 或 replay buffer。
- ready 信封能力缺席是旧 Host，保留原目录 bootstrap/list 路径；声明版本1后服务缺失/握手错误必须失败，不能静默读 Source 目录；不支持的版本明确拒绝。
- capability RPC 期间切桥/断线/换 remoteSessionId 时，旧结果不发布 ready，pending RPC 由原 ChannelClient dispose 拒绝。目录事件订阅随 attachment/generation 释放。
- 从任何 Source attachment 返回的是同一个 owning Window 目录，路径相同但 identity/Source 不同的入口不合并。公开 DTO 不带 password/passphrase/token 或完整配置。
- 当前手机可列范围仍由既有 bootstrap/workspaces 决定；目录快照仅丰富当前窗口入口，不通过它扩大访问其他未打开工作区。

## 验收

真实 facade boundary tests：base/Source不同目录、完整组绑定、无秘密、变化仅本地目录/registry、dispose旧订阅。真实 Channel RPC 编码的手机 tests：Initialize早到、组缺席兼容、缺服务/错误版本拒绝、切桥迟到能力结果丢弃、ACK/replay序号连续、ready后不造第二client。复跑已有 mobile protocol、bridge lifecycle、controller tests。GUI仅在可用官方browser工具执行，不把fixture测试写成手机真机验收。

Main 侧同步入口顺序回归（`scripts/ci/web-remote-control-window-directory-sync.test.mjs` 驱动 `packages/desktop/src/main/webRemoteControl/ipc.test.ts`，4 项纯内存用例：① 合法投影在同一 Host 上单调递增代际（两次投递为 1、2），未知窗口不投递；② key 与身份不符只否掉投影，必选清单仍写入且不抛回渲染端；③ Host 尚未拉起时必选清单仍写入；④ legacy `remoteSessionId` 缺 `workspaceIdentity` 时必选清单先落、被拒投影不占代际，随后合法载荷仍是代际 1；第④项同时断言拒绝日志只含窗口号/代际/计数/zod 原因码与 schema 字段名、不含 identity 取值，并断言 `syncWorkspaces` 的入参原样保留 legacy `remoteSessionId` 与 `lastConnectionError`——只有可选投影剥掉 `lastConnectionError`，防止「保留 legacy 身份」只停在注释里。明确未覆盖、不得当成已验收：Host 对象更换后代际重起算（依赖 `windowHostProcessMap` 的对象身份）、`postMessage` 自身抛错路径、`projectionGenerations` 随窗口关闭清理。该入口经 `scripts/ci/project-test-sandbox.mjs` 绑定项目内 `.run-logs` 沙箱运行，不装载 Electron、不触网、不读写真实 `.zcodium`。此条为源码级回归，不等于手机真机验收。
