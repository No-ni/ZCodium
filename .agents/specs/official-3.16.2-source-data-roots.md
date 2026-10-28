# 官方 3.16.2 standalone Source 数据根隔离

## 范围与现状

仅在 adoption worktree 修复 standalone Source daemon 的 settings 与 Agent CLI persistence 根组合。原工作区、官方快照只读；不提交、推送、改版本、打包或运行真实 Core/daemon/OS service。测试目标是不访问真实用户数据，但首次红测试有一例实际读写真实 bootstrap setting，例外及处置见下方验证记录。旧数据根子任务的持久记录为 stopped，仅留下本 spec，主线程接管收尾；不恢复或打断旧子任务。工作区 ready 检查、Main/Host rebind 与 Source workspace/validation 合同保持既有边界。

已有 `ServerLayout.dataBaseDir=<serverRoot>/data` 只隔离了 Services paths/provider/task。Settings 一直从 Desktop bootstrap home 读写；Agent CLI 没有消费 `ZCODE_DATA_BASE_DIR`，storage/session 默认仍是 HOME。CLI 默认 config 也在 HOME，读取可触发旧插件字段写回，因此不能只修 session DB 的 env。

## 唯一所有者与公开路径合同

- `ServerLayout` 与 Source 启动组合拥有根；`@zcode/shared/node` 的纯函数 `resolveSourceDataRoots(serverRoot)` 是唯一 Source 业务根 resolver。它不创建目录、不读文件、不探测 HOME；显式 root 必须是非空、无 NUL、非卷根的绝对路径。生命周期入口继续使用现有 canonical server root 收敛 symlink/缺失祖先，不新增迁移。
- `resolveServerLayout` 复用同一 resolver 并公开下面的字段；Services 和 CLI 只能消费该公开合同，不重新从 HOME 猜根。一个 Core 进程对应一个 Source root；不同 Source 通过各自 Core/Agent 进程隔离，不在同进程并列注册多个全局 Services data base。
- `createSettingService` 使用最窄的显式 `settingsFilePath` 注入；`fixedDataBaseDir` 声明 Source 不可通过偏好迁移改变数据根。工厂捕获已校验的路径值，不保留调用方可变 options 引用作为写入 authority。没有新增全局 settings 环境变量。未注入的 Desktop 继续使用 `ZCODE_DESKTOP_HOME_DIR > HOME > USERPROFILE > homedir()` 下的 bootstrap setting。
- `createLocalServices` 的 standalone 分支在任何服务初始化/IO 前解析显式 `sourceServerRoot`（缺省读取已存在的 `ZCODE_SERVER_ROOT`），绑定 Services data base 与 Source setting，并拒绝注入其它 setting authority；非 standalone 分支不变。

以 canonical `R=serverRoot` 为基准，所有路径均为绝对路径：

| 字段                                | 路径/意义                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `serverRoot`                        | `R`，安装与 Supervisor owner                                                 |
| `dataBaseDir`                       | `R/data`                                                                     |
| `dataRoot` / `storageDir`           | `R/data/.zcodium`，CLI storage 及业务根                                      |
| `configRoot` / `providerConfigRoot` | `R/data/.zcodium/v2`                                                         |
| `settingsFile`                      | `<configRoot>/setting.json`                                                  |
| `taskDatabasePath`                  | `<configRoot>/tasks-index.sqlite`                                            |
| `cliConfigFile`                     | `<storageDir>/cli/config.json`                                               |
| `sessionDatabasePath`               | `<storageDir>/cli/db/db.sqlite`，沿当前 CLI 数据库合同，不另建 `sessions.db` |

Personal Provider Config 复用 `@zcode/provider-node` 的 `PERSONAL_PROVIDER_CONFIG_FILE_NAME`，实际为 `<providerConfigRoot>/provider_config.json`；内嵌 Built-in Config 在 Source `configRoot` 物化，显式 Built-in 文件覆盖仍是既有只读输入合同。Tasks、credentials、旧 v2 sessions 等 Services paths 随唯一 data base，不引入第二份索引或假 lease。

```text
绝对 server root -> canonical ServerLayout / resolveSourceDataRoots
  -> Supervisor launch env（root-owned persistence 字段最后覆盖）
  -> Core：先确定 Source config root，再物化随包配置
  -> createLocalServices：绑定 data base + 显式固定 setting 文件
  -> 现有 setting write queue / 文件锁 / atomic commit
  -> Source-specific Agent command/env 组合
  -> Agent config（Source persistence authority 最终固定）
  -> CLI storage/session DB 与 Services task/provider 各自现有写者

restart(R) -> 同一组路径 -> 读取原 Source 数据
start(R2)  -> 不同路径   -> 不读取或搬移 R/Desktop 的数据
```

本改动不涉及 live stream、snapshot、CommandInbox、owner/lease、Desktop continuous 或 mobile replayable 语义；两种 attachment 仍访问同一 Source 事实。

## 启动环境与优先级

1. Root 来自用户显式 `--server-root` 或既有安装默认选择，canonical 之后根由 Source owner 固定。继承的 `ZCODE_DATA_BASE_DIR` 可以参与既有默认安装 root 选择，但不能重写已经选择的业务根。
2. Source env 组合保留 HOME/USERPROFILE/桌面 home、命令、参数及其它非 persistence env，不通过伪造 home 隔离。固定下发 `ZCODE_SERVER_ROOT`、`ZCODE_DATA_BASE_DIR`、`ZCODE_STORAGE_DIR`、`ZCODE_SESSION_DB_PATH` 与旧 `ZCODE_SESSION_DB` alias；同名大小写变体先移除，避免 Windows spawn 选择继承值。
3. 显式 `ZCODE_AGENT_SERVER_COMMAND`/参数保留其既有最高命令选择优先级；release/bundled Agent wiring 不覆盖显式命令。release wiring 与普通 command env 可以覆盖非 persistence 配置，但 Source 根组合在最后覆盖 persistence 字段。
4. Services 用 Source-specific resolver 包装既有 Agent command resolver，不改变通用 ProcessManager 的 `process.env < resolveSpawnEnv < command.env` 规则。Source storage/session/data/root 与同一 ProviderRuntime 的个人/内置配置路径在该 wrapper 中固定；Desktop/custom 非 Source command env precedence 不变。
5. CLI 只有存在 `ZCODE_SERVER_ROOT` 时进入 Source persistence 分支：默认 config 指向 `cliConfigFile`，读之前拒绝不同显式 user config 路径；storage/session 在普通 default/user/project/env/CLI 合并之后固定为 Source resolver 值。Source 标记/显式路径校验置于 config adapter 的私有 `source-persistence.ts`，只消费 shared 根 resolver，不另建状态、IO 或配置 owner。非 persistence 字段仍按原优先级。普通 CLI 未设置 Source marker 时的 HOME 默认、storage/session 显式覆盖与 custom data base 契约不变；不把 DATA_BASE_DIR 泛化成 CLI 的新全局默认。

## Settings 操作与迁移边界

- Source `get` 只读取注入文件，返回 `dataBaseDir` 的 Source 固定投影；历史/手改 Source setting 中指向 Desktop 的 `dataBaseDir` 不产生根切换或数据复制。
- Source `update({ dataBaseDir: ... })` 与 `updateDataBaseDir(...)` 均以稳定 `SOURCE_DATA_BASE_DIR_FIXED` 错误拒绝，包含清空/相同值调用；在入写队列、创建 lock、copy 或写文件之前拒绝。普通偏好更新仍经过既有队列和原子写，保留 Source 文件内的合法字段。
- 缺失/相对/卷根 Source root、相对 settings override、替换 Source setting authority 均 fail closed，不退回 Desktop。路径错误不把真实路径写入诊断。
- Desktop bootstrap setting 仍在 home；既有显式 `updateDataBaseDir` 继续复制 `.zcodium/v2` 业务数据并排除 bootstrap setting 及 transient siblings。本次不改 `copyDataDirectory`、不自动搬移/合并/导入旧 Desktop/HOME 数据。
- Source root 内预先存在的用户 symlink/reparse point 不在本次纯路径 resolver 中建立新沙箱保证；沿既有 canonical root 与具体 storage/alias 安全检查。测试不声称验证任意重解析点攻击或全部写者租约。

## 项目内验证边界（2026-10-28）

用户明确禁止再次修改项目外文件。本轮唯一实施根为 `C:\vibecoding\zcodium-adopt-3.16.2`；原工作树和官方快照只读。上一轮系统 TEMP 下的全量/分片运行器、清理脚本及遗留目录不再运行或清理，真实用户 `.zcodium` 不读取、恢复、迁移或重建。用户报告电脑数据丢失，附件同时记录插件目录消失；现有记录不足以确认完整损失清单及因果，不将其缩写为只有 bootstrap setting 写回。

- 验证的唯一环境 owner 为 `scripts/ci/project-test-sandbox.mjs`：在工作树的 `.run-logs/project-only-validation` 下创建不复用的运行目录，先逐级 `lstat/realpath` 拒绝 symlink/reparse point 与项目外路径，再创建 HOME、USERPROFILE、Desktop home、AppData、temp、配置、存储、日志和缓存目录。继承的应用持久化变量先去除，再一次性绑定项目内路径；安装工具、Corepack 网络和遥测关闭。这里只改变验证子进程环境，不更改系统/当前宿主的用户配置。
- `runSourceTests` 消费同一个 owner，逐文件确认真实路径在项目内，隔离子进程仍负责 mock 与非零/精确计数。子进程退出后，成功和失败的 TAP/stdout、stderr 与结构化结果都只保存在本次 sandbox 的 `logs`/`results.json`，使用独占创建，不覆盖旧日志；失败继续传播原错误，测试数为零也作为失败记录。Source、SQLite infrastructure/startup/schema-baseline 及 inspection RPC 的根入口保持可直接运行的 wrapper，测试本体位于非自动发现的 `scripts/ci/fixtures`；即使外层 CI 未绑定 sandbox，wrapper 也必须先建立隔离环境再导入业务模块。每次运行保留项目内合成数据，不在 finally 递归删除整个运行根。测试自身如需重开验证，必须先关闭其拥有的 SQLite 连接；不得以删除真实目录证明 close。
- Source 两个 JS fixture、CLI persistence、bootstrap 枚举及 runner 回归改用显式项目内 fixture。枚举新增两条 owned-query 失败关闭断言的 mock 显式声明 `this: SqliteSessionStore`，精确用例数从 5 更新为 7，借用 store 的所有权语义不变。
- 回归先验证项目外路径、卷根、相对路径、根目录、已存在 symlink/junction 均被拒绝且无写入；子进程读取 HOME/temp/路径变量必须与 sandbox 一致。Node permission 写入白名单作为额外验证门禁，只允许本次运行目录/明确的项目输出；不把 Node permission、环境变量或路径检查声称为原生 SQLite、任意 shell 和所有业务写者的完整系统沙箱。
- 本轮不执行未经逐项审查的全仓 CI、真实 GUI/daemon/远端/模型、Office 产品打包或历史事故目录清理；门禁仅运行可证明项目内写入的命令。SQLite infrastructure/startup/schema-baseline 和 Source loopback inspection fixture 同样改为显式项目内目录、不递归清理；跨进程写锁 fixture 只杀自己创建并记录的子进程，数据库连接关闭后保留合成文件。不带 baseline update 参数，不改冻结迁移。CLI 既有 typecheck 的 TUI 与类型库输出经当前配置及真实路径核查后仅写项目，属于源码检查而非安装包发行。未跑项及失败如实留在最终记录。

```text
项目真实根 -> 路径/链接校验 -> 新建项目内运行目录（不复用）
  -> 同一个验证环境 owner 绑定全部 home/temp/data/cache
  -> 独立 Node/类型/Lint 子进程 -> 受控 fixture/源码输出
  -> 等待进程与连接结束 -> 保留日志与合成数据（不递归清理）
```

## 定向回归与验证

先建立真实失败回归。当前测试全部写入获准工作树内的 fresh sandbox，连接关闭后保留 fixture，不再使用或递归清理系统 TEMP。允许 Node 假 Agent 子进程读回 env/写项目 fixture，但不启动真实 Core/daemon/安装服务；另列 Source inspection RPC 只监听 loopback。根 `scripts/ci/*.test.mjs` 入口复用 `runSourceTests` 的独立子进程等待和非零测试数检查，实际回归文件放在非自动发现的 fixture 目录，避免无隔离外层 runner 在动态加载期间提前结束。每个 Source 的 Services 模块加载/全局 data base 状态使用独立测试进程，避免测试之间污染。CLI 每个用例临时设置实际进程 HOME/USERPROFILE/桌面 home，而非仅向 `createConfig` 注入 env 字典；加载默认配置前验证 `homedir()` 等于该项目目录，finally 仅恢复环境。文件存在性断言只将 ENOENT 判为缺失，其它 IO 错误必须失败。

必须覆盖：

1. 相同 root restart 布局/env 稳定、不同 root 的 setting/task/config/storage/session 根互异，canonical root 合同与绝对路径拒绝。
2. 敌意继承 Desktop data/storage/session aliases，以及 release/command env 覆盖，在真实 Node 假 Agent spawn 中均不能重定向 Source；HOME/USERPROFILE/桌面 home 不被改写，非 persistence command env 仍最高。
3. Desktop bootstrap sentinel 保持字节不变；Source settings 读/迁移/更新只触及各自文件，同 root 服务重建读到偏好，不同 root 不串写。
4. Source `get` 忽略手改 dataBaseDir；两条修改入口均拒绝且无 copy/lock/写文件，Source/目标/temp Desktop sentinel 不变。
5. 非 Source settings 仍支持 home bootstrap 与 custom data base 显式迁移，复制排除 setting/transient siblings；普通 CLI 默认和 env 覆盖不改变。
6. Source CLI config 默认/显式路径拒绝、project/user/CLI storage override 不能逃出 Source；实际项目 fixture SQLite session store 创建与重开，各根彼此不可见。Provider/Tasks 用当前公开 paths/provider 合同核对，测试不运行 Agent 模型或真实 daemon。
7. 实际执行定向回归、目标类型检查、根 `corepack pnpm typecheck`/`lint` 与架构检查；记录真实通过/失败/环境限制。Windows 本机 Node 与 mise pin 不一致时明确报告，不安装新工具。

### 续接收口：测试路径与独立执行

- 将组合回归移入 `scripts/ci/fixtures` 后，生产源码读取必须仍从仓库根解析，不能沿用旧目录的两级相对路径。先执行根聚合入口复现缺文件，再修正为三级路径；保留五个组合断言和原十个 CLI 断言，新增公开启动取消用例后 CLI 精确计数为十一，不通过跳过或减少计数修绿。
- 根聚合入口只负责等待独立子进程、检查非零测试数及精确用例数量；子进程负责完整装载、mock/环境生命周期与失败传播，不在外层无隔离 runner 中动态装配 Services。
- Source persistence 的配置路径校验与最终 storage 投影由私有 `source-persistence.ts` 统一表达；`createConfig` 和 `resolveWorkspaceStorageDir` 只消费该同一合同。普通 CLI 的优先级、配置诊断和公开接口不改变，不为新增接线制造另一处超过 400 行的文件。既有 Hook source 标注纯函数独立到相邻 helper，仍由同一 config factory 调用，不新增装载/提交路径或状态。
- Source 的公开 `openStartupSqliteSessionStore` 必须委派给现有异步类工厂，首次创建、同根重开、不同根不可见及取消都通过该公开入口实际执行；同步 constructor 仍只是已准备账本验收，不能重新成为迁移 owner。
- Bootstrap 的 `listZCodeSessions` / `resolveLatestSession` 必须等待上述公开工厂完成后才读取会话。借用注入 store 时不调用配置工厂、不关闭借用资源；自己创建的 store 无论查询成功或失败都按既有 finally 关闭。独立项目 fixture 回归覆盖两入口首次空库、Source A/B 隔离、父会话筛选、directory/limit 与借用 store 的成功/失败生命周期；根组合 wrapper 等待该子进程并验证精确七个用例，不启动 Agent 或模型。

### 首次红测试隔离失误

首次新增 Settings 红测试的拒绝用例没有设置临时 bootstrap home。旧工厂忽略注入 options，`update({ dataBaseDir: undefined })` 未按新契约拒绝，实际执行了真实用户 bootstrap setting 的读取和写回。该失败发生在首条 update 的预期拒绝断言；没有证据表明后续 `updateDataBaseDir` 复制或真实 SQLite 迁移被执行。已立即修正测试隔离并向用户披露。因缺少可靠前像，未自动回滚，避免覆盖后续设置。不得把本轮写成“完全未触及用户配置”，也不得以之后 OS-temp sentinel 的通过结果抹掉此次例外。
