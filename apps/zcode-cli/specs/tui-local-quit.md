# TypeScript 终端本地退出与连续输入

## 范围与来源

以当前 fork 的 TypeScript TUI 为准，参考上游 `7e910e2a` 的本地退出行为，只修改 `apps/zcode-cli` 的 TUI、必要退出链路及测试。本次不接入 Rust/native runtime、桌面 CLI 发行、自动 alias、共享 locale、provider/model/adapter 或架构治理重构。回归入口接入现有手动 CI，不改变构建触发与发行规则。没有现存的本地退出 spec，因此在 CLI 既有 specs 目录补充此规格。

## 产品规则

- 单行输入（允许首尾空白和大小写变化）完整 `/quit` 是本地控制命令。必须在业务 admission、模型选择、历史记录和正文投影之前识别；空闲、流式输出、权限审批、问答和无可用模型时均以退出码 0 正常退出。
- 本地 slash 建议提供 `/quit`；确认其补全也退出。`/help quit` 本地显示说明，既有 `/help` 结果补充本地退出说明，不新增共享命令或 locale 契约。
- `/quitfoo`、`/quit args`、包含换行的粘贴和含附件的 composer 输入保持业务正文，不因旧补全状态被折叠为退出。即使 `/qui` 建议已渲染、同一 React 批次又追加 `tfoo` 或 `t args`，提交也必须以此刻原文校验 `/quit` 的完整词或合法前缀；旧建议不能把另一条命令变成退出。Shift/Alt/Ctrl/Meta+Enter 不是退出提交。隐藏的子代理只读视图不能提交主 composer 草稿。
- 审批/问答占用键盘时，独立的 `/quit` 手势草稿不改 composer、附件或审批决定；Esc/删除只取消手势。问答 Other 编辑中仅显式提交完整 `/quit` 退出，`/tmp/fixture` 等文本继续作为正常答案。
- 退出请求同步进入终态且幂等。通过既有 AbortController 取消当前输出，拒绝未完成的本地审批，解除其 abort listener，再由 renderer destroy/unmount 和 CLI `finally → promptHandler.close()` 回收现有资源。不直接 `process.exit`，不新增超时，不删除已接受 queue，不改持久化或 runtime owner。
- 退出后迟到的提交或草稿回写不能再进入业务 admission；已有 accepted queue 仍属于 runtime CommandInbox，其事件/持久化/关闭行为沿用 fork。

## 状态所有者与事件顺序

- composer 草稿仍由 TuiApp 的同步 draft ref/原生 editor 拥有，React state 只负责渲染投影。提交清空必须在下一次 React render/layout effect 前同步作用于同一 editor，避免延迟 content-change 复活旧 prompt。
- 待审批 UI 列表使用同一同步 owner，React state 投影；每次编辑可克隆对象，但 `resolve` 句柄是同一请求的稳定身份，更新、完成与取消均按该句柄匹配。
- 本地退出终态由 TUI 唯一持有，所有退出入口复用同一请求；审批 Promise 仍由既有 requester 的 settled guard 负责幂等。
- 不新增共享接口、跨 Host owner/lease、远端恢复或手机 replay 语义。本修复仅裸 TS TUI；桌面 continuous 与手机 replayable 链路不变。

```text
键盘/textarea → 原始单行退出识别 → TUI exit owner（同步终态）
                                    ├─ abort 当前 turn + reject 本地审批
                                    └─ onExit(0) → renderer destroy/unmount
                                                   → CLI finally → 既有 close
普通 prompt → 同步清空 editor/draft → 既有 admission → CommandInbox（已接受 queue owner）
                       ↑
延迟 content-change 不得恢复已提交文本；迟到 rejected 输入不得覆盖更新草稿
```

## 已知原因与修复依据

1. React state 清空先于 layout effect，而 OpenTUI textarea 的原生 buffer 尚有旧 prompt；同批后续 `/quit` 被拼到旧文本，经 busy sendInput 进入正文/queue。同步清空原生 editor，不用等待 render 或定时器，测试必须直接证明原生 buffer 已清空、退出不触达 submit/sendInput。
2. 审批按键克隆对象后，旧引用过滤与同批闭包状态导致取消残留、后续字符丢失。使用同一同步 UI owner 与稳定 resolve 身份，不改权限业务决定和 workflow CLI 旁路例外。

## 验收与证据

| 场景 | 操作 | 必须断言 |
| --- | --- | --- |
| idle / no model | 输入 `/quit` 或确认补全 | exit 0 一次；submit/sendInput/历史/正文均无退出命令 |
| streaming | 普通 prompt 后 `/quit` | 当前 signal aborted；只提交普通 prompt；已有 accepted queue 不删除 |
| 快速连续输入 | 同一 act 内普通 prompt、Enter、`/quit`、Enter，不等待 React 刷新 | editor 同步清空，退出未拼旧 prompt，不进 busy queue |
| permission / question / Other | 占用键盘后同批输入退出 | pending Promise 取消、listener 移除、不产生 allow/modify 或正文；重复退出幂等 |
| question 编辑克隆 | 同批多字符/确认/取消 | 字符完整，稳定句柄移除该请求；普通路径可正常回答 |
| 输入边界 | 多行、附件、参数、修饰 Enter、只读视图 | 不误退，不折叠正文或提交隐藏主草稿 |
| 迟到回写 | queued/rejected 输入等待期间编辑新草稿/退出 | 不覆盖新草稿或重新 admission，不影响已接受 queue |

先运行失败回归，再实现后复跑。Node 单测、React/OpenTUI 合成输入与真实 PTY 是不同证据：Windows 缺少可用 PTY 时明确记为未验证，不把单测/模拟 renderer 写成真人 PTY 通过。目标测试、TUI typecheck、根与 CLI typecheck/lint 和 changed architecture 均执行并报告真实结果；已有失败不借本次修复掩盖。
