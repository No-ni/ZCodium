# 最近修改扫描：修复与最终验收

## 范围与结果

自行审查当前未提交的 Google 原生协议、个人 Coding Plan 额度、TUI 本地退出、远控弹窗、远端握手和插件裁决修改，不派子代理。修复确认问题，并把必要的契约、配置依赖、规格与回归作为完整提交；不推送、不触发 GitHub Actions、不打包或安装桌面应用。

- Google 目录只对原生协议剥离 `models/`，不改写 OpenAI/Anthropic ID；只接受正的安全整数上限，显式目录上限通过真实 `personalConfig` 保存，用户手动覆盖继续优先。
- Google 工具真实签名通过 normalizer、历史、持久化、冷恢复与请求回放保留；输入和可写历史快照深拷贝嵌套工具元数据。Core 复用公共 contracts 类型与现有 assistant 构造入口。Gemini 3+ 缺签名旧历史发送前明确拒绝，不注入跳过验证哨兵。
- 额度请求在 `readContext` 的 await 恢复后校验服务当前 owner，防止微任务换 Key 后旧 context 借用新凭据或接受旧响应。Desktop 远端 accessor 显式使用目标 Host 的 usageStatsService，依赖缺席失败关闭，不回退本机 Key。
- stdin 独立无错误 close 时，未完成的 hello/ACK 握手立即拒绝；仍沿用同一 ACK 写入 owner 和成功后字节交接。
- TUI 退出读取同步草稿与原始完整单行命令，不被旧 slash 补全、克隆审批对象或迟到的 rejected input 误触发或覆盖；退出继续走原清理路径。
- 远控刷新确认框已经打开后，Host 进入 busy 时同样禁用确认按钮。完整 E2E 在缺少该条件时先失败，补 `disabled={remote.busy}` 后通过；取消不提交，busy 解除后只确认一次。
- 插件 `byToolCallId` 对 `__proto__` 使用自有数据属性，不触发原型 setter；保留普通对象输出、可枚举属性和重复 ID 最后写入语义。

规格中的所有者和事件顺序保持有效：ProviderSettings 是凭据唯一来源，历史是工具元数据 canonical owner，Runtime CommandInbox 是已接受输入的 admission owner。没有新增业务队列或持久化入口，没有删除 owner/lease、workspaceIdentity、remoteSessionId 或 stale-run 防护；desktop-continuous 与 web-remote-replayable 的交付边界不变。

## 实际验证

Windows / PowerShell 7；用仓库外临时启动 shim 让 Node 和 Corepack 子进程均使用 `mise.toml` 固定的 Node 24.14.0、pnpm 10.33.2，没有更改全局系统安装。

- Vitest 扩大回归：19 文件、212 项通过，涵盖远端握手与 handoff、stdio 生命周期、RPC、Provider/私有配置、Desktop 远端服务合并，以及导航/插件兼容性。
- Google 原生请求、工具签名、目录及真实保存：31 项通过。
- TUI 合成 React/OpenTUI 输入：15 项通过。
- 选定源码、夹具隔离和 fork 边界脚本：54 项通过，其中个人额度服务/RPC 回归 13 项。
- `node scripts/ci/web-remote-control-dialog-smoke.mjs` 通过：中英、明暗、1200/768/390/320px、低窗口与大字号、正文滚动、固定关闭按钮、复制/取消/确认/busy、五个 Bot 入口与 identity 路由。
- `node scripts/ci/coding-plan-quota-smoke.mjs` 通过：加载、同上下文失败保留、零/无数据、换 Key/Host、离页、迟到成功/失败及订阅释放，中英明暗窄宽布局。
- `node scripts/ci/self-managed-models-smoke.mjs` 通过：真实格式 Select、Gemini 目录上限保存、手动覆盖及既有创建/刷新/删除/失败恢复/导航场景。
- 根 `corepack pnpm typecheck` 与 CLI 官方 `corepack pnpm --dir apps/zcode-cli typecheck` 通过。CLI typecheck 按现有入口生成 TUI/工作流开发依赖，不是桌面安装包构建。
- 根 `corepack pnpm lint`：0 警告、0 错误。`architecture:check --changed`：0 违规、0 基线、0 新增。
- 根完整 `fmt:check`、CLI 所有 29 个修改/新增代码配置文件的格式检查及 `git diff --check` 通过。
- 实际暂存树归档中再次验证插件修复、远端握手/handoff 和 Desktop 服务合并：4 文件、61 项通过；插件测试为 7 项，不包含留在工作区的两项快速返回测试。归档中的定点 Lint 与格式检查通过，原工作区草稿校验值未变。
- 新 CLI 退出模块与 Google/TUI 测试的定点 Lint：0 警告、0 错误；TUI 15 项最终复跑通过。

上述非浏览器组共 312 项通过，后续复验不重复相加。导航缓存与无插件快速返回虽已验证，但不属于本次确认问题的修复提交。

## CLI Lint 未通过

同一个 oxlint 可执行文件、配置和官方入口文件范围，对 Git HEAD 归档与当前源码分别检查，二者均退出 1：79 个错误、56 个警告。没有新增报错文件、规则或警告，但四个既有超长文件的有效行数扩大，不能写成“零新增问题”或“全部 Lint 通过”。

| 文件                                         | HEAD 有效行数 | 当前有效行数 |
| -------------------------------------------- | ------------: | -----------: |
| `adapters/src/model/transform.ts`            |           440 |          461 |
| `contracts/src/model/index.ts`               |           868 |          883 |
| `core/src/agent/message-history.ts`          |           426 |          408 |
| `core/src/agent/session-history-hydrator.ts` |           518 |          521 |
| `core/src/runtime/methods/turn-tools.ts`     |           496 |          509 |

路径均相对 `apps/zcode-cli/packages/`。没有放宽 400 行规则、忽略诊断或刷新架构 baseline；本次不扩展为无关的全仓超长文件重构。

## 保留与限制

- 保留工作区原有的功能图、Navigator 缓存/辅助函数/测试/规格，以及插件无候选快速返回的实现/测试/规格草稿。CI 只提交修复关联的测试入口，不纳入导航缓存入口。
- 浏览器夹具仅监听 loopback，使用虚构状态与 mock ports，不访问外网或真实 Key。官方 IAB 仅取得远控布局观察，手动刷新点击未成功确认；交互通过上述持久 E2E 验证，不宣称真人点击验收通过。
- 未执行 Windows 真人 PTY、macOS GUI/打包、真实厂商额度 API、真实模型、Electron 整机 profile 或所有平台全仓测试。源代码和回归通过不等于仓库绝对无 bug。
- 保留 Windows EXE/macOS DMG、`.zcodium`、自有更新源和手动 CI 边界，不恢复 Linux 包或官方账号额度。
