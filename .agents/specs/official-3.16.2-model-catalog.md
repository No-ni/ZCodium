# 官方 3.16.2 模型目录与目录层推理映射

## 来源与授权边界

- 唯一只读来源为官方固定 SHA `3c5b227649371507ddc4eb46ac5133afe6db1cab` 的 `config/provider/zcode-builtin.json`、Provider 公开合同及 MiMo 模板回归；不跟随 `upstream/main`，不整文件覆盖本仓配置。
- 本项只更新当前静态 Provider/CLI 目录数据、目录层能力和推理映射、对应离线测试及本 spec。产品版本、目录 release revision、Provider 身份、API Key 配置与无关 WIP 不迁移。
- 不修改 shared AppSettings / runtime protocol、services、locales、package.json、lockfile、architecture-policy、总维护记录、Office 交付及公共接缝、adapters/model wire、Google providerOptions、ToolSearch 文件。
- 不引入官方账号、登录、套餐资格、额度、购买或遥测 gate；不安装依赖、不请求真实模型、不打包、不提交推送、不派子代理。

## 当前差异与择项裁决

当前目录已包含 GLM 5.3、GPT 6 Astra / GPT 5.6、Claude 5、Grok 4.6、Kimi K3、MiniMax M3、Qwen 3.8 等模型及映射。本项不把这些既有 WIP 记为新增实现，也不恢复官方宽泛模型后缀匹配。

本次补齐固定来源中尚缺的 MiMo 2.6 目录叶子：

1. 保持 `xiaomi-mimo` templateId，展示名改为 `Xiaomi MiMo API`，模型顺序为 `mimo-v2.6-pro`、`mimo-v2.6-flash`、`mimo-v2.5-pro`、`mimo-v2.5`。原 API 地址、API Key 管理地址和 logo 不变。
2. 新增 `xiaomi-mimo-token-plan` 静态模板，展示名为 `Xiaomi MiMo Token Plan`，使用固定来源的第三方厂商 API Key endpoint，协议为 `anthropic-messages`，仅列出两个 MiMo 2.6 模型。名称中的 Token Plan 只区分 API 地址，不表示 ZCode 官方账户或引入购买/权益/额度控制面。
3. 新增 MiMo 2.6 pro/flash 通用能力规则及 Anthropic 专用推理 map，并增加两模板各两个模型的精确 enabled 规则。沿用本仓有后缀边界的正则 `.*mimo-v2\\.6-(?:pro|flash)(?:[.\\-:/\\[].*)?`，不改真实 modelId。
4. 固定来源未给 MiMo 2.6 增加专用 OpenAI/Google 传输规则，本项不推测这些运行时能力；非 Anthropic 协议继续使用现有通用映射。
5. 当前 OpenCode Go/Zen 的九个 Google-native Gemini 模型、站点作用域、输出预算和已有二档映射全部保留。固定来源没有这些 Gemini 目录叶子；它们不是本次官方吸收项。
6. `providerConfigRules.providerRules` 与 `modelConfigRules.builtinProviderModelRules` 保持空；固定来源的 `account:*` 实例和三十条账号模型启用规则不吸收。

## 数据 owner、公开接口与默认推理规则

| 事实/状态                          | 唯一 owner                                    | 本项权限                                      |
| ---------------------------------- | --------------------------------------------- | --------------------------------------------- |
| 随包静态模板、模型能力、values/map | `config/provider/zcode-builtin.json`          | 择叶更新，不另建目录或缓存                    |
| 本地读取及内容 revision            | `NodeZCodeBuiltinProviderConfigSource`        | 复用只读本地 source，release revision 不变    |
| 有效配置与个人覆盖                 | `ProviderConfigResolver` / `ModelConfigRules` | 使用现有公开入口，不复制规则引擎              |
| 可执行候选与选择校验               | `ProviderRegistry`                            | 由已校验有效配置构造，不制造资格 gate         |
| 工具目录                           | `createModelCatalogPort`                      | 每次现读 Registry 与 currentSelection，仅投影 |
| CLI picker 目录                    | `listRegistryBackedModels`                    | 同一 Registry 的另一种只读投影                |
| 新选择、辅助调用、已有选择         | 现有 completion / normalization 函数          | 不增加第二份默认值或写入路径                  |

```text
随包目录 -> 本地只读 source -> 公开 schema / ModelConfigRules
个人配置 -----------------> ProviderConfigResolver（个人覆盖最后叠加）
                          -> 同一个 ProviderRegistry
                             +-> CLI picker（values 最后一档为 defaultLevel）
                             +-> 工具目录（每次 live read，values 最后一档为默认）
                             +-> 主动新选：completeNewModelSelection，最高公开档
                             +-> 辅助调用：completeAuxiliaryRegistryModelSelection，最低公开档
                             +-> 已有选择：normalizeModelSelection，只校验，不补档
有效公开档位 -> compileModelOptionMaps -> 纯 JSON merge-patch
                                        -> 既有运行时接缝（本项只读，不改 wire）
```

规则顺序沿用通用 model -> model-api -> provider-site -> template exact -> provider exact / personal exact。只沿公开 Provider 与 model-option-map 入口解析和编译，不放宽 shared schema。

`reasoningLevel.values` 必须非空、唯一并按语义强度从低到高排列；`map` 必须能编译。默认档位是投影规则，不是新增 shared schema 字段：

- 工具目录、CLI picker、新草稿/主动选模型取 `values.at(-1)`。
- 辅助调用取 `values[0]`，保留其他选项。
- 恢复已有合法档位原样保留；缺失或非法档位只保留 providerId/modelId，不自动补最高档或改写历史选择。
- 执行前仍由现有 Registry 拒绝缺失/不支持的档位；纯 map compiler 不是枚举校验 owner。
- 工具目录的 `current` 只比较 providerId + modelId；reasoning options 不参与身份。`disabledReason` 没有事实来源时保持缺席。

## MiMo 能力与映射验收值

两个 MiMo 2.6 模型共享固定来源的目录能力：

| 项目                                  | 验收值                                                         |
| ------------------------------------- | -------------------------------------------------------------- |
| contextWindow                         | 1,000,000                                                      |
| inputFormat                           | text / image / video / audio = true，pdf = false               |
| outputFormat                          | text = true                                                    |
| reasoningLevel.values                 | `["disabled", "enabled"]`                                      |
| 主动新选 / 工具目录 / CLI picker 默认 | `enabled`                                                      |
| 辅助调用默认                          | `disabled`                                                     |
| maxOutputTokens.max                   | 131,072                                                        |
| Anthropic disabled map                | `thinking.type = "disabled"`                                   |
| Anthropic enabled map                 | `thinking.type = "enabled"`，不是通用 adaptive / output_config |
| 输出预算 map                          | `max_tokens = 请求值`                                          |

旧 MiMo 2.5 pro 仍不声明 image/video/audio，2.5 仍声明这三项；旧模型、个人 Provider 名称/ID/API Key/baseUrl、disabled 与个人精确模型覆盖保持不变。不自动将旧实例换为 Token Plan 模板，也不改个人配置磁盘内容。

## 失败语义与迁移边界

- 不可编译 map、重复/空 values、缺失能力继续由现有 schema / 完整 Registry 配置证明拒绝，不通过兜底分支修绿。
- 新模型 regex 不匹配 `mimo-v2.6-profile` / `mimo-v2.6-flashlight` 等无合法边界的近似 ID；保留合法 vendor 前缀、大小写及现有日期/修订后缀语义。
- 个人 API 地址仍由用户覆盖；URL normalization、站点/API 限制和 personal overlay 顺序不变。
- 所有新增模板仍需用户显式创建 API Key Provider；无 Key 不进入可执行 Registry。无 account source 也可正常解析有效自带 Key Provider。
- bundled source 使用既有内容签名检测同 revision 的数据变化，不修改版本 pin 或旧配置迁移逻辑。

## 离线验收场景

测试先于配置实现添加，并在旧目录上确认新增叶子断言失败；测试不依赖上游工作区在运行机器上存在。

1. 两 MiMo 模板字段、modelId 顺序、旧 2.5 保留、四条精确启用规则及账号数组为空。
2. 从真实 bundled source / 公开 schema 解析，两个新模型完整能力和每个公开档位的纯 map 输出正确；预算请求值从最小值到目录上限原样映射，不污染输入对象。
3. 新模型 Anthropic map 替代 adaptive；错误 API 类型不误用此专用 map，近似 modelId 不误匹配。
4. 合成 API Key Provider 经真实 Resolver / Registry 可用，不读账号事实；缺 Key 不可执行，个人名称、地址、disabled、模型顺序/禁用及推理值域覆盖保留，解析不修改输入。
5. 真实 CLI picker 与工具目录、新选/辅助默认/已有选择恢复三种路径一致；非法或缺失档位拒绝，不静默改档。
6. 同一 modelId 在两个 Provider 中只标记精确 current；换选择、Registry replace 后目录现读；返回的 reasoningLevels 可写副本不污染 Registry。
7. 既有代表模型的公开 values / 默认 / API map 回归，以及九个 Gemini 模型与精确 OpenCode Google 站点预算保留。
8. 新测试与既有 bundled-provider-config、cli-local-provider 等相关离线回归实际执行；测试拦截 `fetch` 并要求调用数为零，不访问真实用户配置。
9. 执行根与 CLI typecheck / lint、changed architecture、限定文件格式与 diff 检查。并发 WIP 的范围外失败如实记录，不越权修复。

不把目录/schema/mock 回归等同于真实模型可用性、Google wire 编码、桌面/手机 GUI、完整远控链、安装或发行验收。

## 未接运行时接缝

本项只交付目录数据与公开 map。Gemini 当前最低公开档 `disabled` 省略 `generationConfig.thinkingConfig`，最高公开档 / 新选择默认 `enabled` 生成 `thinkingLevel: "high"` / `includeThoughts: true`，输出预算位于 `generationConfig.maxOutputTokens`。`disabled` 只表示不主动注入增强思考参数，不承诺远端关闭思考。

只读核对的精确运行时接缝：

- `apps/zcode-cli/packages/adapters/src/model/model-execution.ts`：`AiSdkModelExecution.bindModel` 编译目录 map；`resolveSnapshot` / `createFactory` 将冻结的请求选项交给 option-map fetch；Google 分支的 `createGoogleGenerativeAI({ baseURL, fetch: optionFetch, ... })` 复用用户地址。
- `apps/zcode-cli/packages/adapters/src/model/model-option-map-fetch.ts`：`createModelOptionMapFetch` 读取 SDK 已编码的 JSON body，调用 `maps.apply(body, values)` 后传入底层 fetch；这是 `generationConfig.thinkingConfig` / `generationConfig.maxOutputTokens` 最终合并的传输接缝。
- 同一 `model-execution.ts` 的 `toAiSdkProviderConfig` 保留 API format / Google kind；本项不增加或转换 Google providerOptions。

当前目录 map 已与这条原始 JSON patch 合同一致，本项没有确认到需要新增 Gemini 运行时转换的缺口。若主线程调整 thinkingLevel / thinkingBudget 或 Google providerOptions，应在上述 binding / raw-body 接缝做 mock 编码验收，不能从目录 map 通过推断 SDK / 远端验收。MiMo 2.6 的新专用 map 同样只通过既有 Anthropic binding / option-map fetch 消费，不另建运行时路径。本代理未修改任何上述文件。

## 续接聚合测试隔离

- 两个根 CI 入口在独立子进程运行原目录与投影断言，真实用例分别为 9 与 5 项；所有断言、离线 `fetch` 拒绝及零调用验收保持。测试本体放在非自动发现的 `scripts/ci/fixtures`，相对路径从实际新目录解析。
- `fetch` mock 的生命周期仅属于目录测试子进程，不能在根 `--test-isolation=none` 套件中拦截其他文件的合法 loopback HTTP；不移除离线守卫，不给目录请求添加网络放行，也不修改产品 Provider source。
- 根入口使用既有 `runSourceTests` 等待退出并验证精确测试数量。子进程非零退出、缺文件或未执行断言一律传播失败，不能把导入成功当作通过。

## 实际验证记录

- 开工与续接 freshness：通过；HEAD 无远端 tracking 分支，跳过 behind-remote 检查；相对 origin/main ahead 31 / behind 0。
- 授权 worktree HEAD `18cc72cef7bec53eaa543b515e0c9332bc9cd05b`；官方只读 HEAD 已核对为上述固定 SHA。
- 实施前 `corepack pnpm architecture:check --changed`：0 violations / baseline 0 / new 0。
- 已读取 `architecture:context provider` 与 `architecture:context zcode-cli`。两者为现有 unmanaged module，不通过本项修改架构策略登记新边界；只复用既有公开合同。
- 实际 Node 24.18.0，mise 指定 24.14.0；corepack pnpm 10.33.2。未安装或修改工具链。
- 先失败回归：`node --test scripts/ci/bundled-model-catalog.test.mjs` 在旧配置上实际为 12 tests / 5 pass / 7 fail，失败指向缺失 MiMo 2.6 模板、能力/映射与目录条目；既有 MiMo/Gemini/代表模型保留用例通过。
- 新回归按职责拆为 `scripts/ci/bundled-model-catalog.test.mjs`（目录/schema/覆盖）、`scripts/ci/bundled-model-catalog-projection.test.mjs`（公开默认/投影/Gemini 保留）及 `scripts/ci/fixtures/bundled-model-catalog.mjs`（只读 public 入口与离线 fixture）。所有自有源码文件保持少于 400 行。没有修改 package.json 注册新命令。
- 实现后的实际命令 `node --test scripts/ci/bundled-model-catalog.test.mjs scripts/ci/bundled-model-catalog-projection.test.mjs scripts/ci/bundled-provider-config.test.mjs scripts/ci/cli-local-provider.test.mjs scripts/ci/local-provider-runtime.test.mjs`：25 tests / 25 pass / 0 fail / 0 skipped；其中新增目录回归 14 项、既有离线回归 11 项。新增 fixture 拦截 fetch，实际调用数为零。
- 对固定来源做只读 JSON 叶子比较：两 MiMo template 完全一致，MiMo 2.6 能力 config 与 Anthropic map 完全一致；modelMatch 故意保持本仓后缀边界。全部 23 个当前模板 / 255 个声明模型（含重复 ID 与 disabled 项）的完整配置与每个公开档位 map 离线校验通过，不表示 255 个远端模型可用。
- 根 `corepack pnpm typecheck` 两次均 exit 0；根 `corepack pnpm lint` 两次均 exit 0。首次 0 warnings / 0 errors；最后复验 4 warnings / 0 errors，范围外 `packages/ui/src/v4/WorkbenchPane.tsx` 的 unused hidden 及 `scripts/ci/workspace-alias.test.mjs` 的三个 unused imports。最后快照优先，不为本项清理并发 WIP。
- CLI `corepack pnpm --dir apps/zcode-cli typecheck`：exit 2。范围外 `apps/zcode-cli/packages/core/src/tool/executor/tool-search-display.ts` 缺少 `TOOL_SEARCH_DISPLAY_MAX_MATCHES`、`TOOL_SEARCH_DISPLAY_MAX_NAME_BYTES`、`TOOL_SEARCH_DISPLAY_MAX_QUERY_BYTES`、`ToolSearchToolResultDisplayPayload` 四个 contracts 导出。该次 adapters typecheck 已 Done；未修改 ToolSearch 或 contracts 来修复门禁。
- CLI `corepack pnpm --dir apps/zcode-cli lint`：exit 1，65 warnings / 79 errors，主要为既有 CLI max-lines；均不在本项五个交付文件。未修改这些文件或更新 baseline。
- 新测试/fixture 的 scoped oxlint：exit 0，0 warnings / 0 errors；五个交付文件 scoped oxfmt、`git diff --check -- config/provider/zcode-builtin.json` 与 changed architecture 均实际通过，architecture 0 violations / baseline 0 / new 0。
- 本项配置增量为 +85 / -3 行（净 +82），其他配置删除属于开工前 WIP。产品版本与 revision 32 保持不变；没有修改 Provider/CLI 运行时源码、Office 或公共接缝。
- 校验曾由已有 CLI typecheck 脚本构建 TUI/生成类型库；这是仓库规定的检查入口，不是产品打包。本项未执行安装、市场注册、真实模型请求、发行构建、commit/push 或子代理。
- 未验证：MiMo/Gemini 真实 API 请求、Google providerOptions / SDK wire mock 编码、桌面/手机 GUI、完整远控链、真实 SEA/prepare/安装/发行。既有 SEA 合成 fixture 通过不等于产品 SEA 构建验收。
