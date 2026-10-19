# 性能复查生命周期修复交付（2026-10-20）

已完成前两轮复查确认的五项修复，并补齐上次中断时未完成的验证。产品规则与事件图见 [生命周期规格](../specs/performance-followup-lifecycle-fixes.md)。本轮随后收到用户指令：提交全部未提交改动、推送到自己的 fork，并手动启动 desktop workflow。

## 修复结果

| 问题                                      | 最终行为与证据                                                                                                                                                                      |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot 对端关闭后 RPC 挂起、重连复用失效缓存 | adapter 的本地 dispose 与对端 close 共用幂等终结；Bridge 按原实例删除缓存。真实 MessageChannel 验证握手前后、getView/偏好初始化中断线、重连以及旧并发 adapter 关闭不删除当前缓存。  |
| 迟到端口未释放                            | parentPort 只有一个分发器，超时、关闭、畸形、重复、无人认领及多余端口均回收；Bridge 注销 consumer。消息解析归传输模块，pending Map/已接收端口仍归 Bridge。                          |
| 插件历史会话裁决一直保留                  | Timeline 用生产 hook 持有发布者；正文更新复用句柄，切会话/卸载释放，同会话多发布者回退，最后释放删除记录。300 历史会话和浏览器 StrictMode/多视图/重挂均验证。                       |
| 在途配置保存迟到完成后重启已关闭 Bot      | 三类 Provider 共用单向关闭的 refresh queue；迁移、配置和凭据 IO 返回后检查代际。真实 BotsService 的在途保存可完成持久化但不启动连接，关闭后 Telegram 独立命令入口也不再接受新工作。 |
| Main 重连失败生成额外未处理拒绝           | 两条 Promise 完成路径清理同一去重表，并返回原 Promise。隔离子进程执行真实 manager，失败、取消、Host 退出、成功、并发去重、后续重试与应用关闭均没有 unhandledRejection。             |

本轮发现并修复了“只有一个监听器”断言遗漏的闭包保留问题：固定监听器与 unsubscribe 在同一作用域创建，V8 会经共享环境保留首个已注销 consumer。新增真实 GC 失败回归：100 次注销后仍剩 1 个 responses 对象。将监听器创建移到不接收 consumer 的独立工厂后，残留为 **0**，固定监听器仍为 **1**，之后迟到端口仍关闭。GC 只用于隔离测试，不改变生产时序。

## 验证

- 整合 Vitest：**114 文件、843 项全部通过**，100.52 秒。覆盖性能、Bot、RPC/server、desktop 远控、手机协议、relay、插件与 Gen UI；包含原双 delivery-kind 回归。
- 浏览器：**1/1 通过**。隔离 Edge 的 1280×900 与 390×844 下，12 卡 × 30 次正文更新的额外裁决订阅渲染均为 **360 → 0**；新增生产发布 hook 的 StrictMode 重放、无 absent 中间态、虚拟卡片卸载、切会话、多 Timeline 回退、卸载和重挂验证。无页面异常或外部请求。
- Main 重连、GC 回收和 local/desktop diagnostics：**16/16 通过**，使用与 Release tests 一致的 `--test-isolation=none`；需 Electron resolve hook 的验证在子进程隔离，不污染其他套件。
- 根 typecheck、lint、architecture:check --changed、fmt:check 全部通过。Lint 3106 文件，0 warning/error；架构 violations/baseline/new = 0/0/0；全仓格式匹配 3571 文件通过；git diff --check 通过。版本校验通过，3.15.1。
- 手动 desktop workflow 纳入本轮 Bot/插件/实时大小/Markdown 的定点套件，GC 与重连测试由既有 Release tests 入口发现。

真实失败记录：首次 Lint 检查发现 Bridge 超过 400 行，已将消息解码迁入现有传输模块，复验通过。Main 成功路径夹具首跑使用 schema 不支持的 local target 导致等待未完成；改用合成 docker target、Host 与 attachment 回包后通过，不认定为生产缺陷。GC 回归先失败后修复。

使用 PowerShell 7、corepack pnpm、Node 24.18.0。指定 Node 24.14.0 的下载长时间未完成，已停止并清理本轮下载残片，未执行未校验的二进制；GitHub setup-workspace 从 mise.toml 读取固定版本。未运行完整 Electron/实体手机/真实 Bot 网络 E2E，不将隔离夹具结果描述为完整应用验证。本轮未在本机打包或生成安装包。

所有权保持：adapter 管连接，Bridge 管等待和缓存，Provider queue 管关闭 admission，plugin-ui store 管活发布者。未更改 owner/lease、stale run、workspace identity、协议 schema、权限、持久化格式或桌面平台范围。

主要复跑命令：

```powershell
node --test --test-isolation=none scripts/ci/bot-remote-reconnect-lifecycle.test.mjs scripts/ci/bot-remote-message-retention.test.mjs scripts/ci/local-diagnostics.test.mjs scripts/ci/desktop-local-diagnostics.test.mjs
node --test scripts/ci/performance-plugin-disposition-browser.test.mjs
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm architecture:check --changed
corepack pnpm fmt:check
```
