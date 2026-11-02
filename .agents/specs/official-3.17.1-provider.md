# 官方 3.17.1 Provider / 模型目录合并（Provider 域）

配套：`docs/specs/official-3.17.1-integration.md`（总授权与范围）。
写域：`config/provider/**`、`packages/provider/**`、`packages/provider-node/**`。

## 1. 来源核验结论（先于实现）

核验对象：`refs/upstream-tags/v3.17.1` = `zai-org/ZCode@a60ba6a7`；本仓基线 `4ea45367`；merge base `872ad960`（3.16.2 线）。

| 事实                                                                                                                                                                                                                                        | 证据                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 目录三方序号：base 30 / ours 32 / theirs 43                                                                                                                                                                                                 | `git show :1/:2/:3:config/provider/zcode-builtin.json`                                                                                                         |
| 上游 13 个 revision 的内容变化集中在：模板新增 14 条（全 `api-key`）、模型匹配正则统一简化（`(?:[.\-:/\[].*)?` → `.*`）、默认 `modelRules[".*"]` 放宽到 contextWindow 1000000 / maxOutputTokens 128000、新增 2 个 `account:*highspeed-card` | `git diff :1:… :3:…` + `.run-logs/provider-domain/analyze.mjs` 报告                                                                                            |
| 上游把「远端 Release 下载 + Active/LKG 缓存」做进 Source：新增 `zcode-builtin-download.ts`、`zcode-builtin-remote-synchronizer.ts`、`zcode-builtin-cache-paths.ts`、`endpoint-scoped-zcode-builtin-source.ts`                               | `git ls-tree -r refs/upstream-tags/v3.17.1 packages/provider-node/src`                                                                                         |
| 这 4 个文件在本仓既不在 index 也不在工作树，属全局保留删除；工作树内除 `scripts/architecture/upstream-snapshot.json` 清单外无任何引用                                                                                                       | `git grep -n "zcode-builtin-download\|zcode-builtin-remote-synchronizer\|zcode-builtin-cache-paths\|endpoint-scoped-zcode-builtin-source\|applyRemoteRelease"` |
| 本仓既有测试已把「只读随包、不信任旧下载缓存、同序号换内容必须失效」钉成契约                                                                                                                                                                | `scripts/ci/bundled-provider-config.test.mjs`                                                                                                                  |
| 本仓审计守卫要求目录内 0 个 `zhipu-account` / `account:` Provider 与 0 条账号模型规则                                                                                                                                                       | `scripts/ci/audit-boundaries.test.mjs`                                                                                                                         |

结论：本域「吸收上游」的含义是吸收 **目录数据与模型解析修复**，不吸收 **官方目录下载链路**。下载链路属于持续剥离项（官方更新源/官方云资源/自动下载）。

## 2. 所有者与状态边界

```text
随包资源 resources/config/provider/zcode-builtin.json（只读，构建期唯一来源）
        └─ materializeZCodeBuiltinProviderConfig（唯一写入者，写 <envConfigRoot>/runtime/provider/bundled/）
                    └─ NodeZCodeBuiltinProviderConfigSource（只读 + 监听，无第二来源、无 Active/LKG）
                              └─ ProviderConfigService（builtin 层）+ NodePersonalProviderConfigRepository（个人层，唯一写入用户选择）
                                        └─ ProviderConfigResolver（overlay：builtin 模板 → 个人 Provider → 个人模板引用）
```

- 个人选择只有一个所有者：`personal-provider-config-repository.ts`。本轮不新增第二份选择事实，也不把旧的官方账号选择迁移进个人层：`personalProviderConfigRuleSchema` 继续拒绝 `account:` 前缀 Provider 自带 `access`（`rule-data-schema.ts`），`providerRules` 恒由内置层声明。
- `importLegacy` 仍是调用方显式注入的可选回调，本域不提供任何默认「读官方历史选择」的实现。
- Source 只可能读一个路径；内容身份继续写入 `revision`（`zcode-builtin:<序号>:<来源 key>:<内容 sha256>`），上游改用「Active 路径做 key」的做法不吸收，因为我们没有 Active 路径，序号也不足以区分同序号内容。

## 3. 合并决策（逐项）

| 上游变化                                                                                                                                             | 处置                                  | 依据                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 14 个新 `api-key` 模板 + 既有模板的模型列表扩充（kimi-code、tencent-tokenhub、volcengine、stepfun、siliconflow、qwen token plan、minimax m-plan 等） | 吸收                                  | 用户自带 Key 目录，属授权范围                                                                                                                                                                                                 |
| 模型匹配正则统一简化                                                                                                                                 | 吸收                                  | 与 `legacy-reasoning-level*.ts` 的 `simplifiedModelMatch` 配套，缺一项会让历史推理档位别名失配                                                                                                                                |
| `modelRules[".*"]` 默认放宽（1M 窗口 / 128k 输出）                                                                                                   | 吸收                                  | base 与本仓此处相同，非本仓自创修复                                                                                                                                                                                           |
| 上游退休 `minimax                                                                                                                                    | MiniMax-M2.1`、`M2.1-highspeed`、`M2` | 吸收（不恢复）                                                                                                                                                                                                                | 上游目录事实，本仓无相反修复 |
| `account:zai-highspeed-card`、`account:bigmodel-highspeed-card` 及其 30 条 `builtinProviderModelRules`                                               | 剥离                                  | 官方账号权益入口；本仓 `providerRules` 恒空                                                                                                                                                                                   |
| `providerSiteRules` 里 3 条新增 `zcode.z.ai` 匹配规则                                                                                                | 保留                                  | 只是能力描述、不出网；本仓既有实现同样保留 base 的 3 条同类规则。模板 `api.baseUrl` 层面的官方 relay 必须为 0（测试钉住）                                                                                                     |
| `zhipuAccountModeDataSchema` 增 `highspeed`                                                                                                          | 保留                                  | 与 `completeZhipuAccountAccessDataSchema.mode` 同源，缺值会让既有个人配置解析失败；不产生任何产品入口（目录内已无账号 Provider）                                                                                              |
| `account-provider-resolution.ts` 权益继承修复                                                                                                        | 保留合并结果                          | 纯派生状态修复：母体 unknown 不再被派生入口判成无权益；不恢复官方登录                                                                                                                                                         |
| `resolver.ts` 迁移缺 logo 补齐                                                                                                                       | 保留合并结果                          | 只补展示素材，不改认证/请求行为                                                                                                                                                                                               |
| Source 的 `applyRemoteRelease`、Active 物化、`mkdir` 写入、`withFileLock` 缓存                                                                       | 不吸收                                | 属于官方下载链路的第二写入路径                                                                                                                                                                                                |
| Source 的「随包文件运行中被清理 → ENOENT 死循环」修复                                                                                                | 吸收并改造                            | 本仓同样把随包目录物化到 `<envConfigRoot>/runtime/provider/bundled`，同一失效模式成立；改造为进程内只读基线缓存（模块级 Map，按解析路径），仅在 ENOENT 时兜底，内容损坏/Schema 不兼容继续抛错                                 |
| 监听目录缺失                                                                                                                                         | 吸收为「挂载失败降级为不监听」        | 本仓不在读取路径创建目录，保持 Source 只读                                                                                                                                                                                    |
| `config/provider/zcode-builtin.test.json`（上游新增，含 10 个 `account:*` 与官方 relay 端点）                                                        | 不落地，保持删除                      | 用户裁定：本仓维持单一来源 `zcode-builtin.json`（HEAD 即是），不正式接受双目录镜像。上游把 `ZCODE_ENV` 双目录写回 `scripts/`、`turbo.json`、`packages/desktop`，由主代理按第 5 节收口；本域测试已把「该文件不存在」钉为不变量 |
| `config/provider/regression/*`、`packages/provider/test/provider-config-fixtures.ts`（上游新增）                                                     | 原样保留                              | 回归夹具只做 `api-key` 模板引用，无账号/官方端点；夹具本身暂无本仓消费者，`pnpm knip` 结果由主代理判定                                                                                                                        |

## 4. 目录合并的机械过程

`config/provider/zcode-builtin.json` 由可重放脚本生成，不手改 8 千行 JSON：
`.run-logs/provider-domain/merge-catalog.mjs`（读 `872ad960:` / `HEAD:` / `refs/upstream-tags/v3.17.1:` 三方 blob，上游为基线，追加本仓差量，内置断言）。

- 追加式：本仓差量统一追加到对应数组末尾（模板目录为键控 Map，站点/API 规则按 `apiTypeMatch` 互斥，顺序语义等价；规则层「后者覆盖前者」不变）。
- 同一身份若上游已用简化写法覆盖（如 `mimo-v2.6-pro|flash` 的 modelRule 与 anthropic API 规则），丢弃本仓旧写法，不留两份。
- 生成两次哈希一致，已核验；条目数 templates 36 / modelRules 83 / modelApiRules 74 / providerSiteRules 67 / templateModelRules 325 / providerRules 0 / builtinProviderModelRules 0。

## 5. 跨域需求（待主代理收口）

1. `scripts/builtin-provider-config.mjs`、`apps/zcode-cli/turbo.json`、`packages/desktop/scripts/ensure-e2e-desktop-build.mjs`、`packages/desktop/src/main/desktopProviderConfig.ts`：上游把 `ZCODE_ENV` 双目录写法带回，而 `config/provider/zcode-builtin.test.json` 已按裁定不落地。这些引用必须改回单一 `zcode-builtin.json`（HEAD 语义），由主代理协调；本域不提供镜像文件。
2. 上游 14 个新模板的 `logo.key`（volcengine/stepfun/siliconflow/tencent/qwen/kimi/minimax m-plan）需要 UI 素材侧确认；缺素材只回退默认图标，不阻塞本域。
3. `packages/services`、`apps/zcode-cli` 若有对 `ZCodeBuiltinProviderConfigSnapshot` 等旧类型名的引用，本域实际导出是 `ProviderConfigLayerSnapshot`（`packages/provider`），需按当前契约适配，不恢复旧别名。

## 6. 验证

- 已执行：目录合并脚本断言（含「上游条目不丢、本仓条目不丢、账号条目为 0、模板端点无官方 relay」）；两次生成字节一致；`endpoint-audit.mjs` 列出全部 36 个模板出网端点，均为供应商自带 Key API。
- 待执行（被 `packages/shared/package.json` 未解决冲突阻塞，解决后立即可跑）：
  `packages/provider/test/builtinProviderCatalogBoundaries.test.ts`、
  `packages/provider-node/test/zcodeBuiltinProviderConfigSource.test.ts`，
  以及既有 `scripts/ci/bundled-provider-config.test.mjs`、`provider-config-menu-entry.test.mjs`、`audit-boundaries.test.mjs`、`provider-model-catalog-regression.test.mjs`。
  运行方式：项目内固定 Node 24.14.0 + `scripts/ci/source-test-runner.mjs`（HOME/TEMP 均落在 `.run-logs/project-only-validation`）。
- 未验收：真机打包后随包资源读取、SEA 资产注入路径、Windows 只读安装目录下的监听降级行为（仅以单元场景覆盖，未做安装包实测）。
