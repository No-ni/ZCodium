# 官方 3.16.2 手机窗口目录能力组适配

固定来源 `zai-org/ZCode@3c5b227649371507ddc4eb46ac5133afe6db1cab`。只在 adopt 工作区实施，不提交、推送、打包或操作真实服务器。当前仓没有上游 `project-storage` / 虚拟项目系统；本项吸收整组窗口目录能力与握手边界，目录 DTO 沿当前工作区/远程历史契约，不伪造完整上游虚拟项目 API。

## 所有者与范围

- 当前窗口 tab store 是已打开工作区成员的所有者，现有 `SyncWebRemoteControlWorkspaces` 是唯一目录投影出口；Main 只将已校验载荷和递增投影代际转发到同窗口 Host，不保存新的业务目录。Host 新 facade 只保存该条链路的只读派生投影，连接事实以现有 window registry 为准，不读取 Source 的 settings，也不以全局 lastWorkspaceSession 冒充当前窗口。
- 可选 `windowProjectDirectory` 必须一次构造整组 `window-project`、`window-remote-projects`、`window-project-changes` 服务。当前产品只需要只读目录快照与变化通知；现有桌面工作区编辑命令不更换所有者，不增加手机任意打开/删除/配置写入通道。
- 当前 attachment 的 file/git/terminal/model/task 服务保持 Source 语义，窗口目录能力不替换这些服务、不暴露完整 broadcast send/claim 或 Credential/配置同步接口。
- 目录变化只来自同窗口既有目录投影提交与 registry 的连接变化。只读 changes capability version=1，通过已存在 Host MessagePort 传输。

```text
window tab store -> existing SyncWorkspaces -> Main forwards -> Host projection facade
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
