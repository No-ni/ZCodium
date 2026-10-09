# 本轮维护验证与遗留项

这份记录是 2026-10-06 的检查快照，后续以重新执行检查的结果为准。

## 已处理与验证

- 安装先验证、暂存及复验，再覆盖；不留旧版备份。下载校验 macOS arm64 artifact 身份，刷新签名 URL，有网络时限并回收 worker，失败保留原 ZIP。
- `python3 ../maintenance-scripts.test.py`：10 项通过，不联网、不修改 /Applications。
- 根 `corepack pnpm typecheck` 与 `corepack pnpm --dir apps/zcode-cli typecheck`：通过。运行环境是已安装的 Node 24.19.0，CLI 对固定 24.14.0 发出版本 warning；pnpm 使用声明的 10.33.2。
- 根 `corepack pnpm lint`：0 warning、0 error；架构检查：0 violation。改动文件格式检查及 `git diff --check`：通过。
- `node --test --test-isolation=none --test-timeout=120000 scripts/ci/*.test.mjs`：280 通过、0 失败、1 跳过。macOS 真实路径断言问题已修复。
- 中文 README 去掉两份重复正文，中文与英文版本说明以 package.json 为准；移除两项未使用 Stripe 依赖，frozen lockfile 校验通过。
- 旧 `packages/desktop/dist` 已移除，释放约 1.14 GiB；未改已安装客户端和用户数据。
- 已成功获取 upstream/main，引用未更新。当前已推送 HEAD 的 Desktop CI 成功；本轮改动未提交、未推送或打包。

## CLI Lint 的既有债务

旧入口先遇到 turbo/PATH 和全局 pnpm 问题；补通后，根 ignorePatterns 又令若干子包检查零文件。新入口显式枚举已有源码范围、使用根 oxlint 与独立配置，失败不会算作通过，也不会改变根 Lint 的范围。

实际检查 1,368 个文件，50 条 warning、80 条 error。80 条 error 全是超过 400 行的既有源码，所有对应源文件均未在本轮修改。没有放宽行数规则、增加文件豁免或为了通过检查拆分大型运行时。以下是需单独按状态所有者和契约拆分的文件：

| 文件                                                                                        | Lint 计数行数 |
| ------------------------------------------------------------------------------------------- | ------------: |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts`             |          4834 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts`                     |          2788 |
| `apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts`                               |          2431 |
| `apps/zcode-cli/packages/adapters/src/mcp/index.ts`                                         |          1878 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts`                         |          1676 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts`           |          1670 |
| `apps/zcode-cli/packages/adapters/src/fs/index.ts`                                          |          1644 |
| `apps/zcode-cli/packages/core/src/runtime/methods/session-fork.ts`                          |          1386 |
| `apps/zcode-cli/packages/debug/server/analyzer.ts`                                          |          1368 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-mapper.ts`                    |          1368 |
| `apps/zcode-cli/packages/adapters/src/model/runner-stream.ts`                               |          1363 |
| `apps/zcode-cli/packages/bootstrap/src/plugins.ts`                                          |          1274 |
| `apps/zcode-cli/packages/core/src/runtime/methods/steering.ts`                              |          1262 |
| `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts`                                   |          1114 |
| `apps/zcode-cli/packages/debug/src/App.tsx`                                                 |          1086 |
| `apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts`                    |          1077 |
| `apps/zcode-cli/packages/core/src/tool/executor/background-tasks.ts`                        |           970 |
| `apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts`        |           914 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-topic-publisher.ts`   |           903 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts`                            |           883 |
| `apps/zcode-cli/packages/contracts/src/model/index.ts`                                      |           868 |
| `apps/zcode-cli/packages/adapters/src/plugins/index.ts`                                     |           842 |
| `apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.ts`                  |           827 |
| `apps/zcode-cli/packages/bootstrap/src/app/session-facade.ts`                               |           820 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/cold-event-merge.ts`               |           795 |
| `apps/zcode-cli/packages/core/src/runtime/methods/turn.ts`                                  |           770 |
| `apps/zcode-cli/packages/contracts/src/workflow/index.ts`                                   |           768 |
| `apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts`                       |           723 |
| `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/usage.ts`          |           704 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/interaction-broker.ts`                |           684 |
| `apps/zcode-cli/packages/core/src/runtime/methods/file-rewind.ts`                           |           657 |
| `apps/zcode-cli/packages/bootstrap/src/app/types.ts`                                        |           646 |
| `apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts`                        |           631 |
| `apps/zcode-cli/packages/core/src/runtime/methods/events.ts`                                |           605 |
| `apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts`                             |           587 |
| `apps/zcode-cli/packages/bootstrap/src/app/bundled-plugins.ts`                              |           573 |
| `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`                                 |           564 |
| `apps/zcode-cli/packages/adapters/src/model/failure-classifier.ts`                          |           562 |
| `apps/zcode-cli/packages/core/src/permission/service.ts`                                    |           558 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/plugins.ts`                           |           557 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-telemetry-facts.ts`   |           555 |
| `apps/zcode-cli/packages/core/src/workflow/lifecycle.ts`                                    |           540 |
| `apps/zcode-cli/packages/cli/src/run.ts`                                                    |           534 |
| `apps/zcode-cli/packages/contracts/src/events/event-reducer.ts`                             |           517 |
| `apps/zcode-cli/packages/adapters/src/mcp/pool.ts`                                          |           516 |
| `apps/zcode-cli/packages/adapters/src/model/runner-generate.ts`                             |           511 |
| `apps/zcode-cli/packages/cli/src/prompt-command.ts`                                         |           511 |
| `apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts`                        |           510 |
| `apps/zcode-cli/packages/adapters/src/config/file-config.adapter.ts`                        |           509 |
| `apps/zcode-cli/packages/core/src/runtime/methods/turn-tools.ts`                            |           496 |
| `apps/zcode-cli/packages/core/src/runtime/helpers/attachment-media-resolver.ts`             |           496 |
| `apps/zcode-cli/packages/contracts/src/interfaces/browser-control.port.ts`                  |           480 |
| `apps/zcode-cli/packages/core/src/runtime/methods/model.ts`                                 |           473 |
| `apps/zcode-cli/packages/adapters/src/storage/workspace-hook-trust-store.ts`                |           472 |
| `apps/zcode-cli/packages/core/src/tool/handlers/read.ts`                                    |           467 |
| `apps/zcode-cli/packages/core/src/runtime/methods/compact-persistence.ts`                   |           466 |
| `apps/zcode-cli/packages/core/src/mcp/index.ts`                                             |           464 |
| `apps/zcode-cli/packages/adapters/src/plugins/zip-source.ts`                                |           458 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/subagent-session-query.ts`            |           456 |
| `apps/zcode-cli/packages/bootstrap/src/app/workspace-hook-review-controller.ts`             |           454 |
| `apps/zcode-cli/packages/core/src/tool/executor/result-display.ts`                          |           453 |
| `apps/zcode-cli/packages/core/src/runtime/methods/background.ts`                            |           442 |
| `apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts`                 |           442 |
| `apps/zcode-cli/packages/adapters/src/model/transform.ts`                                   |           440 |
| `apps/zcode-cli/packages/adapters/src/config/index.ts`                                      |           439 |
| `apps/zcode-cli/packages/core/src/runtime/internal-turn-methods.ts`                         |           436 |
| `apps/zcode-cli/packages/adapters/src/storage/index.ts`                                     |           435 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/command-inbox.ts`                  |           432 |
| `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts`                                    |           428 |
| `apps/zcode-cli/packages/core/src/agent/message-history.ts`                                 |           426 |
| `apps/zcode-cli/packages/core/src/hooks/runner.ts`                                          |           424 |
| `apps/zcode-cli/packages/adapters/src/storage/session-target.ts`                            |           422 |
| `apps/zcode-cli/packages/adapters/src/skills/index.ts`                                      |           421 |
| `apps/zcode-cli/packages/core/src/runtime/methods/compact.ts`                               |           415 |
| `apps/zcode-cli/packages/adapters/src/browser/index.ts`                                     |           414 |
| `apps/zcode-cli/packages/core/src/tool/handlers/read-session-context.ts`                    |           412 |
| `apps/zcode-cli/packages/core/src/runtime/methods/resume.ts`                                |           412 |
| `apps/zcode-cli/packages/adapters/src/mcp/oauth-interactive.ts`                             |           410 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/goal-compact.ts` |           408 |
| `apps/zcode-cli/packages/core/src/runtime/methods/usage-observability.ts`                   |           404 |

## Electron main 的既有类型错误

额外执行 `corepack pnpm exec tsc -p packages/desktop/tsconfig.main.json --noEmit`，有 60 条 error。根 typecheck 当前没有涵盖该工程。使用 HEAD 源码的虚拟编译器做基线对照，归一化联合类型成员顺序、排除虚拟编译器自身配置诊断后：60 → 60，新增 0、减少 0。

这些错误主要是 Main 与 shared 协议、BrowserView、远程 session 和 Windows helper 契约漂移，需要单独修正类型及行为并做平台回归。本轮仅清除 Main 未使用的局部值，不更改这些业务协议。

| 文件                                                                         | 错误数 |
| ---------------------------------------------------------------------------- | -----: |
| `packages/desktop/src/main/browserView/browserGuestManager.ts`               |     15 |
| `packages/desktop/src/main/browserView/browserPlaywrightExecutor.ts`         |     15 |
| `packages/desktop/src/main/desktopRemoteSessions.ts`                         |      4 |
| `packages/desktop/src/main/index.ts`                                         |      3 |
| `packages/desktop/src/main/taskRealtimeBus.ts`                               |      3 |
| `packages/desktop/src/main/applicationIcons.ts`                              |      2 |
| `packages/desktop/src/main/browserView/electronBrowserWebmRecorder.ts`       |      2 |
| `packages/desktop/src/main/chromeLocalStorageManager.ts`                     |      2 |
| `packages/desktop/src/main/desktopCronScheduler.ts`                          |      2 |
| `packages/desktop/src/main/resourceManagerStorage.ts`                        |      2 |
| `packages/desktop/src/main/windowsChromeAppBoundKey.ts`                      |      2 |
| `packages/desktop/src/main/browserView/browserPlaywrightLocatorExecutor.ts`  |      1 |
| `packages/desktop/src/main/browserView/browserScreenshotSurfaceContracts.ts` |      1 |
| `packages/desktop/src/main/desktopMainIpcPlatform.ts`                        |      1 |
| `packages/desktop/src/main/desktopPrintToPdf.ts`                             |      1 |
| `packages/desktop/src/main/desktopWindowLifecycle.ts`                        |      1 |
| `packages/desktop/src/main/manifestUpdateProvider.ts`                        |      1 |
| `packages/desktop/src/main/storageScanWorker.ts`                             |      1 |
| `packages/desktop/src/main/storageScanWorkerProtocol.ts`                     |      1 |
