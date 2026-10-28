# 个人 Coding Plan 额度（fork 选择移植）

## 产品规则与移植边界

只支持智谱 BigModel / Z.AI 的个人 `zhipu-coding-plan-api-key` 连接。选当前 Host ProviderSettings View 中第一个启用、厂商端点合法且已填 Key 的连接，不增加多 Key 选择器。普通 API Key、账号、Team/Start Plan 和未知代理不进入查询。原有本地 Agent 使用统计保持独立，不恢复官方账号、购买、重置、更新源或 Linux 依赖。

额度只在页面打开、有效连接/Key 改变或用户手动刷新时查询；不轮询、不持久化额度、不建立全局缓存。同一上下文刷新失败保留上一成功快照并显示错误；新 Key、provider 或 Host 必须立即隐藏旧快照，旧成功和旧失败都不得回写。无返回数据、请求错误、真实零余量是三种不同状态。`getView` 完成后到调用方恢复的微任务间隙也属于换代边界：发出网络请求和接受结果之前必须校验服务此刻的 context，而非 `readContext` 曾返回的旧对象；旧 contextId 不得借用新 Key 发请求。

## 所有者与公共接口

ProviderSettings/Provider Config 是凭据的唯一所有者。UsageStatsService 在目标 Host 内读取该公共服务，不让 UI 新传输任何明文 Key。UI 只消费 `@zcode/services` 的公开额度 context / snapshot 类型和现有 `IUsageStatsService`。

- `getCodingPlanQuotaContext()` 返回脱敏可用连接描述或 unavailable 原因。
- `onDidChangeCodingPlanQuotaContext` 是已有 RPC Event 机制的投影事件；不写业务配置。
- `getCodingPlanQuota({ contextId })` 只接受 Host 签发的 opaque UUID generation；它不是 Key 或 Key hash，切换凭据即失效。
- 服务不存额度；hook 是挂载页面内唯一快照与 loading/error 所有者。

```text
Host Provider Config（唯一 Key 源）
  → ProviderSettings 公共 View / onDidChange
  → UsageStatsService（比较 credential tuple，签发 opaque context）
  → RPC context / event（无 Key）
  → useCodingPlanQuota（service + contextId + request generation）
  → panel

打开 / context 改变 / 手刷
  → hook command(contextId)
  → 同一目标 Host 再读 View / 校验 generation
  → Host ApiClient GET 固定厂商 URL
  → 再读 View / 校验 generation
  → hook 同时校验 Host、context、请求序号及挂载生命周期
  → 接受最新结果；过期、退出页或卸载则丢弃
```

Desktop 与手机均只通过当前 ServiceProvider/RPC 请求所属 Host。远程 attachment 不可用时失败关闭，不回退到本机 ProviderSettings 或 ApiClient；额度不是 session stream，不新增 continuous/replayable 业务状态。

## 真实 Desktop service 合并验收

- `buildRemoteWorkspaceSessionServices(baseServices, remoteServices)` 必须显式选择 `remoteServices.usageStatsService`，与目标 Environment 的 ProviderSettings/Agent 服务保持同一来源。不能因先展开 base accessor 而继续使用本机额度 service；切换后的 service 引用变化交给既有 hook 清空快照并隔离旧请求。
- 远端 Host 继续使用原 fail-closed UsageStatsService：未提供目标 ApiClient/ProviderSettings 时，quota context/query 拒绝，不回退、不注入本机 ApiClient、Provider 或 Key。本地与远端 `getAppUsageSnapshot` 各自仅委托其目标 Agent 的 `getAppUsageStats`。
- 不新增状态 owner、缓存或请求路径。Desktop helper 只选择服务；service/context/request generation 和卸载边界沿用既有 quota hook。Desktop continuous 与 mobile replayable 会话协议不变。

```text
Desktop 本地 accessor → 本地 usageStatsService → 本地 Agent / 本地 Key
切换远端 workspace → 真实 Desktop merge → 远端 usageStatsService
  → service 引用换代 → 既有 hook 清空旧额度、废弃旧响应
  → 本地使用统计请求委托目标远端 Agent
  → quota 依赖缺席则 fail-closed（绝不回到本机 Key/API）
```

新增持久 Vitest 门禁 `packages/desktop/scripts/remoteWorkspaceSessionServices.test.ts`，复用当前仓库的 `packages/ui/vitest.config.ts`。Host 集成测试沿用 Desktop 的 scripts 测试目录，不把 `@zcode/services/node` 引入 renderer 编译范围，避免 Node 全局类型污染浏览器定时器契约。先在未改 helper 时验证失败，再覆盖真实本地→远端→另一个远端合并的 service 引用、quota context/query/订阅仅调用远端 fail-closed service、本机 quota/凭据/网络入口零调用，以及本地和远端普通使用统计分别绑定目标 Agent。CI 接入命令为 `corepack pnpm exec vitest run --config packages/ui/vitest.config.ts packages/desktop/scripts/remoteWorkspaceSessionServices.test.ts`。该测试补真实 Desktop accessor merge 边界，不替代已有 quota service/RPC 与 UI E2E。

## 网络、安全与失败语义

仅接受 HTTPS、默认 443、无 userinfo 的准确厂商主机：BigModel `open.bigmodel.cn` / `bigmodel.cn`，Z.AI `api.z.ai`；不做后缀猜测。查询固定 `https://bigmodel.cn/api/monitor/usage/quota/limit` 或 `https://api.z.ai/api/monitor/usage/quota/limit`，不允许 env/自定义端点替换；`redirect: error` 防止 Key 随重定向泄漏。沿用 Host ApiClient 网络出口与超时。

鉴权 `authorization: <trimmed apiKey>`，不加 Bearer，不发送配置中的任意鉴权或 org/project 头。含 org/project 自定义头的连接不属于个人套餐范围。异常、HTTP body、业务响应 msg/message 不得写入日志或向 UI 返回，使用稳定错误代码。响应须运行时校验，数值必须有限且非负，percentage 按官方 0..100 的已使用百分比归一化为 0..1；完整保留真实 0，不用缺失值构造 0。

缺 data/null/空 limits 是合法无数据；非法 JSON、非法结构、业务失败、HTTP/网络错误是失败。展示主桶优先 TIME_LIMIT，其次带 remaining 的桶；五小时/Token 桶、剩余量、剩余进度及下次重置时间沿用上游展示能力。

## 验收场景与验证

1. 两厂商专用 Key 通过 Host 查询；UI 请求体仅 contextId，凭据不在 context、快照或错误中。
2. 普通 Key、空 Key、账号、禁用连接、Team 头、未知端点都不发额度网络请求。
3. 首个有效连接稳定；非额度配置变化不重新查询。
4. 同 Key 刷新失败保留旧数据；切 Key/provider/Host 时立即清空；迟到成功/失败、移除最后连接、卸载/退出页均不污染当前状态。
5. 空数据、401/业务失败和 remaining=0 分别展示空态、错误、零余量；百分比、重置时间含非法数据验证。
6. 执行 `node --test scripts/ci/coding-plan-api-key-quota.test.mjs`：包括真实 ChannelClient/ChannelServer 序列化与 ProxyChannel 事件订阅、释放、重订阅和不透明 payload 验证。执行 `node scripts/ci/coding-plan-quota-smoke.mjs` 作为持久 Playwright E2E 门禁，覆盖 loading、失败保留、真实零、无数据、Key/Host 切换、离页及迟到成功/失败、无外网，并在中英/明暗/窄宽布局执行；`--serve` 保留人工 GUI 验收入口。原本 local usage fixture 只验证 AppUsagePanel，不能再否定明确授权的独立个人 Key 额度入口。
7. 退役门禁继续拒绝旧账号额度、重置与 entitlement RPC；服务方法清单只额外允许本规格的三项个人 Key 查询/事件接口，不再把独立个人查询误判为账号能力恢复。
8. 实际执行 typecheck/lint/架构检查，已有失败单列，不虚报通过。
