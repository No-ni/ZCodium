# 模型选择回归夹具契约（test-only）

状态：夹具适配契约。本文只约束两份 CI 回归测试如何装载现行产品契约，不新增、不改变任何产品行为。产品事实以现行源码与本节引用的 spec 为准；旧夹具（缺 `modelSelectionState` 注入、用同步 `runSqliteSessionMigrations` 建库）是对已演化契约的过期假设，修的是测试，不是产品。

## 适用范围

- `scripts/ci/local-context.test.mjs` — 以 `scripts/ci/fixtures/component-callback.mjs` 的 `loadComponentCallback` 真实执行 `packages/ui/src/v4/composer/V4ComposerToolbar.tsx` 中的 `handleModelValueChange`。
- `scripts/ci/session-model-selection-repair.test.mjs` — 以真实 SQLite fixture 验证模型选择落盘 upsert 与迁移 `0023_repair_invalid_model_selection` 的自愈语义。
- 夹具装载器本身（`loadComponentCallback`）契约不变：把 useCallback 函数体经 TS 转译后用 `new Function(...自由变量)` 注入边界依赖。

## 现行产品契约（夹具必须对齐的事实）

### UI：handleModelValueChange 的单一 owner 与门控

```text
useModelSelectionView（状态 owner）
  → ConversationComposer（props 传递，不复制第二份状态）
    → V4ComposerToolbar.handleModelValueChange（只读 status 门控）
        status !== "ready" → 立即 return（无 onSelectModel、无 recovery、无 recoveryPending）
        status === "ready" 且 configOptionsError 且解码 providerId 命中目录且 access.type === "api-key" 且存在 onRecoverCustomModelSelection
          → setRecoveryPending(true) → onRecoverCustomModelSelection(value, sourceModel) → finally setRecoveryPending(false)，不走 onSelectModel
        其余 ready 情形 → decodeCustomModelValue / "provider/model" 拆分 / 裸 model 回落 → onSelectModel(providerId, modelId, sourceModel)
```

- `modelSelectionState: ModelSelectionState`（`packages/ui/src/hooks/useModelSelectionView.ts`）为判别联合：`loading`（可带 `catalog`）、`ready`、`unavailable`（`reason: "remote-waiting" | "missing-target"`）、`error`。选择事实仍由 Composer owner 持久化，工具条不保持有第二份选择状态。
- 回调的闭包自由变量集合以现行函数体为准；夹具的依赖注入必须与它一一对应（`modelSelectionState` 是演化后新增的自由变量，缺失时夹具应报 `ReferenceError` 而非静默通过——这是夹具失败，不是产品缺陷）。
- 验收：ready + custom api-key recovery 断言（source identity 透传、`onSelectModel` 不被调用、pending 先 true 后 false）与 ready 正常选择断言不得削弱；新增非 ready（loading/error/unavailable）门控断言只验证「无副作用」，不引入新产品能力。

### 存储：迁移唯一 owner

- 会话库迁移的唯一 owner 是 `runSqliteSessionMigrationsAsync`（由 `SqliteSessionStore.openStartup` 调度；`apps/zcode-cli/packages/adapters/src/storage/session-store/migration-runner.ts`）。
- `runSqliteSessionMigrations` 是兼容旧 constructor 的只读 ready 检查：存在 pending 迁移时抛 `SqliteSessionMigrationError`。它不是第二迁移路径；旧夹具「同步函数直接建库」的假设已失效。
- 夹具建库必须走异步链（sandbox temp 内的真实 db 文件，含 backup 目录与 WAL），随后继续用真实仓储 `saveSessionEntry`/`sessionEntries` 与迁移清单中的 `0023_repair_invalid_model_selection.sql` 原文断言：
  - 损坏 JSON 行不再令 upsert 抛错：坏行走 `else` 分支被新值覆盖（`json_valid`/`json_type` 守卫在 `repositories/session-entries.ts`）。
  - 0023 把非法选择行改写为 `{ modelSelection: null }`，合法行保持原选择。
- 不恢复旧的 `configOptionsError` 之外的错误逻辑，不为测试改动产品迁移清单。

## 运行边界

- 两份测试在中央 sandbox（`scripts/ci/project-test-sandbox.mjs`）内运行；可通过 `scripts/ci/source-test-runner.mjs` 的 `runSourceTests` 或已审查的项目内验证运行器启动固定 Node `--test --import tsx`。现有 Desktop CI 的 Release tests 自动发现入口保持不变。
- 夹具临时库只写 `os.tmpdir()`，由 sandbox 环境变量重定向到 sandbox `temp/`；`NODE_OPTIONS` 写白名单保证越界即失败。禁止真实用户目录、真实 `.zcodium` 或系统临时目录。
- 红绿口径：修复前两文件 4 项，1 通过、3 失败（`modelSelectionState is not defined` 与两处 `SqliteSessionMigrationError`）；修复后含新增门控共 5 项，全部通过。主线程最后按各 CI 入口独立复跑为 3/3 与 2/2。
