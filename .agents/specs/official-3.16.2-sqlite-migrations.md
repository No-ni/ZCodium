# 官方 3.16.2 SQLite 迁移基础设施适配

## 范围与所有者

只吸收通用迁移协调、冻结 checksum、备份/恢复和 schema 守卫。Source 旧身份转换由独立 preview/confirm/execute 合同控制，不在连接或 getter 隐式合并。临时 fixture 是本阶段唯一执行目标，不操作真实用户数据。

- `sqlite-migrations` 公共合同声明迁移、备份和恢复；domain 仅含类型/纯验证，adapter 执行 SQLite、文件和异步锁等待。
- Host 启动 Worker 与 CLI `openStartup` adapter 各自是其数据库的唯一迁移调用 owner；业务 Repo/同步 constructor 只能校验 ready 账本，不能在 getter/ensureReady 中另起迁移。通用 runner 接管事务时只由 runner 提交；`transactionOpen: true` 是调用方已取得 IMMEDIATE 写锁后的显式移交，runner 完成提交或回滚，调用方不二次提交。合同校验或所有权校验失败时不回滚调用方尚未移交的事务。
- 文件数据库按 SQLite 实际 canonical 路径进行进程内串行 admission（Windows 规范化大小写），迁移和显式 restore 共用 admission。排队取消立即拒绝调用方、保留队列屏障直到先行 owner 结束，被取消项不取得事务；已接管事务的取消必须先完成回滚再拒绝。快照、插入、hash 分批让出事件循环并复核 signal，取消不发布有效 metadata。内存库每连接独立，不把所有 `:memory:` 当作同一身份。跨进程只重试结构化 SQLITE_BUSY：原生 busy_timeout 为 25ms，之后异步、可取消、有总预算地退避；不使用 Atomics.wait 或长同步 busy 来阻塞先行 owner 的备份和进度 flush。取得锁后重读账本，预检只决定展示。

## 历史兼容

Host `tasks_schema_migration` 保持 id/checksum/time_applied，前三个迁移的 checksum 是冻结 JSON 的 SHA-256，函数和 SQL 不改写；CLI `schema_migration` 保持 id/checksum/app_version/time_applied，已发布 SQL trim SHA-256 保持。

`SqliteMigration` 显式提供不可变 `checksum`（旧 JSON）或 `sql`（默认 SQL hash）。新 TS apply 必须带冻结语义 checksum，不使用 function.toString。id/previousIds 必须全局无歧义；unknown ledger id、非法账本结构/值、校验不一致均阻断，不删账本、不覆盖 checksum，不在备份前补写别名。touchedTables 是必填、非空、大小写折叠后无重复的严格字符串标识符，禁止 runner 私有账本/SQLite 内部表及 attached/temp 库。备份按 SQLite 的大小写不敏感规则查找 main 表并记录真实名称，不能因声明名称大小写不同漏掉旧行。runner/restore 只接受专属 main 连接：有 ATTACH 库或非空 TEMP schema 时在移交事务前拒绝；锁内及 callback 后重新验收，避免未限定历史 SQL 被 TEMP 同名表遮蔽或改写未备份的附属库。调用者负责完整声明所有实际写表、重建表、旧数据转换来源表和外键级联影响；通用 runner 不声称从 SQL 文本推导完整影响范围。

### 启动适配与公开边界

- Host 的三个历史 `checksumInput` JSON、`schema-v1.ts`、provider-selection-v2 与 official-glm-selection-v3 的 SQL/apply 原样冻结，只为外层迁移合同添加显式 checksum 与 touchedTables。ready 检查同时验证未知账本 id 和当前 schema，不能只凭进程内 Set 放行替换库。
- Host `prepareTasksIndexStorage` 在备份/runner COMMIT 成功后标记 migrated，再运行原有幂等投影维护；维护和 close 全部完成才发布 ready。维护不成为第二个 migration owner。
- CLI 保留历史 0001–0023 SQL/id/appVersion；touchedTables 单独适配，不采用官方新增 Source/数据库 identity 项。`runSqliteSessionMigrationsAsync` 调用通用 runner，原同步函数只对已完成账本进行只读验收；空内存测试也改用异步启动，不在生产 sync constructor 写入迁移。`openStartup` 在打开连接前异步建立所选父目录并复核 signal；sync constructor 不创建父目录，只打开及验收已准备库。公开 `openStartupSqliteSessionStore` 必须返回 Promise 并只转发给 `SqliteSessionStore.openStartup`，同时透传可取消迁移选项，不能因名字像启动工厂却调用同步 constructor；Source 的首次建库、重开及预先取消经公开入口验收。取消在 runner COMMIT 前回滚，COMMIT 后保持 committed facts 但不继续发布 ready；Host 在投影维护的 await 边界同样复核 signal。
- 区域外历史回归 fixture 同样通过真实异步 startup 准备初始库；`local-automation-backend` 不再用同步 `runTasksDatabaseMigrations` 创建库。同步验收函数的专门拒绝/ready 测试保留，不能改回第二个迁移 owner。
- 备份默认目录只从调用者提供的数据库路径派生相邻 `backup`，允许显式传入优先级目录；本轮回归全部显式绑定项目内 sandbox。内存库可无目录（没有磁盘备份目标）但有真实旧行且需要迁移时必须明确配置目录。公共 Node-only 入口为 `@zcode/shared/sqlite-migrations`，沿当前 package export 与架构 requires 使用，不从 `@zcode/shared` 根引入 Node SQLite 到 UI。

## 备份

待执行迁移才备份被影响的现有表及真实行；空新库无需空备份。备份目录必须显式传入 `.zcodium` 约定根、与已选库相邻目录或用户选择目录，不发现/枚举其他卷、不写官方目录。读账本/备份先于 CREATE journal、apply、ledger 等任何迁移写入，备份失败不仅回滚，业务数据/账本/alias 没有提前写入。

备份保存受影响表 schema/列/行 hash、当前全库 schema 清单、原 ledger（显式记录原来不存在）、本次 pending 的 checksum/appVersion 合同和库 identity。表级副本保存无约束数据列（含大整数、blob、generated 列的验收值和需要保留的 rowid）；完整 metadata 同时内嵌 SQLite 副本私有表，外部 JSON 必须与内嵌副本严格相等，表名不能重复或删减。行数、行 hash、metadata 清单与 schema 自 hash 都须复核，metadata 最后原子发布；副本文件和 metadata 使用 0600，目录用 0700（Windows ACL 不以 mode 位冒充）。文件复制、hash/插入批次及 metadata 发布前均复核取消，取消保留未完成目录但不发布有效 JSON。hash 用于完整性不是对同时改写所有材料的攻击者提供签名认证。

ENOSPC/权限/hash 错误都阻断迁移，只尝试用户明确提供的其它目录；不枚举其它卷。备份构建失败不发布有效 JSON，保留可诊断的未完成目录但不将其视为恢复材料；已完成恢复材料不自动清理。本轮测试在连接全部关闭后保留项目内合成 fixture，不递归清理整个运行根；artifact 不备份规则不适用于真实数据安全材料。

## 恢复

恢复由工程调用显式执行，要求 `writersStopped: true` 且连接 idle，调用方负责停止所有进程的业务写者（不把布尔值声称为自动停写）。迁移/restore 共用进程内 admission；restore 的事务 owner 只回滚自己成功取得的事务。校验外部/内嵌 metadata、库 identity、完整表/索引/触发器 schema 清单、表列、行数/hash 后，禁用外键并 `BEGIN IMMEDIATE`；锁内再确认 identity/schema，事务恢复行与原 ledger；暂时禁用外键避免父表删除级联，完成后全库 `foreign_key_check`、行 hash 和原账本均通过才提交。成功/失败都恢复原 foreign_keys 和 busy_timeout。

若原 ledger 不存在，只有当前 ledger 的严格列/主键合同及全部行恰好对应本次 pending 的 id/checksum/appVersion 集合（time_applied 为安全整数）才可作为 runner 新建账本删除；只豁免 runner 的账本表及其原生主键 autoindex，额外显式索引/trigger 均拒绝。若原 ledger 已存在，当前账本必须逐值保留备份原行，并且只允许本次 pending 合同行；后来新增的迁移、修改的历史 checksum 或额外 alias 均拒绝，不能通过 restore 擦掉后来提交。除此以外任何表/列/索引/触发器变化都拒绝：表重建、加列、添加触发器后的恢复须使用专用、已验证的 schema 变换，不能将行恢复冒充通用 DDL 降级。备份材料缺失、篡改、schema 不兼容或外键失败均 fail-closed、回滚、保留当前数据。

## Additive schema guard

以当前 Host 三条迁移与 CLI 23 条冻结迁移生成项目内合成 SQLite schema，不采用官方 project-storage/Source 新 schema。提供通用 Node-only `dumpSqliteSchema` / `assertAdditiveSchema` 验收能力和对应定向测试：旧表/列声明、主键顺序/排序/collation、唯一约束（含自动索引）、CHECK（字符串大小写不被归一化）、完整复合外键分组/顺序/match、表选项 WITHOUT ROWID/STRICT、已存在显式索引/trigger/view 都保持；只允许 nullable 或带非 NULL 默认值的新列。guard 是变更审查工具，不在运行时禁止冻结历史重建迁移。Host/CLI 的 `schema.baseline.sql` 位于各自迁移目录；`scripts/ci/sqlite-schema-baseline.test.mjs` 从冻结合同生成临时库，比对可审查快照（双向 additive + 精确 SQL），存在 HEAD 基线时还须与 Git 历史比对，不能仅改本地 baseline 绕过约束。当前项目隔离入口只做只读 baseline 比对：根 wrapper 和 fixture 对 `--update-reviewed-baseline` 在创建目录、加载业务或写文件前以 `SQLITE_SCHEMA_BASELINE_UPDATE_NOT_SUPPORTED` 明确拒绝，不静默忽略参数，不扩大通用 runner 的文件写权限。历史显式更新入口在本轮退休；以后需要重新生成快照时，必须先定义受审查的独立项目内更新命令与授权范围，不借验证入口自动更新冻结基线。

### 项目内验证安全收口（2026-10-28）

唯一验证环境 owner 为 `scripts/ci/project-test-sandbox.mjs`，规则见 [Source 项目内验证边界](official-3.16.2-source-data-roots.md#项目内验证边界2026-10-28)。四个根 SQLite/RPC 入口先建立隔离子进程，再加载 `scripts/ci/fixtures` 测试本体；SQLite 合成库、备份、HOME/temp/缓存和日志只写获准工作树，各连接关闭后保留目录，不递归清理运行根。子进程成功/失败结果与真实用例数留在本次 sandbox，不将 wrapper 的一项计数当作数据库断言数量。本轮不运行旧系统 TEMP 清理器、不读取真实用户库、不修改冻结迁移或 schema baseline。下方 OS-temp 及早期门禁记录是历史执行证据，不再是当前命令或安全承诺。

- 包级 node:test 入口 `packages/shared/src/sqlite-migrations/contract.test.ts`、`packages/zcode-server-cli/scripts/ingressToken.test.ts` 与 `packages/desktop/scripts/sourceServerRpc.test.ts` 自本收口起只能经新增根 wrapper（`sqlite-migrations-contract`、`zcode-server-cli-ingress-token`、`desktop-source-server-rpc`）在同一 `runSourceTests` 隔离子进程中执行：子进程已把 `TEMP/TMP/TMPDIR/HOME` 绑定到本次项目内 sandbox，`os.tmpdir()` 落在 `.run-logs/project-only-validation` 内，测试文件本体不改写；不得再用未绑定环境直接跑这三份文件。

## 事件顺序

```text
readonly inspect -> canonical admission -> BEGIN IMMEDIATE -> 锁内账本复核
  -> snapshot + metadata 内嵌/外部 hash 验证 -> 创建账本（如缺席）
  -> apply -> ledger -> COMMIT -> owner 维护 -> ready
失败 -> 仅 owner 的 ROLLBACK -> 可恢复错误（不发布 ready / alias）
restore: 停写确认 -> 同一 admission -> 验证备份 -> foreign_keys OFF
  -> BEGIN IMMEDIATE -> 锁内复核 schema/identity -> rows + 原 ledger
  -> foreign_key_check + hash -> COMMIT -> 恢复 PRAGMA
```

## 验收

真实临时 SQLite：历史 JSON checksum 保留、CLI SQL checksum 保留、损坏账本阻断、新项一次执行、两连接异步备份不堵事件循环、跨进程 BUSY 退避、备份失败零写、篡改备份拒绝、恢复外键和 ledger、未知 schema fail-closed。使用现有源测试 runner 和 node:sqlite，不以源码关键词检查代替数据库结果。

### 较早实施轮的收口实测（历史，不覆盖本轮最终树）

- Windows、Node 24.18.0 / pnpm 10.33.2；仓库 pin 为 Node 24.14.0，本机无 mise，未安装或切换工具链。
- 四个 CI 定向文件最终合计 60/60 通过（infrastructure 27、schema contract 11、startup adapters 20、既有 schema baseline 2）；此前 56 项版本修正测试对异步 realpath admission 顺序的假设后连续三轮通过，最终额外 4 项覆盖 TEMP/ATTACH main-only 拒绝。shared contract 11/11 通过。仅执行 OS temp 合成 SQLite，连接关闭后清理临时根。
- 实测取消覆盖排队、跨进程写锁等待、真实 snapshot、真实副本文件建立后复制、事务内真实行恢复、Host/CLI startup；跨进程锁内重读、备份故障零写、恢复 identity/schema/hash/ledger/foreign_keys 均由真实数据库断言验收。Host 3 条与 CLI 23 条冻结 checksum、当前两份 schema baseline 均保持。
- 根 `corepack pnpm typecheck`、根 `corepack pnpm lint`、`architecture:check --changed` 通过；SQLite 当前源码合同的严格 TypeScript 定向 program 为 0 diagnostics，owned runner/schema/startup helper 的定向 lint 为 0。
- CLI 全量 `corepack pnpm --dir apps/zcode-cli typecheck` 已运行，但在区域外 model/tool-search 合同报 14 项错误；SQLite 无诊断。CLI 全量 lint 已运行，65 warnings / 81 errors（大量现存 max-lines）；必需邻接 `sqlite-session-store.ts` 本轮只改 startup 接缝，仍有 923 行 max-lines 与原有 spread warning，未拆其区外业务、未增加 disable 或放宽配置。
- 未验收 macOS/Linux、Node 24.14.0、真实 ENOSPC/ACL、进程崩溃/断电持久化、所有冻结历史迁移的逐版本数据样本与完整桌面/远程启动；`writersStopped` 仍由调用者保证停写。真实用户库、旧身份迁移、安装、提交/推送、发行和桌面打包均未执行。
