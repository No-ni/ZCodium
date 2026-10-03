# 上游能力对账（扩大范围）

> 本文是 [upstream-i18n-parity.md](upstream-i18n-parity.md) 的**范围扩展版**。
> 上一份只对了一个维度——`packages/ui/src/i18n/locales/zh-CN.ts` 与官方安装包语言表的键差集。README 的
> 「与官方包的能力差异」声明的补全手段有三类：**内置插件与技能、i18n 键、协议与设置 schema 交互链路**。
> 本文把后两类补齐，并加入文件级清单核对。

基准：上游 `v3.14.3`（`c90e702`，本地 tag 可用），底稿为官方 3.14.3 安装包。

## 范围与方法

| 维度             | 方法                                                                                                                                 | 之前是否查过            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| i18n · zh-CN     | locale 表 vs 官方 zh 表键差集                                                                                                        | 查过（见另一份 spec）   |
| i18n · en-US     | locale 表 vs 官方 en 表键差集                                                                                                        | **未查**                |
| i18n · 消息源    | 全仓 `"dotted.key":` 定义点，不限于 locale 文件                                                                                      | 未查（已发现 1 例误判） |
| 协议/设置 schema | 上游 `packages/shared/src` 源码与我们的同名文件比对：`z.enum([...])` 成员、类型联合成员、`export` 符号                               | **未查**                |
| 文件级清单       | 上游 tag 与 main 逐目录 `find` 对比（含 `packages` 1629 个 `.ts`、`apps` 1785 个文件、`scripts` / `config` / `patches` / `harness`） | 只查过插件目录          |
| 插件清单         | `apps/zcode-cli/packages/` 目录差集                                                                                                  | 查过                    |
| 技能清单         | `apps/zcode-cli/packages/bundled-skills/*/SKILL.md` 差集                                                                             | 查过                    |

上游 tag 已在本地可用，可在不联网的情况下复现：

```bash
git fetch --tags upstream
git branch -f upstream-3143 v3.14.3
git archive upstream-3143 packages | tar -x -C /tmp/up2   # 或 apps / scripts / config / patches / harness
```

## 各维度结论

| 维度                  | 上游              | 我们              | 缺口  | 结论                                      |
| --------------------- | ----------------- | ----------------- | ----- | ----------------------------------------- |
| i18n zh-CN            | 6107 键           | 5474 键           | 742   | 有缺口，分类见另一份 spec                 |
| i18n en-US            | 6111 键           | 5475 键           | 745   | 有缺口，且两侧语言表本身不一致            |
| 消息源（全仓）        | —                 | —                 | 1     | 上一份 spec 的方法论缺陷，已修正          |
| 协议/设置 schema 枚举 | 5 个文件对位      | —                 | **0** | 无缺口                                    |
| 协议/设置 schema 导出 | 5 个文件对位      | —                 | **0** | 无缺口                                    |
| 文件级清单            | 1629 + 1785 + 195 | 1879 + 1869 + 195 | **0** | 无缺失文件                                |
| 插件目录              | 28                | 29                | **0** | 我们多 `visualize-plugin`（自研 UI 插件） |
| 技能清单              | 1                 | 1                 | **0** | 一致                                      |

**核心结论：上游 3.14.3 的能力缺口集中在语言表单项，不在代码结构。** 协议、schema、文件清单、插件与技能五个维度均为零缺口，`ZCODE_PROVIDERS`、`AgentPermissionMode`、`ModelProviderEndpoints`、`ModelProviderKind` 等枚举成员与上游逐一对上。

## 扩大范围后发现的问题

### 1. `settings.memory.viewer.disabled` 只有英文，没有中文（真实缺陷）

`packages/ui/src/i18n/locales/en-US.ts` 有该键，`zh-CN.ts` 没有——这是全仓唯一一个「某语言有、另一语言没有」的键。

- en 值：`Enable Workspace Memory to view saved memories.`（启用工作区记忆以查看已保存的记忆）
- 相邻键 `settings.memory.viewer.localOnly` / `.empty` / `.loading` / `.searchPlaceholder` 等中英齐备，只有它是单语
- 上游同样是单语（en 独有），我们照抄了这个不一致

**是否影响用户取决于回退逻辑**：`packages/ui/src/i18n/IntlProvider.tsx` 的 `formatMessage` 是

```ts
const messages = MESSAGES[locale] ?? MESSAGES[DEFAULT_LOCALE]!;
let msg = messages[id] ?? id;
```

**只有整表回退，没有 per-key 跨语言回退。** 因此中文用户遇到该键会原样看到 `settings.memory.viewer.disabled` 字符串。

缓解事实：该键目前**没有任何代码引用**（`MemorySettingsViewer.tsx` / `MemorySettingsSection.tsx` 用了它的多个兄弟键，唯独没用它），所以现在是死键，不产生可见 bug。但一旦有人接上「记忆未启用」的空态提示，缺陷立刻显形。

**已补中文**（2026-10-03）：`zh-CN.ts` 增加 `"settings.memory.viewer.disabled": "启用工作区记忆后即可查看已保存的记忆。"`，
位置与 en-US 一致（该块首行）。补完两张表各 5475 键、无任何单边键。取「补」而非「删」的理由：
该键所属的记忆查看器是活功能（`localOnly` / `empty` / `loading` 等兄弟键均在用），删掉后上游若接上
该空态，我们还要再补一次。

### 2. 官方 zh / en 两张表本身不一致（上游问题，我们被动继承）

上游 en 表有 4 个键在 zh 表里没有：

- `manualClaimPlan.banner.period.daily`
- `manualClaimPlan.banner.period.oneTime`
- `manualClaimPlan.banner.bonus`
- `settings.memory.viewer.disabled`

所以 en 缺口 745 比 zh 缺口 742 多 3——差的正是那 3 个 `manualClaimPlan` 键。这三者都在「有意不补全」的 `manualClaimPlan` 域内，不额外产生工作。

### 3. `botsBridgeServer.ts` 少两个 export（无害）

上游 `packages/desktop/src/host/botsBridgeServer.ts` 导出 `BotsBridgeServicePort` 与 `BotsBridgeServerOptions`；我们同名文件把这两个 `interface` 声明为**不导出**。

已确认两处：本文件内自用，全仓无外部引用者。因此不影响构建与运行；相反，导出反而会被 knip 记为未用导出。**无需处理**，仅记录差异。

## 与另一份 spec 的分工

|          | upstream-i18n-parity.md                       | 本文                             |
| -------- | --------------------------------------------- | -------------------------------- |
| 范围     | 仅 zh-CN 语言表键差集，逐键分类与功能工作清单 | 全部七个维度，含源码级清单核对   |
| 缺口归因 | 到键、到功能工作项                            | 到维度；结论是缺口几乎只在语言表 |

## 待办

- ~~决定 `settings.memory.viewer.disabled` 补中文还是删除~~ 已补中文（2026-10-03）。
- 上游升级到 3.14.4+ 时需重跑本文各维度：tag `v3.14.4` 已在本地，注意本仓库当前仍基于 3.14.3。
- W6「任务菜单前往配置」已出 spec：[provider-config-menu-entry.md](provider-config-menu-entry.md)。
  核对方法：全量解包官方 `app.asar`（27057 文件）后查键引用，`appHeader` 域 8 个键中仅
  `goToProviderConfig` 被代码引用，其余 7 个是上游死键。
- 文件级清单为「有无」比对，未做逐文件内容 diff；若需要内容级一致性，可在 `git diff upstream-3143 main -- packages` 基础上排除本 fork 自研目录后复查。
