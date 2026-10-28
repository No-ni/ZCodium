# 官方 3.16.2 择项吸收实施收口（2026-10-28）

> 第 1–7 节是此前「独立工作树不提交」阶段的验收快照，保留其未执行项与事故记录，不作为随后整合阶段的当前 Git 状态或最终验收结论。本轮用户已明确授权验证、提交并合入 main；最新整合记录见[未提交成果验证与主线整合](uncommitted-validation-main-integration.md)。

## 1. 此前阶段结论与基线

**多数择项源码已落地，本轮项目内测试隔离与枚举断点已修复；不是完整官方 3.16.2 parity、完整 Source 验收或发行验收。** 根门禁和 CLI 类型检查通过，CLI 全包 Lint 仍失败。Source 历史数据接入的真实停写租约、可信快照及迁移确认 UI/channel 尚未接通，保护没有绕过。

- 唯一实施工作树：`C:\vibecoding\zcodium-adopt-3.16.2`，detached HEAD `18cc72cef7bec53eaa543b515e0c9332bc9cd05b`。
- 原工作树 `C:\vibecoding\zcodium` 与官方快照 `C:\vibecoding\zcodium-upstream-3.16.2-review` 只读。
- 官方固定来源：`zai-org/ZCode@3c5b227649371507ddc4eb46ac5133afe6db1cab`。没有 merge 官方快照，也没有改写 Git 历史。
- 根产品版本仍为 `3.15.1`；CLI 顶层版本仍为 `0.16.9`。
- freshness 使用 `--no-fetch` 核对缓存：adoption 无 tracking branch，相对 `origin/main` ahead 31 / behind 0。没有重新刷新远端。
- 本机 Node `24.18.0`，`mise.toml` 固定 `24.14.0`；pnpm `10.33.2`。未安装或切换工具链，不把结果写成固定小版本或跨平台验收。
- 未 stage、commit、push、发 PR/issue、触发 Actions、打包、发行、安装插件/系统服务、迁移或恢复真实用户数据。

原始方案见 [总交接](official-3.16.2-adoption-handoff.md)。下文区分此前已交付源码、本轮实际复跑和明确未验收，不把旧 spec 的“开工缺口”或历史通过结果当作最终树证明。

## 2. 数据安全约束与事故披露

用户明确禁止项目外修改。本轮人工编辑、测试合成数据、缓存和验证日志只写获准工作树；不读取真实用户 `.zcodium`，不运行旧全量/分片 TEMP 运行器，不清理历史事故目录，不擅自恢复丢失文件。

此前记录包括两类事件：

1. 曾在系统 TEMP 的 `full-ci-home` 重定向 HOME 等目录并使用递归清理；用户报告电脑数据丢失，附件还记录真实 `.zcodium/cli/plugins` 目录消失和 node-repl-host 缺失。现有证据不足以确定完整损失清单和因果，不能缩写成只有一次 setting 写回。
2. 首次 Settings 红测试未隔离 bootstrap home，实际读取并写回真实用户 setting。没有可靠前像，因此未自动回滚，避免覆盖后来配置。后续 sentinel 通过不能抹掉这次历史例外。

本轮不复现这些事件，不读取或清理相应用户/TEMP 目录。宿主工具可能自动保存自己的会话/执行记录；这是宿主行为，不把项目脚本的写入约束扩大为已经证明“整个系统项目外零写”。

## 3. 本轮直接修复与唯一验证 owner

验证环境唯一 owner 为 `scripts/ci/project-test-sandbox.mjs`；`runSourceTests` 和 `project-only-verify.mjs` 消费同一 owner，不另建用户数据根。

- 运行根位于 `.run-logs/project-only-validation/<label>-<随机后缀>`，每次新建，不复用旧目录。
- 创建前后逐级 `lstat`/`realpath` 校验绝对路径，拒绝项目根、卷根、相对/项目外路径及 symlink/junction 写穿。
- 一次性绑定 HOME、USERPROFILE、Desktop home、AppData、TEMP/TMP/TMPDIR、XDG、应用 storage/session、日志与 npm/pnpm/Turbo 缓存；清除大小写不敏感的继承 persistence 变量和 Node compile cache。
- 禁止 Corepack 网络、自动 pin、更新提示、资源采样和遥测，只读消费已安装工具。Node Permission Model 是附加文件写白名单，**不是原生 SQLite/native addon/任意 shell 的完整系统沙箱**；允许 child/addon/worker 的运行也不能据此宣称全系统隔离。
- Source、枚举、SQLite 与 loopback RPC 回归改为项目内合成 fixture；不再递归清理整根。测试关闭自己拥有的连接并恢复自身环境变量，保留数据和日志。
- `runSourceTests` 在加载业务前校验文件，清除 `NODE_TEST_CONTEXT`，绑定可选 TSX tsconfig，等待真实独立子进程。成功/失败 TAP、stderr 和结构化结果使用独占创建保存在该 child sandbox；原失败继续传播，零测试拒绝。
- Bootstrap 枚举两个 mock 显式声明 `this: SqliteSessionStore`，修复 TS2683；根组合精确计数由 5 更新为 7。自有 store 查询失败必须 close，借用 store 不配置、不关闭；没有用删除目录证明 close。
- SQLite infrastructure/startup/schema-baseline 与 Source inspection RPC 采用根 wrapper + `scripts/ci/fixtures` 测试本体，防止外层无隔离 runner 过早结束和全局 mock 污染。

```text
项目真实根 -> 路径/链接校验 -> fresh 项目运行目录
  -> 同一环境 owner 绑定 home/temp/data/cache
  -> 独立测试/类型/Lint 子进程 -> 受控 fixture 或项目源码输出
  -> 等待进程/连接结束 -> 保留详细结果与合成数据，不递归清理
```

### baseline 更新入口的明确限制

移动测试本体后，根 wrapper 原先静默忽略 `--update-reviewed-baseline`。本轮将根入口与 fixture 都改为在加载业务/创建 fixture/写文件前明确拒绝 `SQLITE_SCHEMA_BASELINE_UPDATE_NOT_SUPPORTED`，不向通用 runner 开放基线写权限。两条回归验证非零退出、未创建子目录和两份 schema baseline 字节不变。历史更新入口已退休，不能再照旧命令更新；本轮没有修改冻结 schema、Host 三条 JSON checksum 或 CLI 23 条 SQL-trim checksum。

### 共享 runner 的兼容性范围

实际复跑包括 Source、SQLite/RPC、模型目录两个 wrapper、runner 自测及既有 `hidden-document-motion-pause` 无 IO 副作用消费者。后者根 3 项通过，内部可见性回归 3 项通过。

`automation-lifecycle`、`local-observability`、`shared-state-stability`、`workflow-enhancements` 等其他消费者只做了静态入口/临时路径核对，没有执行完整套件；其中仍有 `tmpdir()` + 递归清理或独立 Vitest 子进程等历史实现。即使 runner 会绑定 TEMP，也不把环境重定向当作这些所有写者与清理代码已审查的证明。本轮不冒险运行或大范围改写它们，不声称共享 helper 的所有消费者全兼容。

## 4. 已落地吸收、保留能力与剥离边界

以下是当前源码状态，不表示本轮逐一完成真实产品验收。

| 项目                     | 当前源码状态                                                                                                               | 本轮证据边界                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 工作流停止类错误         | 复用 `resolveWorkflowModelFailurePolicy`，stop 只 ended，真限流仍 throttled，同一 governor ticket                          | 源码/图种子及类型检查；没有真实 workflow/model                                                    |
| 模型空响应               | stream/generate 共用结束分类，明确 context/refusal/filter，保留 partial 与失败 usage                                       | 源码/类型检查；没有真实 Provider                                                                  |
| Bash 输出                | adapter 准备 owner 先发布实际路径再启动，取消/close 等待收尾，输出保留                                                     | 未在本轮运行原 OS-temp Bash corpus；没有实际 shell 产品验收                                       |
| Radix 与 Windows 未读    | hidden 跳过测量，保留本仓动画；Windows overlay/tray 消费既有未读投影                                                       | 源码/类型检查；未做收益测量或 Windows DPI/任务栏真机验收                                          |
| MiMo 2.6 模型目录        | 择叶加入 pro/flash、Token Plan API 模板和公开推理 map；保留个人覆盖及既有 Gemini                                           | 目录/schema 9 项、投影 5 项离线回归通过；不等于远端模型可用                                       |
| ToolSearch               | 默认 Off，auto/local/off 设置，Native 仅真实 wire capability；wrapper 复用执行/审批/Hook，保留逐 tool-call Gemini metadata | 本轮设置 5 项通过；此前 77 项与 UI mock 等记录保留，未在本轮完整复跑，GUI/真实 beta endpoint 未验 |
| Source/daemon            | Source/Profile/连接管理、授权、rebind、provisioning v2 和目标额度接缝已落地，保持单 Host/registry owner                    | 已审查 source/mock/loopback 回归通过；未启动真实 daemon/SSH/服务安装                              |
| Source 数据根            | 唯一 `resolveSourceDataRoots` 固定 settings/provider/tasks/CLI roots，Source 修改数据根入口早拒绝                          | layout 4、组合 5、CLI 11、bootstrap 枚举 7 项通过                                                 |
| SQLite 框架              | 异步 startup owner、冻结 checksum、备份失败阻断、restore/schema guard                                                      | 本轮真实项目合成库 27+20+2 项及 schema contract 11 项通过，不是真实用户库/逐历史版本样本          |
| Workspace alias/snapshot | preview/确认/多阶段恢复框架源码已有，当前 Node snapshot fail closed                                                        | 本轮未重跑历史 alias/WAL corpus；真实全根 authority、可信 snapshot 与 UI/channel 尚缺             |
| 手机窗口目录             | 整组可选能力/就绪边界已有，continuous 与 replayable 不合并                                                                 | 类型检查及既有源码合同；没有手机设备或真实 attachment 验收                                        |
| 模型/思考菜单、完整视图  | 复用选择提交 owner；单 SessionPane/composer、桌面完整视图边界                                                              | 离线源码/函数回归 8、8+2、composer probe 1 项通过，不是浏览器 E2E                                 |
| Office 共同阅读与分发    | 阅读 runtime、四插件/viewer 已有；shared build 契约供 Desktop/prebuild/dev/SEA 使用                                        | 本轮只读核对公共接线；未运行四格式编译、seed、SEA、安装或 GUI                                     |

Office 公共接线不再缺失：`BUILTIN_OFFICE_PLUGIN_BUILD_SCRIPT`、`buildOfficialPluginRuntimes`、`buildRemoteOfficialPluginRuntimes`/`stageRemoteOfficialPlugins`、`buildOfficeDevPluginRuntimes` 与 SEA 四 Office 条目均已从当前源码核对。完整旧 dist 不替代当前 build；staging 先验源，再替换旧 dist。Office spec §9.4 的旧缺口是开工快照，不作为现状；本轮没有执行这些产品构建入口。

保留本仓已有 Gemini 原生协议/逐 tool-call thoughtSignature、自带 Key 额度、动态工作流 holes/journal/owner/lease、LAN/自托管 relay、CommandInbox 及两种交付语义，不把它们记为本次重造能力。

继续剥离官方账号/登录/OAuth 控制面、购买/套餐资格、官方额度/分享/上传、自动 model-I/O 记录、遥测、client config/rollout、官方 relay/更新 fallback、Linux 桌面及远端资源 producer。正常用户 Provider API 和个人 Key 额度不属于官方平台依赖。没有配置自有更新源时不回退官方。

## 5. 本轮实际验证结果

所有以下测试均在项目内 fresh sandbox 执行；根 wrapper 的 `tests: 1` 不与内部用例重复相加，精确 child 数来自其独立 `results.json`/TAP 与 wrapper 断言。没有全仓单测总数或“全量通过”结论。

### 类型、Lint、格式及架构

| 命令                                                | 实际结果                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------- |
| `corepack pnpm typecheck`                           | exit 0                                                                           |
| `corepack pnpm lint`                                | exit 0，0 warnings / 0 errors，3308 files                                        |
| `corepack pnpm fmt:check`                           | exit 0；文档落地前 3836 matched files，文档收口后复跑为 3837；没有全仓自动格式化 |
| `corepack pnpm architecture:check --changed`        | exit 0，0 violations / 0 baseline / 0 new                                        |
| `corepack pnpm --dir apps/zcode-cli typecheck`      | exit 0                                                                           |
| `corepack pnpm --dir apps/zcode-cli lint`           | **exit 1，55 warnings / 79 errors**，1498 files；错误主要 max-lines              |
| `corepack pnpm --dir apps/zcode-cli registry:check` | exit 0                                                                           |
| 枚举与 Source CLI test 两个严格 `tsc --noEmit` 配置 | 均 exit 0                                                                        |
| `git diff --check`                                  | exit 0；新文件另由格式/定向回归覆盖                                              |

CLI Lint 失败没有放宽规则、添加 disable、更新 baseline 或大范围拆无关文件。历史 ToolSearch 记录有 134 个诊断与 HEAD 的对照，本轮没有在最终树重新执行完整双树对照，不把全部当前失败重新证明为“没有新增”。根/CLI typecheck 的既有 TUI 与类型库准备仅写项目内源码输出，属于源码检查，不是 exe/dmg/SEA 发行打包。

### 隔离、Source 和 SQLite

- Sandbox：6/6，通过路径拒绝、敌意 persistence/cache env、fresh 目录、junction、Node child 写权限和无整根递归清理断言。
- Runner：1 根用例通过，内部成功、预期失败传播/留档、缺文件和项目外路径拒绝均验收。
- Source：layout/settings/env 4；组合 5；CLI persistence 11；bootstrap enumeration 7，均通过。
- Baseline 旧更新参数：2/2，明确拒绝且冻结文件不变；在 Source 和 SQLite 两组重复执行，不重复计总数。
- SQLite：infrastructure 27；startup adapters 20；schema baseline 2，均通过。
- Source inspection RPC：4/4，只使用 loopback ephemeral port、合成 token/数据，没有真实 daemon。
- Schema contract：11/11，在离线组通过。

### 已审查离线组

ToolSearch Settings 5、Source management 4、authorization 7、bind handler 6、provisioning lane 7、target quota 3、model menu 8、full view 8、workbench 2、composer toolbar probe 1、schema contract 11、bundled catalog 9、catalog projection 5、audit boundaries 9，全部 exit 0。这些是源码/函数/mock/内存或合成数据库断言，不是 GUI/设备/真实网络验收。

### 项目内证据索引

以下路径均相对本工作树；`children/source-tests-*/results.json` 与 `logs/source-tests.log` 是真实 child 明细，外层 `results.json` 是命令/根 wrapper 结果。

- [Source 与隔离结果](../../.run-logs/project-only-validation/verify-source-3sPryc/results.json)
- [SQLite/RPC 结果](../../.run-logs/project-only-validation/verify-fixtures-leiQoI/results.json)
- [离线产品与审计结果](../../.run-logs/project-only-validation/verify-readonly-QJ111U/results.json)
- [定向严格类型结果](../../.run-logs/project-only-validation/verify-enumeration-types-AzDitW/results.json)
- [根门禁与 CLI Lint/registry](../../.run-logs/project-only-validation/verify-gates-gofOtr/results.json)
- [CLI 79 errors / 55 warnings 完整日志](../../.run-logs/project-only-validation/verify-gates-gofOtr/logs/cli-lint.log)
- [CLI 全包类型结果](../../.run-logs/project-only-validation/verify-cli-types-pHzzpV/results.json)
- [既有无 IO 消费者兼容结果](../../.run-logs/project-only-validation/runner-compatibility-0xu4Qm/results.json)
- [功能图路径/符号检查](../../.run-logs/project-only-validation/final-graph-review-aNwO7H/results.json)
- [文档收口后门禁、真实 child 计数与原树保护指纹](../../.run-logs/project-only-validation/final-delivery-review-hs99z5/results.json)

文档落地后只读复跑 Lint/格式/架构/diff 全部通过。该证据中的 Source child `exitCode: 1` 是 runner 自测故意抛出 `EXPECTED_FIXTURE_FAILURE`、由 `assert.rejects` 验收的预期失败，不是 Source suite 失败。最终 Git 状态为 495 条记录，tracked diff 329 files / +8052 / -6095；包含开工前和其他 WIP，不是本轮独占贡献。只读进程核对未发现仍在运行的本轮 `project-only-verify.mjs` Node 进程，未 kill 其他进程。

## 6. 仍未验收或未实现

1. **Source 历史数据闭环仍未完成。** `sourceWorkspaceAdmission.ts` 对 history-present/unavailable 明确阻断；inspection 是 DB/sidecar/config 媒体存在性检查，不能证明旧 key 归属或全根零写。首次创建库后的同 Source 重连也可能保守 overblock，不承诺已有库可正常接入。
2. 两库、全部 config roots、所有进程写者的真实 writer lease 尚未接线。`writersStopped: true` 只是调用者声明/用户确认，不是实际停写证明。
3. Node committed snapshot 只读观察后以 `snapshot-unproven`/`snapshot-stale` 拒绝，不发布可信业务 image、不调用 consumer。需要可信原生后端，不能用重复 hash、假 lease 或客户端布尔绕过。
4. preview/confirm/execute/retry/report/restore 的 Host channel 和用户 UI 闭环尚缺；alias 框架和合成 authority 不等于生产已可迁移。
5. 未执行真实模型/API Key、真实 workflow/Agent、SSH/daemon/远端安装、市场/插件安装、Windows taskbar/DPI、浏览器 GUI/E2E、手机设备、完整 Office GUI/编译/seed/SEA、生产包/升级。
6. 未执行完整 root/CLI corpus、历史 OS-temp Bash/alias/WAL/Office 测试、所有 runner 消费者、固定 Node 24.14.0、macOS 或通用 Server/CLI 跨平台验收。没有恢复/下载/内嵌 Linux 发行资源。
7. 功能图是源码发现索引，不是产品 authority。当前 67 nodes / 87 edges，路径/符号/端点/rank 无结构问题；24 个 seed 引用仍未跟踪，保留 `graph-drift-candidate`，不为关闭追踪提示 stage/commit。

## 7. 原工作树保护核对

原工作树 HEAD 始终为 `18cc72cef7bec53eaa543b515e0c9332bc9cd05b`。本轮核对的 SHA-256 与此前保护快照一致：

- `git diff --binary`：`80ed7e454c3683836d6cb34aef88290ac2f44c8251e8d3b3fd8d217aaddc44cf`
- `git status --porcelain=v1 -z`：`d7dfb5c4f0d17e5f220d14b4a20ac177767f2fe67933c38a1ecedbe737576940`

这只覆盖 tracked diff 与 status 记录，不是原树所有未跟踪内容、电脑全部数据或历史损失的完整指纹。获准 worktree 原有大量无关 WIP 保留，未恢复模块、未丢弃本地改动、未清理运行根或项目外目录。所有本轮启动的验证子进程均等待退出；没有按进程名称批量终止服务。
