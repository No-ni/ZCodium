# 官方 3.16.2 CLI/runtime 分区审查（ToolSearch / 模型结束分类 / workflow governor / Bash 输出）

## 范围与状态

审查 `C:/vibecoding/zcodium-adopt-3.16.2` 未提交的 `apps/zcode-cli/packages/{adapters,core,bootstrap}` 中 ToolSearch、模型结束分类/Gemini thoughtSignature、workflow stop/governor、Bash 输出准备与关闭边界。不含 Source/SQLite 与 Office/plugin runtime（其他分区）。状态：四区审查完成；发现 1 个测试级环境耦合 bug 并在本分区修复；无产品代码修改。无 commit/push/build/真实模型/workflow/Bash 产品验收。

## 审查结论（本分区审查范围内未发现产品代码 bug；非全仓断言，边界见「未验证」）

- 模型结束分类：`createEmptyContextExceededError` 仅在无文本、无 reasoning、无 tool call 时按 finish/rawFinishReason 命中 context 集合并先于成功 finish 结算；`isZeroOutputModelCompletion` 排除 refusal/content-filter/context；rawFinishReason 直接字段优先、metadata 兜底（stream/generate 一致）。错误经 `classifyModelFailure→isContextExceededFailure`（code `model_context_exceeded` 命中）→有界预算不重试、无上限预算策略表 `context_exceeded`；失败 usage 沿 `AiSdkModelAdapterError.usage→modelFailureStatusFields→ModelRequestFailedStatusEvent.usage→recordModelUsageFact(failedNetworkEvent)` 单路径结算，不重复计数。
- Gemini thoughtSignature：`resolveDeferredToolCall` 解包保留逐条 `providerOptions`（spread 不改字段）；pending/完成 part metadata 与 hydrate 恢复 `modelCallWrapper`/`providerOptions`；请求副本 wrapper 投影不改 canonical。
- governor：stop 决策（配额/认证/配置/请求）在 `model_request_failed` 只 `ended`，无 cap 削减无 Retry-After 冷却；真并发拒绝（3008 族不在配额集）仍 `throttled`；ticket settled-once 且 release 幂等；恢复准入不重置卡。与 runner/driver 共用同一 `resolveWorkflowModelFailurePolicy`。
- Bash 输出：`prepareBashOutput` 登记 active execution 至 spawn 侧 `registerActiveExecution` 后 `releasePreparation`，close 覆盖异步准备并 discard；仅 `BASH_TEMP_UNAVAILABLE_CODES` 回退 `.zcodium` output root；实际路径先发布到 `outputPathsByRequest`，`outputPathsForRequest` 优先读取，后台 TaskOutput 仍可读；create-app / workflow child / facade 三构造点统一 `bashOutputTempDir`。
- ToolSearch：Off/Auto/Local/Native 解析、目录快照只读、发现不授权、Local schema 不截断、公告 added/removed、compact `tools=[]` + off 投影、subagent/child 构造期读父 mode 不继承发现，均与 `official-3.16.2-tool-search.md` 规则一致。观察项（非 bug）：不支持 wire 显式 Native 时 `resolveToolSearchMode` 在请求前 throw，属 spec 规定的早拒绝。

## 测试 env 卫生 bug（本分区修复）

`apps/zcode-cli/packages/adapters/test/bash-temp-output.test.ts` 的 `FixtureAdapter.prepareChildSpawn` 覆盖绕过了基类 env 组装，`spawn` 未显式传 `env`，子 `node -e` 继承测试进程的 `NODE_OPTIONS`（project-test-sandbox 注入 `--permission --allow-*` 族）；三个被点名的 allow flag 使子进程向 stderr 打印 SecurityWarning，混入 Bash 合并输出文件，断言 `stdout.text === 'fixture output'` 失败（沙箱首跑复现：`.run-logs/project-only-validation/source-tests-rEHkU9/logs/source-tests.log`，2 pass / 1 fail；无沙箱裸跑不显现）。这是测试 child env 缺陷，不是 adapter 行为缺陷。

修复（经隔离实验确定）：显式 `spawnOptions.env` 清空 `NODE_OPTIONS` 无效——`node --test` 宿主带 `--permission` 族 flag 时，Node 会把权限模型传播进子进程的 `NODE_OPTIONS` 并覆盖显式 env（`.run-logs/cli-runtime-review/env-probe.test.mjs` 实测：direct 子进程收到 `""`，--test 子进程收到重排后的完整 flag 串）。fixture 子进程改为命令行 `--disable-warning=SecurityWarning`（`.run-logs/cli-runtime-review/env-probe2.test.mjs` 验证合并文件不再含 warning），断言保持严格等值，不放宽为 contains。这是测试 child env/arg 卫生修复，不是 adapter 行为改动。

## 验证记录（本分区实际执行）

- CLI lint：复用 `verify-gates-ALpSNr/logs/cli-lint.log`（79 errors/55 warnings，exit 1，不宣称通过）；对 `git archive HEAD` 的项目内只读副本（`.run-logs/cli-lint-baseline/sync/`，根 `.oxlintrc.json` 与工作树 cmp 相同）跑同一 oxlint/config/路径集：baseline 135 条、工作树 134 条，**新增诊断 0**；基线独有 1 条为 `migration-runner.ts` no-unsafe-finally（SQLite 分区修复）；22 个既存 max-lines 文件数值增长单列，不视为新增诊断。未改规则、未加 disable、未升 baseline。
- 定向安全测试（`scripts/ci/source-test-runner.mjs` + `project-test-sandbox.mjs`，tsconfig `scripts/ci/tsconfig.adoption-tests.json`，fresh 合成沙箱）：model-completion 6/6（修复后复跑再次 6/6，`source-tests-AfH76i`）；workflow-governor 3/3（`source-tests-wGEO5t`）；tool-search 41/41（`source-tests-a52WOy`）；bash-output 证据链（各目录 `results.json` 实读校正）：修复前失败 `source-tests-rEHkU9`（exit 1，tests 3/pass 2/fail 1）；中间态 env 覆盖方案无效复跑 `source-tests-Li0NEO`（exit 1，2/1，证明 `--test` 下显式 env 清 `NODE_OPTIONS` 被 Node 传播覆盖）；最终 `--disable-warning` 修复后 `source-tests-mYTNQD` 与格式复跑后 `source-tests-M4ZMSi` 均 exit 0、tests 3/pass 3/fail 0/skipped 0。日志均在 `.run-logs/project-only-validation/<dir>/logs/source-tests.log`。

## 未验证

真实模型/Provider API、真实 workflow 运行、真机 Bash 产品路径、GUI、发行；`--allow-*` Node flag 不作为完整沙箱。
