# 上游语言表对账与缺口分类

> 本文件是 README「与官方包的能力差异」一节的明细底稿。README 只给结论数字；全部键、判定依据与复现方法在此。
> 数字以官方 `3.14.3` 安装包为基准。上游小版本更新后需重新核对（见「核对方法」）。

## 核对方法

底稿（均在仓库/缓存内，无需联网）：

- `official-builds/ZCode-3.14.3-win-x64.exe`（README 声明的核对底稿）
- `~/.cache/official-zcode/deb314/opt/ZCode/resources/app.asar`

提取与对比：

```bash
# 1) 从官方 asar 取出打包后的语言表
asar=<官方 app.asar 路径>
node_modules/.bin/asar list "$asar" | grep IntlProvider
node_modules/.bin/asar extract-file "$asar" out/renderer/assets/IntlProvider-DW5rmeLm.js

# 2) 抓键
#    官方侧：从 var p={ 起做括号配平截出 zh-CN 表（约 312 KB），
#            匹配  "dotted.key":`value`  形式的键（minify 后无反引号键名）。
#    仓库侧：packages/ui/src/i18n/locales/zh-CN.ts 中两空格缩进的 "dotted.key": 行。
#            其余以引号开头的行是换行译文的续行，不是键，必须排除。
```

两个必须注意的坑：

1. 官方 bundle 里同时含 `zh-CN` 与 `en-US` 两张表，键集几乎一致。**必须同语言对比**；
   对整份 bundle 取并集会得到虚高缺口（实测并集 6111 键会误报 746，同语言实为 742）。
2. 仓库侧 locale 是 TS 扁平字符串表而非 JSON，且存在译文折行；按 JSON/正则粗抓会漏 415 个续行、误判 10 个键。

实测结果：

|                  | 键数 |
| ---------------- | ---- |
| 官方 zh-CN 表    | 6107 |
| 本仓库 zh-CN     | 5475 |
| 官方有、我们没有 | 742  |
| 我们有、官方没有 | 110  |

## 缺口总览

|

组

|

键
数

|

含
义

|

|

-
-
-

|

-
-
-

|

-
-
-

|

|

-
- 有
  意
  不
  补
  全
-
-

|

6
7
8

|

依
赖
官
方
账
号
/
服
务
端
，
或
上
游
产
品
策
略
差
异
；
实
现
前
提
在
本

f
o
r
k

不
存
在

|

|

-
- 需
  功
  能
  开
  发
-
-

|

5
4

|

键
与
功
能
对
应
，
需
按

s
p
e
c

开
发
；
其
中

W
1

端
点

9

键
与

W
1
0

业
务
错
误
码

1
1

键
判
定
不
做

|

|

-
- 上
  游
  未
  接
  线
-
-

|

7

|

官
方
语
言
表
有
定
义
但
无
任
何
调
用
点
，
属
上
游
死
键
，
不
补

|

|

-
- 已
  删
  功
  能
  遗
  留
-
-

|

2

|

上
游
删
除
远
端

C
D
N

拉
取
后
语
言
表
残
留
，
无
需
处
理

|

|

合
计

|

7
4
1

|

另
有

1

个
键
定
义
在

`d
e
s
k
t
o
p
M
e
n
u
.
t
s`

而
非

l
o
c
a
l
e

表
，
不
构
成
缺
口

|

> 修正记录：本文件初版按「键名/域」把 159 键归为「纯客户端可补全」，逐键核对功能存在性后推翻。
> 其中 `settings` 91 键里真正属本地配置的只有 24 键，其余是计费（`codingPlan.*` 21、`startPlan.*` 8、
> `planCard.*` 2）或依赖不复用结构（端点 9 键对应已废弃的三端点模型）。**域级分类不足以判定，
> 必须逐个键到代码里确认功能是否存在。**

反向多出的 110 键（我们有、官方没有）主要来自本仓库自研内容：`genUi` 21、`conversationShare` 19、`pluginUi` 14、`settings` 13、`webRemoteControl` 13、`bots` 12——与 AstrBot 桥接、UI 插件 / Gen UI 移植、`.zcodium` 命名空间相符，属预期差异。

---

# A 组：需功能开发（54 键）——原「A 组可补全」

初版曾把这一组标为「纯客户端，可以且应当补全」。逐键核对后发现**几乎没有一条是纯 i18n 补丁**：
每一条背后都是一个待开发功能，或一个需要推翻的现有结构。本节保留误判证据，可执行清单见文末。

#### `settings` — 91 键

本仓库已有 574 个 `settings.modelProvider.*` 键与完整设置界面（`ModelConfigSelect.tsx` 等），缺的是上游后增的条目：模型 I/O 保留策略、Anthropic/OpenAI/Gemini 端点模板、Claude 模型槽位映射。**功能在位，属未跟进的新增项。**

| 键                                                            | 官方 zh-CN 译文                                                                    |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `settings.modelIoFullRetention`                               | 完整保留模型 I/O                                                                   |
| `settings.modelIoFullRetentionDescription`                    | 保留完整的模型请求和响应，不自动压缩、限制大小或删除旧记录。                       |
| `settings.modelProvider.anthropicEndpoint`                    | Anthropic 接口地址                                                                 |
| `settings.modelProvider.anthropicEndpointPlaceholder`         | 如：https://open.bigmodel.cn/api/anthropic                                         |
| `settings.modelProvider.claudeMapping`                        | Claude 模型映射                                                                    |
| `settings.modelProvider.claudeMappingDescription`             | 为 Claude 的各模型槽位选择对应的模型                                               |
| `settings.modelProvider.codingPlan.bigmodel.registerAction`   | 去注册                                                                             |
| `settings.modelProvider.codingPlan.bigmodel.unregisteredHint` | 该 BigModel 账号尚未注册，请先完成注册。                                           |
| `settings.modelProvider.codingPlan.billingDiscountInfo.open`  | 查看 150% 配额活动说明                                                             |
| `settings.modelProvider.codingPlan.connect`                   | 连接 {provider}                                                                    |
| `settings.modelProvider.codingPlan.disconnect`                | 解绑                                                                               |
| `settings.modelProvider.codingPlan.expiresAt`                 | 到期 {date}                                                                        |
| `settings.modelProvider.codingPlan.renewsAt`                  | 续费 {date}                                                                        |
| `settings.modelProvider.codingPlan.status.checking`           | 查询中                                                                             |
| `settings.modelProvider.codingPlan.status.disconnected`       | 未连接                                                                             |
| `settings.modelProvider.codingPlan.status.notPurchased`       | 未开通，开通后启用                                                                 |
| `settings.modelProvider.codingPlan.status.purchased`          | 已开通                                                                             |
| `settings.modelProvider.codingPlan.status.teamUnavailable`    | 团队套餐未分配，请联系团队管理员。                                                 |
| `settings.modelProvider.codingPlan.status.unavailable`        | 获取失败                                                                           |
| `settings.modelProvider.codingPlan.status.unsupported`        | 暂未支持                                                                           |
| `settings.modelProvider.codingPlan.webview.authInjectFailed`  | 无法登录到套餐页，请重试。                                                         |
| `settings.modelProvider.codingPlan.webview.loadFailed`        | 套餐页加载失败。                                                                   |
| `settings.modelProvider.codingPlan.webview.openWebsite`       | 前往官网购买                                                                       |
| `settings.modelProvider.codingPlan.webview.retry`             | 重试                                                                               |
| `settings.modelProvider.codingPlan.webview.title`             | 升级套餐                                                                           |
| `settings.modelProvider.endpointNoMatch`                      | 没有匹配的接口地址                                                                 |
| `settings.modelProvider.geminiEndpoint`                       | Gemini 接口地址                                                                    |
| `settings.modelProvider.geminiEndpointPlaceholder`            | 如：https://generativelanguage.googleapis.com                                      |
| `settings.modelProvider.mappingNotSet`                        | 未设置                                                                             |
| `settings.modelProvider.openaiEndpoint`                       | OpenAI 接口地址                                                                    |
| `settings.modelProvider.openaiEndpointPlaceholder`            | 如：https://api.openai.com/v1                                                      |
| `settings.modelProvider.planCard.codingPlan`                  | 编程套餐                                                                           |
| `settings.modelProvider.planCard.startPlan`                   | 体验套餐                                                                           |
| `settings.modelProvider.planCard.usage.totalTokens`           | Token 总量                                                                         |
| `settings.modelProvider.presetEmpty`                          | 尚未同步，请先完成 OAuth 登录。                                                    |
| `settings.modelProvider.slot.haiku`                           | Haiku（轻量任务）                                                                  |
| `settings.modelProvider.slot.opus`                            | Opus（复杂任务）                                                                   |
| `settings.modelProvider.slot.reasoning`                       | Reasoning（推理任务）                                                              |
| `settings.modelProvider.slot.sonnet`                          | Sonnet（常规任务）                                                                 |
| `settings.modelProvider.startPlan.balance.title`              | 今日余额                                                                           |
| `settings.modelProvider.startPlan.expiresAt`                  | 过期时间 {date}                                                                    |
| `settings.modelProvider.startPlan.login`                      | 登录                                                                               |
| `settings.modelProvider.startPlan.pendingUntil`               | 待生效 {date}                                                                      |
| `settings.modelProvider.startPlan.refreshEntitlement`         | 刷新权益                                                                           |
| `settings.modelProvider.startPlan.status.expired`             | 体验套餐已过期                                                                     |
| `settings.modelProvider.startPlan.status.loginRequired`       | 登录后查看和使用体验套餐                                                           |
| `settings.modelProvider.startPlan.status.noPlan`              | 暂无可用体验套餐                                                                   |
| `settings.plugins.marketplace.claudeCodePlugins`              | Claude Code 插件                                                                   |
| `settings.plugins.marketplaces.refreshCatalogHint`            | 刷新以加载官方目录。                                                               |
| `settings.plugins.zcodeOnly`                                  | 仅支持 ZCode Agent                                                                 |
| `settings.skills.agent.common`                                | 通用                                                                               |
| `settings.skills.agent.glm`                                   | ZCode Agent                                                                        |
| `settings.skills.agent.unknown`                               | 未知来源                                                                           |
| `settings.subagents.permissionMode.acceptEdits`               | 接受编辑                                                                           |
| `settings.subagents.permissionMode.bypassPermissions`         | 绕过权限                                                                           |
| `settings.subagents.permissionMode.default`                   | 默认                                                                               |
| `settings.subagents.permissionMode.dontAsk`                   | 不询问                                                                             |
| `settings.usage.activityTitle`                                | 活跃度                                                                             |
| `settings.usage.averageDailyCredits`                          | 日均积分                                                                           |
| `settings.usage.cacheHitRate`                                 | Cache 命中率                                                                       |
| `settings.usage.codingPlanCurrentConnectionDescription`       | 将当前工作区模型连接方式切换为个人套餐或团队套餐后，即可在这里查看对应额度和用量。 |
| `settings.usage.codingPlanCurrentConnectionTitle`             | 当前连接方式未使用编程套餐                                                         |
| `settings.usage.codingPlanLegendTotal`                        | 消耗总量                                                                           |
| `settings.usage.codingPlanLoadingDescription`                 | 正在读取当前供应商 monitor 接口，可能需要一点时间。                                |
| `settings.usage.codingPlanMetric.credits`                     | 积分消耗                                                                           |
| `settings.usage.codingPlanMetric.usage`                       | 用量消耗                                                                           |
| `settings.usage.codingPlanRange.30d`                          | 近 30 日                                                                           |
| `settings.usage.codingPlanRange.7d`                           | 近 7 日                                                                            |
| `settings.usage.codingPlanRange.custom`                       | 自定义                                                                             |
| `settings.usage.codingPlanRange.today`                        | 当日                                                                               |
| `settings.usage.codingPlanSubject.model`                      | 模型                                                                               |
| `settings.usage.codingPlanSubject.tool`                       | 工具                                                                               |
| `settings.usage.creditUnit`                                   | 积分                                                                               |
| `settings.usage.creditsTotal`                                 | 积分总数                                                                           |
| `settings.usage.entitlementFiveHourUsage`                     | 5 小时剩余                                                                         |
| `settings.usage.entitlementMonthlyMcpUsage`                   | 工具调用                                                                           |
| `settings.usage.entitlementServerMcpUsage`                    | ZCode MCP                                                                          |
| `settings.usage.entitlementWeeklyUsage`                       | 每周剩余                                                                           |
| `settings.usage.healthLiteDecode`                             | Lite 高峰期平均 Decode 速度                                                        |
| `settings.usage.healthProMaxDecode`                           | Max&Pro 高峰期平均 Decode 速度                                                     |
| `settings.usage.healthRange.7d`                               | 近 7 日                                                                            |
| `settings.usage.healthTitle`                                  | 系统健康度                                                                         |
| `settings.usage.lastRefreshTime`                              | 最近刷新时间：{time}                                                               |
| `settings.usage.modelChart.cachedInput`                       | 缓存                                                                               |
| `settings.usage.modelChart.output`                            | 输出                                                                               |
| `settings.usage.modelChart.uncachedInput`                     | 未缓存                                                                             |
| `settings.usage.quotaTitle`                                   | 剩余额度                                                                           |
| `settings.usage.tab.appUsage`                                 | 应用用量                                                                           |
| `settings.usage.tab.codingPlan`                               | 个人套餐                                                                           |
| `settings.usage.totalUsageDuration`                           | 累计使用时长                                                                       |
| `settings.usage.trendsTitle`                                  | 用量趋势                                                                           |

#### `chat` — 23 键

Agent 切换（`chat.agentSwitch.*`）的提示与结果文案，纯本地 UI。仓库内当前无 `agentSwitch` 引用，需与设置侧的 agent 列表一并接线。

| 键                                                    | 官方 zh-CN 译文                                                   |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| `chat.agentSwitch.failed`                             | 切换 Agent 失败                                                   |
| `chat.agentSwitch.success`                            | 已切换到 {provider}                                               |
| `chat.agentSwitch.switchTo`                           | {provider}                                                        |
| `chat.captcha.verifyFailed`                           | 验证码校验失败，请重试。                                          |
| `chat.error.action.relogin`                           | 重新登录                                                          |
| `chat.error.action.retryCaptcha`                      | 重试验证码                                                        |
| `chat.error.feedbackOpened`                           | 已打开反馈，并自动带上报错现场                                    |
| `chat.quota.action.refresh`                           | 刷新额度                                                          |
| `chat.quota.action.renew`                             | 续期                                                              |
| `chat.quota.action.switchModel`                       | 切换模型                                                          |
| `chat.quota.action.switchProvider`                    | 切换供应商                                                        |
| `chat.quota.action.upgrade`                           | 升级                                                              |
| `chat.quota.mcp.codingPlanRequired`                   | 当前无 ZCode MCP「{server}」额度，请登录或开通 Coding Plan 使用。 |
| `chat.quota.mcp.quotaExhausted`                       | ZCode MCP「{server}」今日额度已用完，明天自动恢复。               |
| `chat.quota.providerLimited`                          | 当前账户额度或套餐已达到使用限制。请升级或调整套餐后继续。        |
| `chat.quota.startPlan.bucketActivityLow`              | {model} 活动额度剩余 {percent}（{remaining} tokens）。            |
| `chat.quota.startPlan.bucketDailyLow`                 | {model} 今日额度剩余 {percent}（{remaining} tokens）。            |
| `chat.quota.startPlan.concurrentLimit`                | 当前系统繁忙，请切换模型、升级账户，或稍后再试。                  |
| `chat.quota.startPlan.concurrentLimit.retryExhausted` | 当前系统繁忙，当前自动重试已达到最大次数，请稍后再试或升级账户。  |
| `chat.quota.startPlan.concurrentLimit.switchModel`    | 当前模型请求已达到并发上限，请切换模型继续当前任务                |
| `chat.quota.startPlan.dailyExhausted`                 | 体验套餐可用额度已用完，请升级套餐或等待额度恢复。                |
| `chat.quota.startPlan.modelExhausted`                 | {model} 可用额度已用完，可切换其他模型或升级套餐。                |
| `chat.quota.startPlan.modelVeryLow`                   | {model} 套餐额度剩余 {percent}（{remaining} tokens）。            |

#### `sidebar` — 19 键

侧栏用量/套餐展示与头像态文案；`profile.notLoggedIn`「连接使用」等属本地渲染。

| 键                                      | 官方 zh-CN 译文              |
| --------------------------------------- | ---------------------------- |
| `sidebar.profile.notLoggedIn`           | 连接使用                     |
| `sidebar.usage.plan.audienceIndividual` | 个人                         |
| `sidebar.usage.plan.audienceTeam`       | 团队                         |
| `sidebar.usage.plan.codingPlanTitle`    | 编程套餐                     |
| `sidebar.usage.plan.fiveHour`           | 5 小时                       |
| `sidebar.usage.plan.hidden`             | 服务端标记该额度不展示       |
| `sidebar.usage.plan.loading`            | 同步中...                    |
| `sidebar.usage.plan.loginRequired`      | 登录后查看剩余额度。         |
| `sidebar.usage.plan.mcp`                | ZCode MCP                    |
| `sidebar.usage.plan.noPlan`             | 暂无有效编程套餐             |
| `sidebar.usage.plan.notConfigured`      | 未找到已连接的编程套餐账号。 |
| `sidebar.usage.plan.refresh`            | 刷新额度                     |
| `sidebar.usage.plan.refreshing`         | 正在更新额度                 |
| `sidebar.usage.plan.title`              | 剩余额度                     |
| `sidebar.usage.plan.toolCalls`          | 工具调用                     |
| `sidebar.usage.plan.unavailable`        | 暂无可展示的权益数据。       |
| `sidebar.usage.plan.updateFailed`       | 可能网络原因，更新失败       |
| `sidebar.usage.plan.updated`            | 额度已更新                   |
| `sidebar.usage.plan.weekly`             | 每周                         |

#### `appHeader` — 8 键

顶栏「前往配置」跳转与「复制 JSONL 路径」，均为本地操作。

| 键                                             | 官方 zh-CN 译文                          |
| ---------------------------------------------- | ---------------------------------------- |
| `appHeader.copyClaudeJsonlPath`                | 复制JSONL路径                            |
| `appHeader.goToProviderConfig`                 | 前往配置                                 |
| `appHeader.goToProviderConfigPrefix`           | 前往                                     |
| `appHeader.goToProviderConfigSuffix`           | 配置                                     |
| `appHeader.openProviderConfigInEditorFailed`   | 无法在 {editor} 中打开 Provider 配置文件 |
| `appHeader.openProviderConfigWithEditorMiddle` | 打开                                     |
| `appHeader.openProviderConfigWithEditorPrefix` | 用                                       |
| `appHeader.openProviderConfigWithEditorSuffix` | 配置文件                                 |

#### `taskList` — 7 键

任务列表的 Codex 网络连通性探测提示、`feedbackOpened`（打开反馈并带当前任务信息——其动作本身指向 B 组的工单系统，文案可先补）。

| 键                                      | 官方 zh-CN 译文                                                   |
| --------------------------------------- | ----------------------------------------------------------------- |
| `taskList.codexConnectivityUnavailable` | Codex 预热检测到当前网络无法访问 {host}，后续对话可能无法正常开始 |
| `taskList.feedbackOpened`               | 已打开反馈，并自动带上当前任务信息                                |
| `taskList.newTask.claude`               | Claude CLI                                                        |
| `taskList.newTask.codex`                | Codex CLI                                                         |
| `taskList.newTask.gemini`               | Gemini CLI                                                        |
| `taskList.newTask.opencode`             | OpenCode CLI                                                      |
| `taskList.selectProvider`               | 选择 Agent                                                        |

#### `onboarding` — 4 键

onboarding 步骤的全选 aria 与计数文案，本地。

| 键                                                | 官方 zh-CN 译文                   |
| ------------------------------------------------- | --------------------------------- |
| `onboarding.agentSettings.providersToggleAllAria` | 全选或清空所有 Agent 的模型供应商 |
| `onboarding.footer.selection`                     | 已选择 {count} 项                 |
| `onboarding.step.agentSettings`                   | 代理设置                          |
| `onboarding.stepDescription.agentSettings`        | 选择要导入的各 Agent 模型供应商。 |

#### `quickPick` — 2 键

命令面板条目文案，本地。

| 键                         | 官方 zh-CN 译文 |
| -------------------------- | --------------- |
| `quickPick.command.login`  | 连接            |
| `quickPick.command.logout` | 断开连接        |

#### `zcode` — 2 键

仅 `error.CLAUDE_UNKNOWN_COMMAND*` 两条是纯本地错误码映射（Claude Code 未知命令）。同域其余 11 条 `providerBusiness.*` 见 B 组。

| 键                                             | 官方 zh-CN 译文                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `zcode.error.CLAUDE_UNKNOWN_COMMAND`           | Claude Code 未知命令 {command}。请确认命令名称，或切换到支持该命令的 Agent/技能后重试。                 |
| `zcode.error.CLAUDE_UNKNOWN_COMMAND_WITH_ARGS` | Claude Code 未知命令 {command}（参数：{args}）。请确认命令名称，或切换到支持该命令的 Agent/技能后重试。 |

#### `titleBar` — 1 键

单点文案。

| 键                                       | 官方 zh-CN 译文       |
| ---------------------------------------- | --------------------- |
| `titleBar.menu.help.toggleZCodeStdioTap` | 抓取 Agent stdio 通信 |

#### `usage` — 1 键

单点文案。

| 键                             | 官方 zh-CN 译文                                                        |
| ------------------------------ | ---------------------------------------------------------------------- |
| `usage.error.stats.credential` | 无法读取用量统计。请重新连接编程套餐账号，或确认该账号已开通编程套餐。 |

#### `workspaceHeader` — 1 键

单点文案。

| 键                                         | 官方 zh-CN 译文 |
| ------------------------------------------ | --------------- |
| `workspaceHeader.help.productRequestDraft` | 我想建议：      |

---

# B 组：有意不补全（581 键）

#### `feedback` — 288 键

**完整工单系统**：`submit`(125)/`timeline`(17)/`tickets`(14)/`supplement`(14) 等，含「已交由研发跟进」「问题描述」「添加附件」。仓库内 UI 引用 0 处、`feedbackService`/`createTicket` 等服务层 0 处。工单需要人工处理端与服务端存储，自建等于自任客服。

| 键                                                     | 官方 zh-CN 译文                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `feedback.actor.dev`                                   | 研发                                                                                                                     |
| `feedback.actor.productManager`                        | 产品经理                                                                                                                 |
| `feedback.actor.user`                                  | 用户                                                                                                                     |
| `feedback.background.collapse`                         | 折叠后台反馈状态                                                                                                         |
| `feedback.background.defaultDetail`                    | 反馈会在后台继续处理                                                                                                     |
| `feedback.background.dismiss`                          | 隐藏后台反馈状态                                                                                                         |
| `feedback.background.expand`                           | 展开后台反馈状态                                                                                                         |
| `feedback.background.open`                             | 打开后台反馈详情                                                                                                         |
| `feedback.background.openDetail`                       | 点击查看详情                                                                                                             |
| `feedback.background.pauseLogs`                        | 暂停日志                                                                                                                 |
| `feedback.background.title`                            | 正在提交反馈                                                                                                             |
| `feedback.center.backToSubmit`                         | 返回提交反馈                                                                                                             |
| `feedback.center.description`                          | 描述问题即可，提交后可查看处理进展。                                                                                     |
| `feedback.center.submitTab`                            | 提交                                                                                                                     |
| `feedback.center.submitTitle`                          | 提交反馈                                                                                                                 |
| `feedback.center.ticketsTab`                           | 我的反馈                                                                                                                 |
| `feedback.center.ticketsTitle`                         | 我的反馈                                                                                                                 |
| `feedback.center.title`                                | 问题上报                                                                                                                 |
| `feedback.detail.issueCopied`                          | 已复制 issue 编号                                                                                                        |
| `feedback.detail.issueCopy`                            | 复制 issue 编号                                                                                                          |
| `feedback.detail.issueCopyFailed`                      | 复制 issue 编号失败                                                                                                      |
| `feedback.detail.noActivity`                           | 暂无处理动态                                                                                                             |
| `feedback.detail.viewFullProcess`                      | 查看完整流程                                                                                                             |
| `feedback.detail.yourDescription`                      | 你的描述                                                                                                                 |
| `feedback.duration.days`                               | {count} 天                                                                                                               |
| `feedback.duration.hours`                              | {count} 小时                                                                                                             |
| `feedback.duration.instant`                            | 即时                                                                                                                     |
| `feedback.duration.lessThanMinute`                     | 不到 1 分钟                                                                                                              |
| `feedback.duration.minutes`                            | {count} 分钟                                                                                                             |
| `feedback.featureRequest.contactLabel`                 | 联系方式                                                                                                                 |
| `feedback.featureRequest.descriptionLabel`             | 需求描述                                                                                                                 |
| `feedback.featureRequest.descriptionPlaceholder`       | 示例：我希望任务运行时可以保存常用指令，后续能一键插入，减少重复输入。                                                   |
| `feedback.featureRequest.missingRequired`              | 请填写需求描述和期望的解决方案                                                                                           |
| `feedback.featureRequest.reset`                        | 重置内容                                                                                                                 |
| `feedback.featureRequest.solutionLabel`                | 期望的解决方案                                                                                                           |
| `feedback.featureRequest.solutionPlaceholder`          | 示例：在输入框旁增加快捷指令菜单，支持新增、编辑和一键插入。                                                             |
| `feedback.featureRequest.source`                       | Workspace Header 帮助菜单 / 给产品提需求                                                                                 |
| `feedback.featureRequest.submit`                       | 提交需求                                                                                                                 |
| `feedback.featureRequest.submittedToast`               | 需求已提交，我们会认真评估。                                                                                             |
| `feedback.featureRequest.title`                        | 给产品提需求                                                                                                             |
| `feedback.module.agentTaskFailed`                      | Agent任务执行失败                                                                                                        |
| `feedback.module.crashInternalError`                   | 崩溃 / Internal Error                                                                                                    |
| `feedback.module.docsUsage`                            | 文档 / 使用咨询                                                                                                          |
| `feedback.module.modelCallError`                       | 模型调用报错                                                                                                             |
| `feedback.module.modelConfigApiKey`                    | 模型配置 / API Key                                                                                                       |
| `feedback.module.modelSlowQuota`                       | 模型响应慢 / 额度                                                                                                        |
| `feedback.module.other`                                | 其它                                                                                                                     |
| `feedback.module.permissionConfigSave`                 | 权限 / 配置保存                                                                                                          |
| `feedback.module.pluginMcp`                            | Plugin / MCP                                                                                                             |
| `feedback.module.sshConnectionFailed`                  | SSH连接失败                                                                                                              |
| `feedback.module.uiLayoutInteraction`                  | UI布局 / 交互                                                                                                            |
| `feedback.module.wslConnectionFailed`                  | WSL连接失败                                                                                                              |
| `feedback.process.backToDetail`                        | 返回详情                                                                                                                 |
| `feedback.process.currentLatest`                       | 当前最新：                                                                                                               |
| `feedback.process.title`                               | 处理流程                                                                                                                 |
| `feedback.progress.assignee.dev`                       | 研发                                                                                                                     |
| `feedback.progress.assignee.unassigned`                | 等待分配                                                                                                                 |
| `feedback.progress.currentHandler`                     | 当前处理：                                                                                                               |
| `feedback.progress.stage.closed`                       | 已关闭                                                                                                                   |
| `feedback.progress.stage.done`                         | 已完结                                                                                                                   |
| `feedback.progress.stage.inProgress`                   | 处理中                                                                                                                   |
| `feedback.progress.stage.reviewing`                    | 评估中                                                                                                                   |
| `feedback.progress.stage.submitted`                    | 已提交                                                                                                                   |
| `feedback.progress.title`                              | 处理进度                                                                                                                 |
| `feedback.status.accepted`                             | 已采纳                                                                                                                   |
| `feedback.status.closedByReply`                        | 答复关闭                                                                                                                 |
| `feedback.status.completed`                            | 已完成                                                                                                                   |
| `feedback.status.inDevelopment`                        | 开发中                                                                                                                   |
| `feedback.status.needInfo`                             | 信息不足                                                                                                                 |
| `feedback.status.pendingReview`                        | 已提交                                                                                                                   |
| `feedback.status.rejected`                             | 已拒绝                                                                                                                   |
| `feedback.status.released`                             | 已上线                                                                                                                   |
| `feedback.status.resolved`                             | 已解决                                                                                                                   |
| `feedback.statusHint.accepted`                         | 你的反馈已被采纳，我们会安排修复或改进。                                                                                 |
| `feedback.statusHint.archived`                         | 产品经理已回复并关闭此反馈，如仍有问题可以重新提交。                                                                     |
| `feedback.statusHint.closedByReply`                    | 产品经理已回复并关闭此反馈，如仍有问题可以重新提交。                                                                     |
| `feedback.statusHint.inDevelopment`                    | 正在处理中，有进展会通过下方回复同步。                                                                                   |
| `feedback.statusHint.needInfo`                         | 还需要你补充一点信息，请看下方官方回复。                                                                                 |
| `feedback.statusHint.pendingReview`                    | 我们已收到，会尽快处理。                                                                                                 |
| `feedback.statusHint.rejected`                         | 这条反馈暂未纳入处理，如有疑问可看下方说明。                                                                             |
| `feedback.statusHint.released`                         | 相关修复或改进已上线，感谢你的反馈。                                                                                     |
| `feedback.statusHint.resolved`                         | 问题已经处理完成，正在等待版本上线。                                                                                     |
| `feedback.submission.canceledDetail`                   | 反馈提交已取消                                                                                                           |
| `feedback.submission.canceledLabel`                    | 反馈提交已取消                                                                                                           |
| `feedback.submission.cancelingCreateDetail`            | 已收到取消请求，正在停止创建反馈。                                                                                       |
| `feedback.submission.cancelingCreateLabel`             | 正在取消提交                                                                                                             |
| `feedback.submission.connectingDetail`                 | 创建成功后会继续上传截图和日志                                                                                           |
| `feedback.submission.connectingLabel`                  | 正在连接反馈服务                                                                                                         |
| `feedback.submission.exportingLogDetail`               | 会根据本机日志大小耗时数秒                                                                                               |
| `feedback.submission.exportingLogLabel`                | 正在导出完整日志                                                                                                         |
| `feedback.submission.failedLabel`                      | 反馈提交失败                                                                                                             |
| `feedback.submission.logUploadPausedDetail`            | 日志是定位问题的必需材料，请继续上传。                                                                                   |
| `feedback.submission.logUploadPausedLabel`             | 已暂停日志上传                                                                                                           |
| `feedback.submission.logUploadSuccessLabel`            | 日志上传成功                                                                                                             |
| `feedback.submission.networkErrorDetail`               | 无法连接反馈服务，请检查网络、VPN 或代理设置后重试。                                                                     |
| `feedback.submission.pausingLogDetail`                 | 已收到取消请求，稍等一下。                                                                                               |
| `feedback.submission.pausingLogLabel`                  | 正在暂停日志上传                                                                                                         |
| `feedback.submission.postCreateNetworkErrorDetail`     | 反馈已创建，但后续材料上传失败。请打开已创建的反馈补充材料，不要重复提交。                                               |
| `feedback.submission.preparingUploadDetail`            | 准备上传                                                                                                                 |
| `feedback.submission.submittedDetail`                  | 我们会尽快处理。                                                                                                         |
| `feedback.submission.submittedLabel`                   | 反馈已提交                                                                                                               |
| `feedback.submission.submittedToast`                   | 反馈已提交，我们会尽快处理。                                                                                             |
| `feedback.submission.uploadingLogLabel`                | 正在上传完整日志                                                                                                         |
| `feedback.submission.uploadingScreenshotLabel`         | 正在上传截图                                                                                                             |
| `feedback.submit.addScreenshot`                        | 添加截图                                                                                                                 |
| `feedback.submit.bug.descriptionLabel`                 | 详细说明                                                                                                                 |
| `feedback.submit.bug.descriptionPlaceholder`           | 直接写你遇到的问题：点了哪里、发生了什么、期望是什么、有没有报错。我们会保留原始描述，提交后再由后端辅助分析。           |
| `feedback.submit.bug.helper.1`                         | 发生位置                                                                                                                 |
| `feedback.submit.bug.helper.2`                         | 复现步骤                                                                                                                 |
| `feedback.submit.bug.helper.3`                         | 期望结果                                                                                                                 |
| `feedback.submit.bug.helper.4`                         | 实际结果 / 报错                                                                                                          |
| `feedback.submit.bug.missingDescription`               | 请描述一下问题                                                                                                           |
| `feedback.submit.bug.missingTitle`                     | 请写一个标题                                                                                                             |
| `feedback.submit.bug.screenshotHint`                   | 粘贴截图，或添加本地截图作为附件。                                                                                       |
| `feedback.submit.bug.sectionTitle`                     | 问题是什么                                                                                                               |
| `feedback.submit.bug.supplementalDescription`          |                                                                                                                          |
| `feedback.submit.bug.titleLabel`                       | 标题                                                                                                                     |
| `feedback.submit.bug.titlePlaceholder`                 | 例如：SSH 连接失败                                                                                                       |
| `feedback.submit.contact.hint`                         | 选填，方便我们后续联系你；也可以填其他社交账号。                                                                         |
| `feedback.submit.contact.label`                        | 联系邮箱                                                                                                                 |
| `feedback.submit.contact.placeholder`                  | example@domain.com / 微信号 / 其他社交账号                                                                               |
| `feedback.submit.continueUpload`                       | 继续上传                                                                                                                 |
| `feedback.submit.feature.descriptionLabel`             | 建议内容                                                                                                                 |
| `feedback.submit.feature.descriptionPlaceholder`       | 写你希望新增或优化什么：使用场景是什么、现在哪里不方便、理想效果是什么、这个建议能帮你节省什么。                         |
| `feedback.submit.feature.helper.1`                     | 使用场景                                                                                                                 |
| `feedback.submit.feature.helper.2`                     | 当前不方便之处                                                                                                           |
| `feedback.submit.feature.helper.3`                     | 期望能力 / 交互                                                                                                          |
| `feedback.submit.feature.helper.4`                     | 带来的价值                                                                                                               |
| `feedback.submit.feature.missingDescription`           | 请写一下建议内容                                                                                                         |
| `feedback.submit.feature.missingTitle`                 | 请写一个建议标题                                                                                                         |
| `feedback.submit.feature.screenshotHint`               | 可以贴参考截图、草图或当前不顺手的界面。                                                                                 |
| `feedback.submit.feature.sectionTitle`                 | 想建议什么                                                                                                               |
| `feedback.submit.feature.supplementalDescription`      | 建议也需要选择模块，方便我们评估优先级和影响范围。                                                                       |
| `feedback.submit.feature.titleLabel`                   | 建议标题                                                                                                                 |
| `feedback.submit.feature.titlePlaceholder`             | 例如：希望支持一键导出任务报告                                                                                           |
| `feedback.submit.missingDescription`                   | 请先描述问题                                                                                                             |
| `feedback.submit.model.label`                          | 当前模型型号                                                                                                             |
| `feedback.submit.model.unavailable`                    | 未读取到模型                                                                                                             |
| `feedback.submit.module.label`                         | 功能模块                                                                                                                 |
| `feedback.submit.notReported`                          | 未上报                                                                                                                   |
| `feedback.submit.performance.descriptionLabel`         | 慢在哪里                                                                                                                 |
| `feedback.submit.performance.descriptionPlaceholder`   | 写清楚哪个操作慢、慢到什么程度、是否每次都发生、数据量或任务规模大概是多少。                                             |
| `feedback.submit.performance.helper.1`                 | 具体操作                                                                                                                 |
| `feedback.submit.performance.helper.2`                 | 耗时体感                                                                                                                 |
| `feedback.submit.performance.helper.3`                 | 是否稳定复现                                                                                                             |
| `feedback.submit.performance.helper.4`                 | 任务规模 / 数据量                                                                                                        |
| `feedback.submit.performance.missingDescription`       | 请描述一下哪里运行很慢                                                                                                   |
| `feedback.submit.performance.missingTitle`             | 请写一个性能问题标题                                                                                                     |
| `feedback.submit.performance.screenshotHint`           | 可以贴加载中、卡住或资源占用相关截图。                                                                                   |
| `feedback.submit.performance.sectionTitle`             | 哪里运行很慢                                                                                                             |
| `feedback.submit.performance.supplementalDescription`  | 性能问题默认附带日志，模块和模型能帮助我们定位耗时链路。                                                                 |
| `feedback.submit.performance.titleLabel`               | 性能问题标题                                                                                                             |
| `feedback.submit.performance.titlePlaceholder`         | 例如：任务列表打开很慢                                                                                                   |
| `feedback.submit.processing`                           | 处理中                                                                                                                   |
| `feedback.submit.removeScreenshot`                     | 移除                                                                                                                     |
| `feedback.submit.screenshotLimit`                      | 最多添加 {count} 张截图                                                                                                  |
| `feedback.submit.severity.label`                       | 影响程度                                                                                                                 |
| `feedback.submit.simple.contactTitle`                  | 联系方式                                                                                                                 |
| `feedback.submit.simple.descriptionLabel`              | 描述                                                                                                                     |
| `feedback.submit.simple.descriptionPlaceholder`        | 请描述你遇到的问题、发生场景、期望结果，或希望改进的地方。                                                               |
| `feedback.submit.simple.descriptionTitle`              | 问题描述                                                                                                                 |
| `feedback.submit.simple.footerHint`                    | 提交后可在“我的反馈”查看处理进展。                                                                                       |
| `feedback.submit.simple.logsHint`                      | 默认关闭。勾选后上传当天的诊断日志，不含数据库、配置文件或模型对话轨迹。已进行自动脱敏，仍可能包含业务信息，请谨慎选择。 |
| `feedback.submit.simple.logsLabel`                     | 上传诊断日志                                                                                                             |
| `feedback.submit.simple.logsTitle`                     | 日志                                                                                                                     |
| `feedback.submit.simple.screenshotHint`                | 粘贴、拖拽图片到这里，或选择文件。                                                                                       |
| `feedback.submit.simple.screenshotPrivacyHint`         | 请注意检查图片中的隐私信息。                                                                                             |
| `feedback.submit.simple.screenshotTitle`               | 截图                                                                                                                     |
| `feedback.submit.submit`                               | 提交反馈                                                                                                                 |
| `feedback.submit.submitting`                           | 提交中                                                                                                                   |
| `feedback.submit.supplemental.title`                   | 补充信息                                                                                                                 |
| `feedback.submit.template.bug.actual`                  | 实际结果 / 报错：                                                                                                        |
| `feedback.submit.template.bug.expected`                | 期望结果：                                                                                                               |
| `feedback.submit.template.bug.problem`                 | 问题描述：                                                                                                               |
| `feedback.submit.template.bug.steps`                   | 操作步骤：                                                                                                               |
| `feedback.submit.template.feature.currentPain`         | 当前不方便之处：                                                                                                         |
| `feedback.submit.template.feature.expected`            | 期望能力 / 交互：                                                                                                        |
| `feedback.submit.template.feature.scenario`            | 使用场景：                                                                                                               |
| `feedback.submit.template.occurredAt`                  | 发生时间：{timestamp}                                                                                                    |
| `feedback.submit.template.occurredAtPrefix`            | 发生时间：                                                                                                               |
| `feedback.submit.template.performance.action`          | 具体操作：                                                                                                               |
| `feedback.submit.template.performance.delay`           | 耗时体感：                                                                                                               |
| `feedback.submit.template.performance.reproducible`    | 是否稳定复现：                                                                                                           |
| `feedback.submit.template.proposedAt`                  | 提出时间：{timestamp}                                                                                                    |
| `feedback.submit.template.proposedAtPrefix`            | 提出时间：                                                                                                               |
| `feedback.submit.template.section.copyErrorHeading`    | ZCode 报错信息                                                                                                           |
| `feedback.submit.template.section.errorDetail`         | 报错详情                                                                                                                 |
| `feedback.submit.template.section.errorHeading`        | 我在使用过程中遇到了报错，请帮忙排查。                                                                                   |
| `feedback.submit.template.section.errorSummary`        | 报错摘要                                                                                                                 |
| `feedback.submit.template.section.errorSummaryLine`    | 报错摘要：{message}                                                                                                      |
| `feedback.submit.template.section.errorTraceId`        | TraceID: {traceId}                                                                                                       |
| `feedback.submit.template.section.expectedResult`      | 期望结果                                                                                                                 |
| `feedback.submit.template.section.featureSource`       | 来源                                                                                                                     |
| `feedback.submit.template.section.notProvided`         | 未提供                                                                                                                   |
| `feedback.submit.template.section.problem`             | 遇到的问题                                                                                                               |
| `feedback.submit.template.section.remoteConnectFailed` | 远程连接失败                                                                                                             |
| `feedback.submit.template.section.remoteEnvironment`   | 我当时正在连接的环境                                                                                                     |
| `feedback.submit.template.section.remoteHeading`       | 远程连接过程中出现报错，请帮忙排查。                                                                                     |
| `feedback.submit.template.section.remoteLog`           | 连接日志（最近 30 条）                                                                                                   |
| `feedback.submit.template.section.remoteLogEmpty`      | 未捕获到连接日志                                                                                                         |
| `feedback.submit.template.section.supplement`          | 请补充：                                                                                                                 |
| `feedback.submit.template.section.taskFeedbackTitle`   | 反馈任务问题：{title}                                                                                                    |
| `feedback.submit.template.section.taskHeading`         | 我在这个任务里遇到了问题，请帮忙排查。                                                                                   |
| `feedback.submit.template.section.taskId`              | 任务 ID: {id}                                                                                                            |
| `feedback.submit.template.section.taskInfo`            | 任务信息                                                                                                                 |
| `feedback.submit.template.section.taskLogPath`         | 任务日志: {path}                                                                                                         |
| `feedback.submit.template.section.taskSessionPath`     | 任务会话: {path}                                                                                                         |
| `feedback.submit.template.section.taskTitle`           | 任务标题: {title}                                                                                                        |
| `feedback.submit.template.section.taskWorkspace`       | 工作区: {path}                                                                                                           |
| `feedback.submit.template.section.whatDoing`           | 我当时正在做什么                                                                                                         |
| `feedback.submit.template.usage.blockedStep`           | 卡住的步骤：                                                                                                             |
| `feedback.submit.template.usage.help`                  | 希望获得的帮助：                                                                                                         |
| `feedback.submit.template.usage.task`                  | 正在做的任务：                                                                                                           |
| `feedback.submit.template.usage.tried`                 | 已经尝试过什么：                                                                                                         |
| `feedback.submit.type.hint`                            | 选择后会自动调整下面的问题描述引导                                                                                       |
| `feedback.submit.type.label`                           | 反馈类型                                                                                                                 |
| `feedback.submit.usage.descriptionLabel`               | 卡住的地方                                                                                                               |
| `feedback.submit.usage.descriptionPlaceholder`         | 写清楚你正在做什么、卡在哪一步、看到了什么提示、你希望我们怎么解释或引导。                                               |
| `feedback.submit.usage.helper.1`                       | 正在做的任务                                                                                                             |
| `feedback.submit.usage.helper.2`                       | 卡住的步骤                                                                                                               |
| `feedback.submit.usage.helper.3`                       | 已经尝试过什么                                                                                                           |
| `feedback.submit.usage.helper.4`                       | 希望获得的帮助                                                                                                           |
| `feedback.submit.usage.missingDescription`             | 请写一下卡住的地方                                                                                                       |
| `feedback.submit.usage.missingTitle`                   | 请写一下使用问题标题                                                                                                     |
| `feedback.submit.usage.screenshotHint`                 | 可以粘贴当前卡住的界面截图。                                                                                             |
| `feedback.submit.usage.sectionTitle`                   | 哪里不会使用                                                                                                             |
| `feedback.submit.usage.supplementalDescription`        | 补充模块和模型，有助于我们定位文档、引导或默认配置问题。                                                                 |
| `feedback.submit.usage.titleLabel`                     | 问题标题                                                                                                                 |
| `feedback.submit.usage.titlePlaceholder`               | 例如：不知道怎么配置远程连接                                                                                             |
| `feedback.supplement.addAttachment`                    | 添加附件                                                                                                                 |
| `feedback.supplement.attachment`                       | 附件                                                                                                                     |
| `feedback.supplement.attachmentHint`                   | 支持粘贴截图或添加本地文件，单个附件不超过 100 MB。                                                                      |
| `feedback.supplement.attachmentLimit`                  | 最多添加 {count} 个附件                                                                                                  |
| `feedback.supplement.attachmentTooLarge`               | {name} 超过 100 MB，暂时不能上传。                                                                                       |
| `feedback.supplement.continueDescription`              | 在查看流程时也可以直接补充复现步骤、截图说明、日志片段或新的线索。                                                       |
| `feedback.supplement.continueTitle`                    | 继续补充                                                                                                                 |
| `feedback.supplement.description`                      | 可以直接在这里补充复现步骤、截图说明、日志片段或更多线索。                                                               |
| `feedback.supplement.placeholder`                      | 还有要补充的，可以在这里留言、粘贴截图，或添加本地文件…                                                                  |
| `feedback.supplement.removeAttachment`                 | 移除 {name}                                                                                                              |
| `feedback.supplement.send`                             | 发送补充                                                                                                                 |
| `feedback.supplement.sending`                          | 发送中                                                                                                                   |
| `feedback.supplement.title`                            | 补充信息                                                                                                                 |
| `feedback.supplement.uploadedAttachments`              | 附件：{names}                                                                                                            |
| `feedback.tickets.backToList`                          | 返回列表                                                                                                                 |
| `feedback.tickets.column.description`                  | 问题描述                                                                                                                 |
| `feedback.tickets.column.id`                           | ID                                                                                                                       |
| `feedback.tickets.column.status`                       | 状态                                                                                                                     |
| `feedback.tickets.empty.action`                        | 提交反馈                                                                                                                 |
| `feedback.tickets.empty.description`                   | 遇到问题时随手提一条，我们会同步处理进度。                                                                               |
| `feedback.tickets.empty.title`                         | 还没有反馈记录                                                                                                           |
| `feedback.tickets.group.earlier`                       | 更早                                                                                                                     |
| `feedback.tickets.group.last24h`                       | 最近 24 小时                                                                                                             |
| `feedback.tickets.group.last7d`                        | 最近 7 天                                                                                                                |
| `feedback.tickets.issuePrefix`                         | ID                                                                                                                       |
| `feedback.tickets.newFeedback`                         | 新建反馈                                                                                                                 |
| `feedback.tickets.placeholder.description`             | 我们处理工单时的回复会出现在这里，你也可以在详情里补充复现步骤、截图或日志。                                             |
| `feedback.tickets.placeholder.title`                   | 选择一条反馈查看详情                                                                                                     |
| `feedback.time.daysAgo`                                | {count} 天前                                                                                                             |
| `feedback.time.hoursAgo`                               | {count} 小时前                                                                                                           |
| `feedback.time.justNow`                                | 刚刚                                                                                                                     |
| `feedback.time.minutesAgo`                             | {count} 分钟前                                                                                                           |
| `feedback.time.submittedAt`                            | {time}提交                                                                                                               |
| `feedback.timeline.assignedToDev`                      | 已交由研发跟进                                                                                                           |
| `feedback.timeline.duration`                           | 用时 {time}                                                                                                              |
| `feedback.timeline.empty`                              | 暂无动态。处理有进展后，会在这里通知你。                                                                                 |
| `feedback.timeline.event.agentSubmitted`               | {name} 通过 Agent 提交反馈                                                                                               |
| `feedback.timeline.event.conclusion`                   | 处理结论                                                                                                                 |
| `feedback.timeline.event.fullLogUploaded`              | 完整日志已上传，反馈进入已提交                                                                                           |
| `feedback.timeline.event.markedStatus`                 | 标记为「{status}」：{message}                                                                                            |
| `feedback.timeline.event.progressUpdated`              | 处理进度更新                                                                                                             |
| `feedback.timeline.event.progressUpdatedWithMessage`   | 进度更新：{message}                                                                                                      |
| `feedback.timeline.event.progressUpdatedWithStatus`    | 进度更新（状态→{status}）：{message}                                                                                     |
| `feedback.timeline.event.statusChanged`                | 状态更新为「{status}」                                                                                                   |
| `feedback.timeline.event.submitted`                    | 反馈已提交                                                                                                               |
| `feedback.timeline.latestUpdate`                       | 最近更新 {time}                                                                                                          |
| `feedback.timeline.officialReply`                      | 官方回复                                                                                                                 |
| `feedback.timeline.stepCount`                          | 共 {count} 步                                                                                                            |
| `feedback.timeline.syncWhenUpdated`                    | 有进展后会在这里同步                                                                                                     |
| `feedback.timeline.yourSupplement`                     | 你补充了信息                                                                                                             |
| `feedback.title.fallback`                              | 用户反馈                                                                                                                 |
| `feedback.type.bug.description`                        | 报错、崩溃、功能不符合预期                                                                                               |
| `feedback.type.bug.label`                              | 遇到 Bug                                                                                                                 |
| `feedback.type.feature.description`                    | 希望支持的新能力或体验优化                                                                                               |
| `feedback.type.feature.label`                          | 想提建议                                                                                                                 |
| `feedback.type.performance.description`                | 卡顿、响应慢、资源占用异常                                                                                               |
| `feedback.type.performance.label`                      | 运行很慢                                                                                                                 |
| `feedback.type.usage.description`                      | 操作不清楚、配置不确定                                                                                                   |
| `feedback.type.usage.label`                            | 不会使用                                                                                                                 |

#### `offPeak` — 84 键

「闲时任务」：`create.codingPlanOnly`「仅限 coding plan 用户使用」、`newTask.bannerText`「免费在算力富余时段为你完成」。**必须订阅账号 + 服务端算力调度**，本 fork 无对应后端。

| 键                                               | 官方 zh-CN 译文                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `offPeak.action.cancel`                          | 取消任务                                                                             |
| `offPeak.action.continue`                        | 继续                                                                                 |
| `offPeak.action.continueHint`                    | 票已失效时，「继续」会把任务重新排到队尾。                                           |
| `offPeak.action.pause`                           | 暂停                                                                                 |
| `offPeak.action.pauseHint`                       | 暂停时长超过队列等待时限的任务，将会被重新放回队列。                                 |
| `offPeak.badge.pausedPosition`                   | #{position} 已暂停                                                                   |
| `offPeak.badge.queuePosition`                    | 排队第 {position} 位                                                                 |
| `offPeak.boundSession.hint`                      | 任务将在该会话中执行；执行期间停止会话会取消任务。                                   |
| `offPeak.boundSession.label`                     | 运行会话：{title}                                                                    |
| `offPeak.cancel.description`                     | 「{title}」将停止执行，已修改的文件会保留。                                          |
| `offPeak.cancel.title`                           | 取消闲时任务？                                                                       |
| `offPeak.chatCreated.open`                       | 去到闲时任务                                                                         |
| `offPeak.create.availabilityUnavailable`         | 暂时无法确认创建资格，请刷新后重试。                                                 |
| `offPeak.create.codingPlanOnly`                  | 仅限 coding plan 用户使用                                                            |
| `offPeak.create.codingPlanToast`                 | 闲时任务仅向 Coding Plan 订阅用户开放。                                              |
| `offPeak.create.defaultTitle`                    | 未命名                                                                               |
| `offPeak.create.limitReachedAt`                  | 闲时任务额度已用完，可在 {time}后再次创建。                                          |
| `offPeak.create.remaining.hours`                 | {hours} 小时                                                                         |
| `offPeak.create.remaining.hoursMinutes`          | {hours} 小时 {minutes} 分钟                                                          |
| `offPeak.create.remaining.lessThanMinute`        | 不到 1 分钟                                                                          |
| `offPeak.create.remaining.minutes`               | {minutes} 分钟                                                                       |
| `offPeak.create.submit`                          | 创建闲时任务                                                                         |
| `offPeak.create.subtitle`                        | 配置任务指令及其在闲时的运行方式。                                                   |
| `offPeak.create.title`                           | 新建闲时任务                                                                         |
| `offPeak.createButton`                           | 创建闲时任务                                                                         |
| `offPeak.delete.confirm`                         | 删除闲时任务                                                                         |
| `offPeak.delete.description`                     | 此操作无法撤销。如果任务当前正在排队或运行中，将立即停止。                           |
| `offPeak.delete.title`                           | 删除此闲时任务？                                                                     |
| `offPeak.discard.confirm`                        | 丢弃                                                                                 |
| `offPeak.discard.description`                    | 你对当前闲时任务的更改将会丢失。                                                     |
| `offPeak.discard.title`                          | 丢弃闲时任务的草稿？                                                                 |
| `offPeak.edit.peakHoursWarning`                  | 此任务会在高峰时段运行，可能导致执行出错。                                           |
| `offPeak.edit.save`                              | 保存                                                                                 |
| `offPeak.edit.subtitle`                          | 调整任务指令及其在闲时的运行方式。                                                   |
| `offPeak.edit.title`                             | 编辑闲时任务                                                                         |
| `offPeak.error.generic`                          | 闲时任务操作失败。                                                                   |
| `offPeak.error.quota`                            | 闲时任务额度已用完，请稍后再试。                                                     |
| `offPeak.error.unavailable`                      | 闲时任务服务暂时不可用，请稍后重试。                                                 |
| `offPeak.form.fullAccessHint`                    | 建议权限切换为完全访问，以减少任务失败率                                             |
| `offPeak.form.instructionsLabel`                 | 任务指令                                                                             |
| `offPeak.form.instructionsPlaceholder`           | 描述希望 ZCode 在后台完成的工作、预期结果和约束，例如整理本周代码改动并生成站会摘要… |
| `offPeak.form.keepAwakeHint`                     | 阻止系统因空闲进入休眠（桌面端全局开关，设置 → 常规 中可改）。                       |
| `offPeak.form.keepAwakeLabel`                    | 保持电脑运行                                                                         |
| `offPeak.form.modelLabel`                        | 模型                                                                                 |
| `offPeak.form.permissionWarning`                 | 闲时执行时无人值守，需要确认的操作会暂停任务直到你响应。                             |
| `offPeak.form.soonestAvailable`                  | 最早可用时段                                                                         |
| `offPeak.form.titleLabel`                        | 任务标题                                                                             |
| `offPeak.form.titlePlaceholder`                  | 例如：夜间重构                                                                       |
| `offPeak.goToSession`                            | 打开会话                                                                             |
| `offPeak.history.col.instructions`               | 指令                                                                                 |
| `offPeak.history.delete`                         | 删除历史记录                                                                         |
| `offPeak.history.durationMinutes`                | {count} 分钟                                                                         |
| `offPeak.history.empty`                          | 还没有历史记录。                                                                     |
| `offPeak.keepAwakeBanner`                        | ZCode 运行会话时保持电脑唤醒。                                                       |
| `offPeak.list.empty`                             | 还没有闲时任务。创建一个，让它在算力空闲时免费执行。                                 |
| `offPeak.modelSelection.repairRequired`          | 模型配置需要更新，请重新选择后保存。                                                 |
| `offPeak.nav.listUnavailable`                    | 闲时任务列表加载失败，请刷新后重试                                                   |
| `offPeak.newTask.bannerText`                     | 订阅用户新功能体验：创建“闲时任务”，我们将免费在算力富余时段为你完成指派任务。       |
| `offPeak.newTask.bannerTipText`                  | 本功能不消耗订阅用户套餐额度、本功能仅面向订阅用户开放                               |
| `offPeak.newTask.carousel.goToSlide`             | 查看第 {index} 个闲时任务模板                                                        |
| `offPeak.newTask.template.customize.description` | 跳过模板，直接告诉它你想做什么。                                                     |
| `offPeak.newTask.template.customize.title`       | 自定义                                                                               |
| `offPeak.notify.completed.body`                  | 「{title}」已成功完成。                                                              |
| `offPeak.notify.completed.title`                 | 闲时任务已完成                                                                       |
| `offPeak.notify.failed.body`                     | 「{title}」执行出错已停止。                                                          |
| `offPeak.notify.failed.title`                    | 闲时任务失败                                                                         |
| `offPeak.sectionTitle`                           | 闲时任务                                                                             |
| `offPeak.status.cancelled`                       | 已取消                                                                               |
| `offPeak.status.completed`                       | 已完成                                                                               |
| `offPeak.status.failed`                          | 失败                                                                                 |
| `offPeak.status.paused`                          | 已暂停                                                                               |
| `offPeak.status.queued`                          | 等待闲时算力                                                                         |
| `offPeak.status.running`                         | 运行中                                                                               |
| `offPeak.tab.history`                            | 历史                                                                                 |
| `offPeak.tab.settings`                           | 设置                                                                                 |
| `offPeak.tabs.idle`                              | 闲时任务                                                                             |
| `offPeak.tabs.scheduled`                         | 定时任务                                                                             |
| `offPeak.templates.sectionTitle`                 | 闲时任务模板                                                                         |
| `offPeak.thought.enabled`                        | 开启                                                                                 |
| `offPeak.thought.high`                           | 高                                                                                   |
| `offPeak.thought.low`                            | 低                                                                                   |
| `offPeak.thought.max`                            | 最高                                                                                 |
| `offPeak.thought.nothink`                        | 不思考                                                                               |
| `offPeak.thought.off`                            | 关闭                                                                                 |

#### `manualClaimPlan` — 50 键

「可领取的体验套餐」领取流程。领取动作指向官方账账户额度体系。

| 键                                                             | 官方 zh-CN 译文                                                               |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `manualClaimPlan.banner.aria`                                  | 可领取的体验套餐                                                              |
| `manualClaimPlan.banner.claim`                                 | 领取                                                                          |
| `manualClaimPlan.banner.close`                                 | 关闭活动                                                                      |
| `manualClaimPlan.banner.dismissConfirm.claim`                  | 立即领取                                                                      |
| `manualClaimPlan.banner.dismissConfirm.close`                  | 仍然关闭                                                                      |
| `manualClaimPlan.banner.dismissConfirm.description`            | 本次活动的领取机会有限。关闭后，您可能会错过本次机会，是否现在领取？          |
| `manualClaimPlan.banner.dismissConfirm.title`                  | 您将错过一次领取机会                                                          |
| `manualClaimPlan.banner.subtitle.daily`                        | {model} 每日额度                                                              |
| `manualClaimPlan.banner.subtitle.oneTime`                      | {model} 一次性额度                                                            |
| `manualClaimPlan.banner.tag`                                   | 限时可领取                                                                    |
| `manualClaimPlan.banner.unit.tokens`                           | Tokens                                                                        |
| `manualClaimPlan.claim.dialog.acknowledge`                     | 知道了                                                                        |
| `manualClaimPlan.claim.dialog.confirm`                         | 开始体验                                                                      |
| `manualClaimPlan.claim.dialog.endsAt`                          | 有效期至                                                                      |
| `manualClaimPlan.claim.dialog.modelSettings`                   | 查看套餐                                                                      |
| `manualClaimPlan.claim.dialog.replay`                          | 重新播放票券动画                                                              |
| `manualClaimPlan.claim.dialog.startsAt`                        | 开始时间                                                                      |
| `manualClaimPlan.claim.failure.alreadyClaimed`                 | 该套餐已经领取过。                                                            |
| `manualClaimPlan.claim.failure.captcha`                        | 验证码校验失败，请重试。                                                      |
| `manualClaimPlan.claim.failure.generic`                        | 领取失败，请稍后重试。                                                        |
| `manualClaimPlan.claim.failure.ineligible`                     | 当前账号或客户端版本不满足领取条件。                                          |
| `manualClaimPlan.claim.failure.invalidRequest`                 | 领取参数错误，请刷新后重试。                                                  |
| `manualClaimPlan.claim.failure.loginRequired`                  | 请先登录后再领取。                                                            |
| `manualClaimPlan.claim.failure.notFound`                       | 套餐不存在。                                                                  |
| `manualClaimPlan.claim.failure.quotaExhausted`                 | 今日领取名额已用完。                                                          |
| `manualClaimPlan.claim.failure.quotaExhausted.nextTime`        | 今日领取名额已用完，欢迎下次再来。                                            |
| `manualClaimPlan.claim.failure.quotaExhausted.tomorrow`        | 今日领取名额已用完，请明天再来。                                              |
| `manualClaimPlan.claim.failure.title`                          | 领取失败                                                                      |
| `manualClaimPlan.claim.failure.unavailable`                    | 活动已结束或套餐暂不可领取。                                                  |
| `manualClaimPlan.claim.share.actionFailed`                     | 操作失败，请重试                                                              |
| `manualClaimPlan.claim.share.close`                            | 关闭分享                                                                      |
| `manualClaimPlan.claim.share.copyImage`                        | 复制图片                                                                      |
| `manualClaimPlan.claim.share.copyImageSucceeded`               | 图片已复制                                                                    |
| `manualClaimPlan.claim.share.copyText`                         | 复制内容                                                                      |
| `manualClaimPlan.claim.share.copyTextSucceeded`                | 内容已复制                                                                    |
| `manualClaimPlan.claim.share.getImage`                         | 获取图片                                                                      |
| `manualClaimPlan.claim.share.label`                            | 复制分享                                                                      |
| `manualClaimPlan.claim.share.saveImage`                        | 保存图片                                                                      |
| `manualClaimPlan.claim.share.twitterText`                      | 我在 ZCode 领取了 {subtitle}。邀请你也来下载安装即可领取。 https://zcode.z.ai |
| `manualClaimPlan.claim.share.twitterTextLabel`                 | Twitter/X 分享文案                                                            |
| `manualClaimPlan.claim.startUsingUnavailable`                  | Start Plan 当前还不可用，模型设置未改变，请稍后刷新重试。                     |
| `manualClaimPlan.claim.success.description`                    | Start Plan 已可使用。                                                         |
| `manualClaimPlan.claim.success.description.prefix`             |                                                                               |
| `manualClaimPlan.claim.success.description.suffix`             | 已可使用。                                                                    |
| `manualClaimPlan.claim.success.pending.description.afterTime`  | 生效。                                                                        |
| `manualClaimPlan.claim.success.pending.description.beforeTime` | 将于                                                                          |
| `manualClaimPlan.claim.success.pending.description.prefix`     |                                                                               |
| `manualClaimPlan.claim.success.title`                          | {plan} 领取成功                                                               |
| `manualClaimPlan.claim.ticket.benefit`                         | {model} {amount} {unit}                                                       |
| `manualClaimPlan.claim.ticket.benefit.daily`                   | {model} 每日 {amount} {unit}                                                  |

#### `conversationShare` — 47 键

本仓库已实现本地打包版分享（`ConversationShareMenu.tsx` 等，140+ 键，0 处登录判断）。缺的是上游后加的 `disclosure.*`（敏感信息自查确认）、`error.authenticationRequired`/`import.loginRequired`（登录态门槛）、`permission.linkEditor`（链接协作者）、`phase.uploading*`（产物上传回执）——**要求账号与远端发布**，与本仓库本地打包实现不兼容。

| 键                                                     | 官方 zh-CN 译文                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `conversationShare.disclosure.checkbox`                | 我已检查分享内容，确认不包含敏感信息。                                                |
| `conversationShare.disclosure.description`             | 系统不会自动检测敏感信息。                                                            |
| `conversationShare.disclosure.scope.conversation`      | 会话内容：用户消息、助手回复、任务标题                                                |
| `conversationShare.disclosure.scope.generated`         | 生成内容：代码、文件、预览内容                                                        |
| `conversationShare.disclosure.scope.note`              | 系统不会自动扫描或脱敏，请逐项确认。                                                  |
| `conversationShare.disclosure.scope.reviewLabel`       | 需要查看                                                                              |
| `conversationShare.disclosure.scope.sensitive`         | 凭证、Token、密码、私钥、内部地址、个人信息                                           |
| `conversationShare.disclosure.scope.sensitiveLabel`    | 重点排查                                                                              |
| `conversationShare.disclosure.scope.title`             | 检查范围                                                                              |
| `conversationShare.disclosure.scope.tools`             | 工具输入与输出：命令、参数、返回结果                                                  |
| `conversationShare.disclosure.scope.trigger`           | 查看检查范围                                                                          |
| `conversationShare.error.authenticationRequired`       | 分享功能仅对已登录用户开放。登录状态已失效，请重新登录后再试。                        |
| `conversationShare.error.disclosureRequired`           | 请先检查并确认分享内容，再生成链接。                                                  |
| `conversationShare.error.network`                      | 无法连接分享服务，请检查网络后重试。                                                  |
| `conversationShare.error.rateLimited`                  | 分享操作过于频繁，请稍后再试。                                                        |
| `conversationShare.error.safetyCheckTimeout`           | 分享安全检查超时，请稍后重试。                                                        |
| `conversationShare.error.uploadFailed`                 | 文件未能完整上传，请确认文件仍然存在后重试。                                          |
| `conversationShare.import.complete`                    | 分享导入完成                                                                          |
| `conversationShare.import.downloading`                 | 正在下载分享文件：{completed}/{total}                                                 |
| `conversationShare.import.expired`                     | 分享已过期，请让分享者重新生成                                                        |
| `conversationShare.import.failedWithArtifact`          | 分享文件 {artifactDisplayName} 在下载阶段失败，请检查网络后重试。                     |
| `conversationShare.import.fallbackDefaultWorkspace`    | 已从分享导入：{title}。没有可用的目标工作区，会话已创建在默认工作区 {workspacePath}。 |
| `conversationShare.import.integrityFailedWithArtifact` | 分享文件 {artifactDisplayName} 校验失败，已停止导入，请让分享者重新生成链接。         |
| `conversationShare.import.loginRequired`               | 该分享暂不支持匿名导入，请登录 ZCode 后重试                                           |
| `conversationShare.import.notFound`                    | 分享不存在或当前账号无权访问                                                          |
| `conversationShare.issue.uploadIncomplete`             | {artifactDisplayName} 上传回执与文件不一致，请确认文件未变化后重试。                  |
| `conversationShare.permission.linkEditor`              | 拥有链接的人可导入并继续                                                              |
| `conversationShare.permission.linkEditorHint`          | 可导入到 ZCode                                                                        |
| `conversationShare.permission.linkEditorSummary`       | 链接持有者可导入并继续                                                                |
| `conversationShare.permission.linkViewer`              | 拥有链接的人都可查看                                                                  |
| `conversationShare.permission.linkViewerHint`          | 不能导入继续                                                                          |
| `conversationShare.permission.linkViewerSummary`       | 链接持有者可查看                                                                      |
| `conversationShare.permission.private`                 | 仅自己可见                                                                            |
| `conversationShare.permission.privateHint`             | 适合个人留档                                                                          |
| `conversationShare.permission.privateSummary`          | 仅自己可见                                                                            |
| `conversationShare.permissionLabel`                    | 访问权限                                                                              |
| `conversationShare.phase.checking`                     | 安全检查                                                                              |
| `conversationShare.phase.checkingPending`              | 等待上传完成                                                                          |
| `conversationShare.phase.uploading`                    | 上传产物                                                                              |
| `conversationShare.phase.uploadingActive`              | 正在上传 {completed} / {total}                                                        |
| `conversationShare.phase.uploadingComplete`            | 产物上传完成                                                                          |
| `conversationShare.phase.uploadingPending`             | 等待整理完成                                                                          |
| `conversationShare.progress.checking`                  | 正在等待安全检查完成…                                                                 |
| `conversationShare.progress.checkingFailed`            | 安全检查失败                                                                          |
| `conversationShare.progress.uploading`                 | 正在上传产物…                                                                         |
| `conversationShare.progress.uploadingFailed`           | 上传产物失败                                                                          |
| `conversationShare.result.openInBrowser`               | 去浏览器查看                                                                          |

#### `mode` — 38 键

**上游产品策略差异，不是缺口。** 上游是 per-agent × mode 笛卡积（claude/codex/gemini/glm/opencode 各家一套）。本仓库规范模式集合为 `packages/services/src/session/sessionModeOptions.ts` 的 `CANONICAL_SESSION_MODES = {yolo, plan, edit, auto, autoEdit, build}`，与 provider 无关（`normalizePersistedSessionMode` 的 `_provider` 参数直接忽略）；现有 i18n 恰好只有 `mode.label.glm.*` 覆盖这六个。补全需推翻该设计，或新增永远选不中的死键。

| 键                                          | 官方 zh-CN 译文            |
| ------------------------------------------- | -------------------------- |
| `mode.acceptEdits`                          | 接受编辑                   |
| `mode.default`                              | 默认                       |
| `mode.description.claude.acceptEdits`       | 自动接受文件编辑。         |
| `mode.description.claude.auto`              | 自动选择权限模式。         |
| `mode.description.claude.bypassPermissions` | 跳过权限检查。             |
| `mode.description.claude.default`           | 编辑和高风险操作前询问。   |
| `mode.description.claude.dontAsk`           | 跳过常规确认。             |
| `mode.description.claude.plan`              | 先计划，确认后执行。       |
| `mode.description.codex.agent`              | 编辑和运行命令前保留确认。 |
| `mode.description.codex.agentFullAccess`    | 完整文件和网络访问。       |
| `mode.description.codex.auto`               | 在常规保护下编辑。         |
| `mode.description.codex.fullAccess`         | 无需确认地访问和执行。     |
| `mode.description.codex.readOnly`           | 只读代码，不修改文件。     |
| `mode.description.gemini.autoEdit`          | 自动应用编辑。             |
| `mode.description.gemini.default`           | 使用默认确认策略。         |
| `mode.description.gemini.plan`              | 先计划，确认后执行。       |
| `mode.description.gemini.yolo`              | 减少确认次数。             |
| `mode.description.glm.default`              | 使用默认确认策略。         |
| `mode.description.opencode.build`           | 实施并修改文件。           |
| `mode.description.opencode.plan`            | 先计划，确认后执行。       |
| `mode.label.claude.acceptEdits`             | 自动接受编辑               |
| `mode.label.claude.auto`                    | 自动模式                   |
| `mode.label.claude.bypassPermissions`       | 跳过权限检查               |
| `mode.label.claude.default`                 | 默认模式                   |
| `mode.label.claude.dontAsk`                 | 静默模式                   |
| `mode.label.claude.plan`                    | 计划模式                   |
| `mode.label.codex.agent`                    | Agent 模式                 |
| `mode.label.codex.agentFullAccess`          | 全权限模式                 |
| `mode.label.codex.auto`                     | 自动编辑模式               |
| `mode.label.codex.fullAccess`               | 全权限模式                 |
| `mode.label.codex.readOnly`                 | 只读模式                   |
| `mode.label.gemini.autoEdit`                | 自动编辑模式               |
| `mode.label.gemini.default`                 | 默认模式                   |
| `mode.label.gemini.plan`                    | 计划模式                   |
| `mode.label.gemini.yolo`                    | 全自动模式                 |
| `mode.label.glm.default`                    | 默认模式                   |
| `mode.label.opencode.build`                 | 构建模式                   |
| `mode.label.opencode.plan`                  | 计划模式                   |

#### `codingPlan` — 30 键

额度重置倒计时/提醒，属 coding plan 订阅计费体系。

| 键                                                | 官方 zh-CN 译文           |
| ------------------------------------------------- | ------------------------- |
| `codingPlan.quotaReset.completed`                 | 已重置                    |
| `codingPlan.quotaReset.completedAt`               | {time} 已重置             |
| `codingPlan.quotaReset.contextReminder.available` | {count} 次重置额度        |
| `codingPlan.quotaReset.contextReminder.dismiss`   | 关闭提醒                  |
| `codingPlan.quotaReset.contextReminder.expiresIn` | 重置额度过期              |
| `codingPlan.quotaReset.countdown.daysHours`       | {days} 天 {hours} 小时    |
| `codingPlan.quotaReset.countdown.daysOnly`        | {days} 天                 |
| `codingPlan.quotaReset.countdown.hoursMinutes`    | {hours} 小时 {minutes} 分 |
| `codingPlan.quotaReset.countdown.hoursOnly`       | {hours} 小时              |
| `codingPlan.quotaReset.countdown.minutesSeconds`  | {minutes} 分 {seconds} 秒 |
| `codingPlan.quotaReset.dialog.expiresIn`          | {time}后过期              |
| `codingPlan.quotaReset.dialog.expiresInSoonest`   | 最快 {time}后过期         |
| `codingPlan.quotaReset.dialog.fiveHour`           | 5 小时额度重置            |
| `codingPlan.quotaReset.dialog.itemCount`          | {count} 次                |
| `codingPlan.quotaReset.dialog.remaining`          | 剩余用量                  |
| `codingPlan.quotaReset.dialog.resettable`         | 可重置额度                |
| `codingPlan.quotaReset.dialog.title`              | 可重置额度                |
| `codingPlan.quotaReset.dialog.week`               | 周额度重置                |
| `codingPlan.quotaReset.done`                      | 5 小时额度已重置          |
| `codingPlan.quotaReset.doneWeek`                  | 周额度已重置              |
| `codingPlan.quotaReset.expiresIn`                 | 剩余 {time}               |
| `codingPlan.quotaReset.failed`                    | 重置失败，请重试          |
| `codingPlan.quotaReset.openDialog`                | 获得{count}次重置额度     |
| `codingPlan.quotaReset.opportunity`               | {count} 次重置额度        |
| `codingPlan.quotaReset.processing`                | 正在重置 5 小时额度…      |
| `codingPlan.quotaReset.processingWeek`            | 正在重置周额度…           |
| `codingPlan.quotaReset.reset`                     | 重置                      |
| `codingPlan.quotaReset.resetAria`                 | 重置 5 小时额度           |
| `codingPlan.quotaReset.resetAriaWeek`             | 重置周额度                |
| `codingPlan.quotaReset.success`                   | 重置成功                  |

#### `server` — 12 键

**整块功能缺失，非 i18n 缺口。** `remote.kind.server`「已运行的 ZCode 服务」+ `server.url`/`token`/`workspacePath` 整套连接表单。`packages/shared/src/remoteTarget.ts` 的远端目标类型只有 `ssh | wsl | docker`，无 `server`；新增需扩展 `RemoteWorkspaceIdentity` 的 kind + 连接向导 + 握手。本仓库已有三条远端通路，第四条边际价值低。

| 键                                | 官方 zh-CN 译文                            |
| --------------------------------- | ------------------------------------------ |
| `server.description`              | 连接已经运行的 ZCode server。              |
| `server.name`                     | 显示名称                                   |
| `server.namePlaceholder`          | 例如 Studio                                |
| `server.token`                    | Token（可选）                              |
| `server.tokenPlaceholder`         | 输入连接 token                             |
| `server.url`                      | Server URL                                 |
| `server.urlPlaceholder`           | 例如 https://studio.example.com:3030       |
| `server.validation.invalidUrl`    | Server URL 格式不正确                      |
| `server.validation.urlRequired`   | Server URL 不能为空                        |
| `server.workspacePath`            | 默认目录（可选）                           |
| `server.workspacePathDescription` | 留空后，连接成功时再选择 server 上的目录。 |
| `server.workspacePathPlaceholder` | 例如 /srv/project                          |

#### `zcode` — 11 键

11 条 `providerBusiness.*`（登录失效、免费额度用尽、验证码失败、429/系统繁忙等）。它们是**错误码→文案映射**：报文由模型服务端产生，但接入的 provider 是否会产生这些码不确定；其中「请升级账户」指向本仓库不存在的账户体系，硬补会误导用户。

| 键                                  | 官方 zh-CN 译文                                                |
| ----------------------------------- | -------------------------------------------------------------- |
| `zcode.error.providerBusiness.1005` | 今日免费计划额度已用完。请升级账户、切换模型，或等待额度恢复。 |
| `zcode.error.providerBusiness.1006` | 登录状态已失效，请重新登录后再试。                             |
| `zcode.error.providerBusiness.2007` | 上游服务暂时不可用，请稍后重试。                               |
| `zcode.error.providerBusiness.3001` | 请求参数错误，请检查输入后重试。                               |
| `zcode.error.providerBusiness.3002` | 请求过于频繁，请稍后重试。                                     |
| `zcode.error.providerBusiness.3006` | 当前模型不在可用范围内，请切换到允许的模型后重试。             |
| `zcode.error.providerBusiness.3007` | 验证码校验失败，请重试。                                       |
| `zcode.error.providerBusiness.3008` | 当前系统繁忙，请切换模型、升级账户，或稍后再试。               |
| `zcode.error.providerBusiness.3009` | 当前系统繁忙，请切换模型、升级账户，或稍后再试。               |
| `zcode.error.providerBusiness.3010` | 当前系统繁忙，请切换模型、升级账户，或稍后再试。               |
| `zcode.error.providerBusiness.429`  | 请求过于频繁，请稍后重试。                                     |

#### `marketingTouch` — 7 键

权益触达操作态（准备中/失败/空闲），营销触达链路。

| 键                          | 官方 zh-CN 译文                                                      |
| --------------------------- | -------------------------------------------------------------------- |
| `marketingTouch.failed`     | 操作失败，请稍后重试。                                               |
| `marketingTouch.idle`       | 准备就绪                                                             |
| `marketingTouch.preparing`  | 操作成功，正在准备结果…                                              |
| `marketingTouch.submitting` | 正在处理…                                                            |
| `marketingTouch.succeeded`  | 操作成功                                                             |
| `marketingTouch.uncertain`  | 暂时无法确认操作结果，请稍后查看权益。为避免重复提交，本轮不再重试。 |
| `marketingTouch.verifying`  | 正在验证…                                                            |

#### `startPlan` — 7 键

「你的体验套餐中 {model} 仍有可用额度」——体验套餐推荐，账号侧。

| 键                                              | 官方 zh-CN 译文                                                              |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `startPlan.recommendation.decline`              | 不了                                                                         |
| `startPlan.recommendation.description`          | 你的体验套餐中，{model} 仍有可用额度，是否切换使用？                         |
| `startPlan.recommendation.dismiss`              | 不再提示                                                                     |
| `startPlan.recommendation.preferenceSaveFailed` | 未能保存“不再提示”，本次仍按你的选择继续。                                   |
| `startPlan.recommendation.subagentDescription`  | 你的体验套餐中，{model} 仍有可用额度，是否将此子智能体的模型切换到体验套餐？ |
| `startPlan.recommendation.switch`               | 切换套餐                                                                     |
| `startPlan.recommendation.title`                | 体验套餐有可用额度                                                           |

#### `rewards` — 5 键

「邀请好友」奖励菜单；邀请返利需账号与服务端。

| 键                    | 官方 zh-CN 译文        |
| --------------------- | ---------------------- |
| `rewards.loadFailed`  | 页面加载失败，请重试。 |
| `rewards.menuBadge`   | 奖励                   |
| `rewards.menuTitle`   | 邀请好友               |
| `rewards.openWebsite` | 打开官网               |
| `rewards.title`       | 奖励中心               |

#### `remote` — 2 键

`kind.server` 两条，与 `server` 域同一功能，随 `server` 一并判定。

| 键                                     | 官方 zh-CN 译文     |
| -------------------------------------- | ------------------- |
| `remote.kind.server`                   | Server              |
| `remote.kind.server.wizardDescription` | 已运行的 ZCode 服务 |

---

# C 组：已删功能的遗留痕迹（2 键）

`ssh.assetInstallMode`、`ssh.assetInstallModeDescription`——「资源下载方式：远端服务器下载可减少上传等待，但服务器需要能访问 ZCode CDN」。

上游已删除远端 CDN 拉取、改为一律上传，但语言表与 README 都留下旧痕迹。本仓库全仓 `assetInstallMode` 命中 0 处；README 中遗留的 `ZCODE_REMOTE_ASSET_CDN_BASE_URL` 说明同属此事，应随该配置项的移除一并清理。**本组无需补全。**

# 功能补全工作项清单

> 上游 i18n 缺口 741 键中，54 键对应功能开发，按 10 项工作拆解。
> 本清单按**能否落地**排序；标注「不建议做/做不了」的条目不得作为补全目标。

| #   | 功能                     | 涉及键                                                                                                                                          | 仓库现状（证据）                                                                                                                                                                                                                                                                 | 判定与工作量                                                                                                                   |
| --- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| W1  | per-protocol 端点字段    | `settings.modelProvider.anthropicEndpoint`、`...Placeholder`、`openaiEndpoint`、`geminiEndpoint`、`endpointNoMatch`、`presetEmpty`              | `legacyModelProviderSerialized.ts` 的 `ModelProviderEndpoints` 里 anthropic/openai/gemini 三个字段**已标 @deprecated**，注释写明「仅用于读取旧 provider 配置；新 store 使用 baseURL + paths」。新数据模型是单一 `baseURL` + `paths: Partial<Record<ModelProviderKind,string>>`。 | **不建议做**：补这 9 个键等于把已废弃的三端点模型搬回 UI。要做就等于推翻 v2 catalog 设计。                                     |
| W2  | Claude 模型槽位映射      | `settings.modelProvider.claudeMapping`, `claudeMappingDescription`, `slot.haiku`, `slot.opus`, `slot.sonnet`, `slot.reasoning`, `mappingNotSet` | UI 无槽位映射界面。仓库里 haiku/opus/sonnet 只作底层标识出现（`subagent-markdown-selection.ts` 的 `INHERIT_NAMES`、协议层模型名），`SubagentsSection.tsx` 的模型选择是 `inherit` + 模型列表，不是四槽位。                                                                        | 要新增「Claude 模型 → 四槽位」的映射配置面板与持久化。中等工作量，需 spec。                                                    |
| W3  | 模型 I/O 完整保留开关    | `settings.modelIoFullRetention`、`modelIoFullRetentionDescription`                                                                              | 仓库 41 处 `modelIo                                                                                                                                                                                                                                                              | retention` 命中全是无关项（`zcodeFileCitation.ts`的`.opus` 音频后缀、`logRetention.ts` 的日志轮转），**无模型 I/O 保留设置**。 | 要新增诊断数据保留策略开关。工作量取决于日志/DB 裁剪逻辑现在在哪，需先定位 owner。                              |
| W4  | Agent 切换               | `chat.agentSwitch.failed`, `success`, `switchTo`                                                                                                | `ZCODE_PROVIDERS = ["glm"]`（`packages/shared/src/providers.ts`），只有一个 agent。切换器无对象可切。                                                                                                                                                                            | **做不了**，且不应做：多 agent 是产品形态决策，不是补全。                                                                      |
| W5  | 新建任务的 agent 名称    | `taskList.newTask.claude`, `codex`, `gemini`, `opencode + taskList.selectProvider`                                                              | 同上，`ZCodeProvider = "glm"`。`NewTaskButtonGroup.tsx` 无 agent 选项。                                                                                                                                                                                                          | **做不了**，同 W4。                                                                                                            |
| W6  | 任务菜单「前往配置」     | `appHeader.goToProviderConfig`                                                                                                                  | `settings/model-provider-section/` 供应商配置功能完整（21 个文件），但任务菜单没有跳转入口。经官方安装包全量解包核对，`appHeader` 域 8 个键中仅此键被代码引用，其余 7 个为上游未接线键。                                                                                         | **可做**：1 键，唯一键与功能匹配且无产品决策依赖。对应 spec：[provider-config-menu-entry.md](provider-config-menu-entry.md)    |
| W7  | 子代理权限模式扩展       | `settings.subagents.permissionMode.acceptEdits`, `bypassPermissions`, `default`, `dontAsk`                                                      | `AgentPermissionMode = "auto"                                                                                                                                                                                                                                                    | "plan"`（`subagents-types.ts:29`），只有两值。                                                                                 | 要扩类型 + 解析器（`VALID_PERMISSION_MODES`）+ UI 选项。属行为变更，需 spec，且要确认子代理是否真支持这些模式。 |
| W8  | Codex 网络连通性探测     | `taskList.codexConnectivityUnavailable`                                                                                                         | `NewTaskButtonGroup.tsx`/`TaskList.tsx` 无连通性预热探测。                                                                                                                                                                                                                       | 要新增探测逻辑与提示。与 Codex 相关，而 Codex 不在 `ZCODE_PROVIDERS` 中——**先确认 Codex 是否在我们产品内**。                   |
| W9  | Claude 未知命令错误映射  | `zcode.error.CLAUDE_UNKNOWN_COMMAND`, `_WITH_ARGS`                                                                                              | 全仓 `CLAUDE_UNKNOWN_COMMAND` 0 处；错误码走 `DiagnosticRecord` 的 `errorCode`，没有这张码→文案表。                                                                                                                                                                              | 需先确认 Claude agent 会吐这个码（我们只有 glm）。**大概率死键**。                                                             |
| W10 | 模型服务商业务错误码文案 | `zcode.error.providerBusiness.1005`, `1006`, `2007`, `3001`, `3002`, `3006`, `3007`, `3008`, `3009`, `3010`, `429`                              | 同上，无码表。且文案含「升级账户」「重新登录」「验证码」。                                                                                                                                                                                                                       | **不建议做**：指向本仓库不存在的账户/验证码体系。                                                                              |

合计 54 键：W1 9 + W2 7 + W3 2 + W4 3 + W5 5 + W6 1 + W7 4 + W8 1 + W9 2 + W10 11。W6 原计 8 键，其余 7 个经官方安装包核对为未接线键，已移出。

## 建议执行顺序

1. **W6**（任务菜单「前往配置」，1 键）唯一键与功能匹配、无产品决策依赖，已有 spec。
2. **W2 / W3**（模型槽位映射 / I/O 保留）有实际价值但需 spec 与 owner 定位。
3. **W7** 需先确认子代理能力边界。
4. **W4 / W5 / W8 / W9** 依赖 `ZCODE_PROVIDERS = ["glm"]` 这一产品形态，做之前需先决定是否引入多 agent。
5. **W1 / W10 不做**：前者推翻 v2 catalog 端点设计，后者指向不存在的账户体系。

---

## 相关待办

- README「与官方包的能力差异」表格需按本文件重写：把「尚未补全（共 258 键）」改为三组口径，并将 B 组各域移入「有意不补全」并注明原因。
- README 中 `ZCODE_REMOTE_ASSET_CDN_BASE_URL` 一节为已移除配置的残留说明。
