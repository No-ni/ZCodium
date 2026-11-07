# CLI 退役账号命令的路由优先级

状态：2026-11-08 补充（QA-BUG-001 修复依据）。适用入口：argv `zcode login|logout`、headless
`--prompt`、TUI 提交与 busy 输入。官方账号/OAuth 模块已从本仓剥离，本规格只描述本仓现状。

## 背景

官方登录/登出已退役，只保留固定失败说明（[retired-account-command.ts](../../apps/zcode-cli/packages/cli/src/retired-account-command.ts)）。
2026-11-02 合并官方 v3.17.1 时，冲突解决把上游 `name: "login"` 的解析分支误改成
`name: "workflow"`，使 `/login` 借用动态工作流身份。默认 `--workflow-mode disabled` 下
headless `runPrompt` 的 workflow 门禁先于退役判断执行，于是 `/login` 返回「动态工作流已禁用、
重启并开启 workflow」的错误引导（QA-BUG-001）。

## 规则

1. **唯一判定入口**：`isRetiredAccountCommand(rawName)`。只看解析出的原始命令名（大小写不
   敏感），不看 `name` 映射，也不看参数。
2. **解析层不得别名**：`parseSlashCommand` 不把退役命令登记成任何存活命令的 `known` 形态；
   `/login`、`/logout` 与未知命令同形（`type: "unknown"`，保留 `rawName`），使任何按
   `name` 分流的门禁都碰不到它们。
3. **入口优先级固定**：退役 → 运行模式门禁（`workflowMode`）→ 具体命令 → 普通 prompt。
   四个入口都必须先判退役：argv `run`、headless `runPrompt`、TUI `createCommandCenter`、
   busy 输入 `sendInput`。
4. **输出与副作用**：仅输出当前语言的固定说明，退出码 1；不回显参数、不写输入历史、不创建
   app/session、不访问模型或账号服务。
5. **不影响 `/workflow`**：`disabled` 下 `/workflow` 仍由模式门禁拒绝，返回
   `WORKFLOW_DISABLED_NOTICE`；本次修复不放宽该拒绝。

## 验收场景

| 入口     | 输入                                                | 期望                               |
| -------- | --------------------------------------------------- | ---------------------------------- |
| argv     | `login` / `logout`（含 `--workflow-mode alwaysOn`） | 退出 1、固定说明、不访问依赖       |
| headless | `/login <任意参数>`、`/logout`，默认与 enabled 模式 | 退出 1、固定说明、不回显参数       |
| TUI      | 空闲提交与 busy 输入                                | 返回固定说明，不进队列、不写历史   |
| headless | `/workflow ...`，默认 `disabled`                    | 退出 1、`WORKFLOW_DISABLED_NOTICE` |

回归入口：[scripts/ci/cli-self-managed-commands.test.mjs](../../scripts/ci/cli-self-managed-commands.test.mjs)、
`apps/zcode-cli/packages/cli/tests/cli.unit.test.ts`（解析用例）、
`apps/zcode-cli/packages/cli/tests/workflow-mode-option.test.ts`（`/workflow` 与退役命令的
参数优先级）。

## 合并检查

再次同步官方源码时，如解析层重新出现 `login`/`logout` 分支，必须保证：`rawName` 判定仍
优先于任何按 `name` 分流的门禁，且不得把退役命令别名成存活命令名。不得为通过上游测试而恢复
账号/OAuth 模块。
