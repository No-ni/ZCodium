# 官方 3.16.2 Source workspace alias 受控实施

## 范围和实证

固定只读上游 `3c5b227649371507ddc4eb46ac5133afe6db1cab` 的 `source-server-workspace` / `sourceServerWorkspaceAliasRepo` 为行为参考，不搬入自动 getter 合并、按路径跨 Source 归属、自动选较新 task 覆盖、自动取消 off-peak 或自动 follow-up migration。本轮仅代码与 OS-temp fixture，不访问真实用户数据库/服务，不导入 `.zcode` 或第三方数据根。

当前 Host 是 `tasks`、`task_group_members`、`task_group_view_node_orders`、`task_group_workspace_bootstraps`、`automations`、`automation_runs`、`off_peak_tasks`，`task_groups` 的 group_id 不改写。CLI 实际表是单数 `session`，字段为 `project_id/workspace_id/directory/path`；消息、part、todo、session_entry 的 session_id 保持。project_id 为 CLI 的路径派生项目范围，不等于 workspace identity。Host 现有配置树为 `.zcodium/v2/sessions/<sha256(workspaceKey).slice(0,12)>`，包括其 `configs` 子树；额外 hashed 根只能由 Node composition 显式声明，禁止扫描猜测或跨根导入。

## 模块和单一所有者

`source-server-workspace` 的公开 `contract.ts/index.ts` 只含 DTO、schema、纯规则；`node.ts` 暴露工厂和 Node options。domain 做身份和冲突裁决，app 编排 preview/confirm/execute/retry/report/restore，adapters 执行 async FS 与 SQLite。只通过 `@zcode/shared/sqlite-migrations` 公开入口消费锁等待/schema能力；不修改 Host 3 条/CLI 23 条迁移、checksum或账本。不从 browser services barrel 引入 Node。

一个实际 `.zcodium` root 对应一个异步 operation owner。进程内 admission 与独立 owner SQLite 的跨进程 `BEGIN IMMEDIATE` 共用唯一写入口；owner 库和 durable phase/alias 库与业务库分离，不在 getter 建表，不恢复同步 migration owner。业务库须已准备；本模块不做启动 DDL。alias 以 `(SourceID, normalizedPath)` 为键，canonical key 不能被另一个 Source 认领。

## 只读 preview 和归属

- Node composition 必须显式提供 `.zcodium` dataRoot、验证当前 Source generation 的 authority port、为该 Source/路径验证过的旧 SSH/WSL/Docker keys，以及 CLI 项目 ID 计算 port。UI 请求不能选择文件根或声明任意旧线路归属。
- stable identity 复用 shared `buildServerRemoteWorkspaceIdentity`。identity 路径归一与实际执行/显示路径分离，拒绝 NUL、相对路径、`.`/`..`段和非法 identity。绝不将另一个 Source 的相同路径或未验证旧线路归入候选。
- preview 只用 readOnly SQLite、async lstat/realpath/readFile；不 mkdir、写 ledger、写 alias、移动配置、运行迁移或修 schema。库/目录缺失如实呈现；权限/空间/损坏/边界错误不吞成不存在。readOnly 本身不能保证 WAL 场景零写：本机OS-temp实测已有安全SHM仍被SQLite更新读标记；readonly exclusive及URI都未提供可用无写快照。因此当前Node只读adapter在SQLite打开前拒绝WAL及非零/未知header的rollback journal，仅允许经完整文件manifest验证零写的全零magic cold journal（详见多阶段执行）；不以immutable忽略WAL、不checkpoint、不修复sidecar。支持真实WAL须另有真正零写的一致storage snapshot port，当前无该port，不能声明产品WAL预检可用。
- authority 的 Source ID/generation/verified keys/projectId须严格验证；每次 COMMIT/rename 复核全部冻结字段，不能只核 generation。候选 Host workspace_identity/meta identity 和 CLI directory/path 不得以一个相符字段掩盖另一个明确的跨 Source/跨路径字段。NULL CLI workspace_id 只能是真 NULL，空串/错误类型不能当未归属。
- 候选来自经过验证的 key 在真实 Host/CLI记录及显式 hash 目录中的存在性。NULL CLI workspace_id 仅可按 Host 该变体的精确 task_id allowlist及真实路径归属；不按目录批量认领。旧 identity 被误存到 directory/path 时只对完整已验证 identity 改为真实 workspacePath；project_id 默认保留，仅这类旧目录用 authority 的实际 CLI 项目 ID。
- 单已有 legacy 变体可只读返回其 canonical 建议，保留历史 key；没有历史用 stable；多个变体 confirmation-required，零数据改动。已有 alias 不自动换主，新候选须新计划。
- 版本覆盖 Source generation、根/库文件 generation、schema/冻结 ledger、真实行和配置清单 hash。root generation在预检前后及每次提交前核对。plan hash 覆盖候选、冲突、版本和已存在 alias；读取durable job时从冻结inspection重建plan、choices/output和阶段索引，不信任ledger内未经复核的canonical/phase字段。预检 DTO 不含行原文或配置内容，confirmation token只签scope/canonical绑定hash、plan/version和时间，大小不随collision或路径长度增长。

## 冲突和显式确认

任务 task_id 即使表面相同也不能自动覆盖。转换到 canonical 后的任何唯一键碰撞必须显示 collision id、来源和行 hash；confirm 必须选择来源。task_groups 全量保留，不以同 group 名合并。Host task/meta 与 group/member/order、bootstrap 等使用独立显式选择；与 CLI session owner 冲突的 task 来源选择拒绝，但 preview 不因尚未选定的默认来源而硬阻断可行的选择。CLI 已归属另一个 key/Source 的同 ID session 不得被碰撞裁决认领。文件同路径不同内容或类型同样显式选来源；选择文件时该路径的目录子树明确不进入结果，选择目录才保留其可合并子树。hash目录碰撞、运行中任务/automation/off-peak/CLI active run/已接受输入、未知结构或跨 Source claim 为硬阻断，不能靠选择覆盖。

confirm 请求绑定 SourceID、原始/归一路径、Source generation、candidateVersion、planHash和预检有效期，明确 `acknowledgeMerge: true`。owner 下重新只读预检，过期/迟到/变更拒绝；只写控制库批准记录，不改变业务数据。execute 必须消费这个 durable approval，不能以重传确认创建另一计划。

## 多阶段执行及备份

业务写者由外部 owner port 获取显式停止写入 lease；该 lease 必须覆盖同一 dataRoot 的两个业务库及所列配置根的所有写者（指纹覆盖整库，不只是当前 workspace）。本模块不创建 runtime、不清 CommandInbox、不取消任务。异步阶段及每次 COMMIT/rename 前复核 lease 和 Source generation、已验证 keys 与 projectId；多变体的现存 active owner另作硬阻断。不能将布尔值声称为自动停写。

```text
preview(readonly) -> explicit confirm -> durable approved job
  -> admission + Source/全根停写 lease + frozen plan recheck
  -> SQLite完整在线备份 + 配置清单/副本验证 + metadata最后发布
  -> Host IMMEDIATE + 锁内before复核 -> durable intent -> lease复核 -> Host COMMIT -> durable host phase
  -> CLI IMMEDIATE + 锁内before复核 -> durable intent -> lease复核 -> CLI COMMIT -> durable cli phase
  -> 每次配置rename前Source/lease复核 -> rename + 清单验收 -> durable索引 -> config phase
  -> 最后alias发布 -> completed
```

备份由 Node SQLite async backup 从另一个只读连接取得一致 committed image，锁内数据指纹严格复核；不用裸复制 WAL主文件。目录/文件为0700/0600（Windows不冒充ACL）。全部材料位于明确 `.zcodium` 的 job backup目录，任何失败阻断全部业务写入；不跳过ENOSPC/EACCES、不枚举其他卷。metadata清单最后原子发布并sync，材料缺失/篡改拒绝恢复。

跨库/文件不是单事务。每个业务COMMIT前保存真实 before/after意图，崩溃后只有当前指纹恰等于before或after才分别重试/认领该阶段；不重新选主、不创建自动follow-up、不靠超时修正顺序。真实进程在COMMIT前退出可能留下rollback journal，readonly预检不恢复它；显式retry/restore在真实lease、Source/根generation和已验证备份下，且只有本job的durable intent记录的库文件hash、journal完整hash及文件generation完全相同，才允许SQLite恢复该未提交事务并验收该阶段的committed before image。任意后来/缺少归属证据/篡改journal一律在SQLite打开前拒绝，WAL仍无实现支持；不删除journal猜测恢复。OS-temp证明SQLite为未落盘事务留下的全零magic cold journal可只读读取且不改变完整文件manifest，因此只读adapter仅允许header前8字节全零的非hot journal；任何非零/未知header仍拒绝，持有前后journal handle/generation复核。显式恢复不通过空事务假称删除cold journal，仍由SQLite下一次真实受控写入自然替换。目录使用同卷暂存+原目录退役rename到备份区，逐操作保存意图，复核两端清单后幂等续跑；不按文件较新自动覆盖。不相关数据保留；任一后续写或替换库导致指纹偏离则拒绝，不擦除它们。

## 显式 retry/report/restore

failed/cancelled保留job、批准、phase与恢复材料。report仅安全错误码、计数和身份/phase，不持久化原始错误或配置内容。retry指定同一jobId/expectedRevision，锁内复核Source/lease/材料及每个阶段，不重新申请范围。cancel不放弃或删除数据。

restore要求独立显式请求 `writersStopped: true` 和当前停写lease；该请求字段仅表示用户确认，绝不是已停写的证明，服务始终必须向 authority 获取全根真实 lease。durable restoring状态先阻断ready getter。原业务schema、库generation、完整备份hash、当前phase的预期postimage与所有文件rename状态必须严格相符；有后续业务写入/新的alias或schema变化拒绝。反向恢复配置、CLI、Host；SQLite恢复只恢复同schema行（含rowid/blob/bigint/generated验收、sqlite_sequence），停外键后事务恢复、全库外键/行hash通过才提交，恢复原PRAGMA。恢复开始时保存已验证的各库 before/after 状态，反向COMMIT前另存独立恢复intent；只有该intent或已提交的恢复phase才能认领original image，不因当前库恰与original相同而猜测已恢复。每一步正/反向rename同样先持久化方向与索引intent，再复核Source/lease，才允许认领已发生但索引尚未写入的唯一窗口。最后再次复核所有original介质和精确alias快照后回退alias/发布restored；不声称DDL downgrade，不删用户后续数据。

## 文件安全

dataRoot basename必须为`.zcodium`且是显式原生绝对路径；Node options 内的两个业务库、控制库、job目录和hash根必须互不重叠，不能用相对路径经过resolve隐式授权。读取/备份/暂存/rename全部只在该root内；逐组件lstat/realpath和打开前后fstat身份验收，拒绝symlink/junction（含root祖先）、硬链接文件、特殊文件、嵌套`.zcode`/`.zcodium`、路径逃逸。不读取任何`.zcode`、第三方或其他Source根；不执行网络。配置目录只扫描候选hash目录及其子树，未知目录不枚举/不导入。备份文件和目录先在job内独立scratch完成并验证，再原子rename发布；retry不覆盖已发布备份。数据备份先在job内独立scratch完成并验证，再原子rename发布；metadata最后发布。已发布SQLite/配置备份永不由retry重写，篡改/缺失明确拒绝；未发布半成品仍留在scratch，可隔离后重新创建，不混同已发布材料。正常SQLite连接在异步遍历期间必须持有显式只读事务，保证整库schema/行来自一个committed snapshot；备份验证还覆盖完整文件hash。文件打开保持handle，并以前后fstat/lstat dev/ino/birth generation核对，DB及其WAL/SHM/journal也必须拒绝硬链接和路径替换。纯Node路径API不能提供跨进程恶意重命名攻击的dirfd级保证，因此外部停写lease与受信任的用户数据目录所有者是前提。

本次接续已有39项测试的实际基线为32通过/7失败：restore缺少intent/COMMIT回调、配置rename间缺少lease复核，以及一项构造同步拒绝的测试断言错误。由这些失败与实际schema补充验收：restore伪original不得认领、每次正反rename撤权、authority keys/projectId变化、root祖先junction/硬链接/大小写数据根、OS-temp WAL零写与一致快照、未发布备份崩溃重试、已有alias不换主且restore恢复其原记录、真实CLI target/dwf/accepted input及Host dispatch阻断。最小合同修正包括：`writersStopped`为确认而非lease；当前Node拒绝WAL和未知/hot journal以保证零写，WAL真实支持依赖未接线snapshot port；rename及本job rollback recovery必须有完整durable intent才能认领窗口。

## 验收和接线

真实 OS-temp 的Host冻结3迁移、CLI冻结23迁移及目录：preview零写、单变体保留canonical、同路径不同Source隔离、多变体显式批准、task/config碰撞、active owner阻断、过期/迟到拒绝、备份失败零业务写、跨库崩溃窗口retry、目录rename崩溃、取消/迟到防重复、显式restore及后续写拒绝、symlink/跨根拒绝。实际运行定向测试、root typecheck/lint/架构；完整CLI门禁的区域外失败如实列出。

主代理负责 ready前gate、UI确认、Source/运行时authority和writer lease接入；本模块不改Directory/manager/managementService/registry/Main/UI/mobile/settings/protocol。最小公开方法为preview/getResolvedWorkspace/confirm/execute/retry/report/restore，严格schema由本模块提供；需要的新channel由主代理绑定同一Source owner并净化跨进程错误，不从getter触发execute。

### 本项最终实际验证

- 官方只读HEAD核对为固定 `3c5b227649371507ddc4eb46ac5133afe6db1cab`；实施HEAD为 `18cc72cef7bec53eaa543b515e0c9332bc9cd05b`，本项未提交或推送。freshness通过，相对origin/main ahead31/behind0；HEAD无tracking branch，未执行behind-remote检查。
- Windows OS-temp合成fixture执行 `corepack pnpm exec node --test --test-reporter=spec scripts/ci/workspace-alias.test.mjs`：92项全部通过，fail/cancelled/skipped/todo均为0；最后6项新增journal定向回归另跑6/6通过。使用真实冻结Host3/CLI23迁移创建临时库和真实子进程退出，不访问生产数据或真实服务。
- 最新模块所有TS定向 `tsc --ignoreConfig --noEmit`（沿用root的nodenext/isolatedModules/noUncheckedIndexedAccess等选项）通过；定向oxlint 21文件0warning/0error，定向oxfmt --check 23文件通过。root `corepack pnpm typecheck`通过；root `corepack pnpm lint`3274文件0warning/0error；`corepack pnpm architecture:check --changed` violations/baseline/new均为0。
- root `corepack pnpm fmt:check`实际失败，82个文件全部位于本项范围外，保留并行WIP。`corepack pnpm verify:pre-push`实际失败：现有脚本内部使用裸pnpm，此环境找不到该命令；不改package.json、不安装shim，不把分别通过的lint/architecture声称为wrapper通过。
- 实际Node为24.18.0，`mise.toml`固定24.14.0；pwsh7.6.7/corepack pnpm10.33.2。未在固定Node24.14.0或macOS运行；上述仅Windows OS-temp确定性回归，不是产品ready/UI/跨进程全根停写E2E或断电耐久性验收。
- 当前生产源码Host startup启用WAL，而本项Node adapter明确拒绝WAL；零写committed storage snapshot port尚未实现。Source authority、覆盖两个整库/全部配置根/所有进程写者的真实lease，以及ready/UI/channel公共接线仍缺失；fixture的注入authority/no-op lease不证明这些能力已接入。

### 项目内验证入口收口（2026-10-28）

- 上方 OS-temp 命令与计数只是历史执行证据，不再是当前命令或项目内验收。当前根入口 `scripts/ci/workspace-alias.test.mjs` 改为中央 sandbox wrapper：先由 `runSourceTests` 建立 `PROJECT_TEST_SANDBOX_ROOT` 绑定的隔离子进程，再加载测试本体 `scripts/ci/fixtures/workspace-alias.test.mjs`（非自动发现）；wrapper 断言子进程精确用例数，零测试视为失败。
- fixture 本体每个用例经 `createProjectTestFixture("workspace-alias")` 在获准工作树内创建不复用的合成目录；崩溃窗口子进程继承绑定后的 HOME/TEMP，只等待或终止自己创建的子进程；连接关闭后保留 fixture 目录，本体不再有 `t.after` 对运行目录的递归删除。产品行为、冻结迁移、schema/checksum 与 restore 语义不因本次入口迁移改变。
- link 介质 helper 合同：Node 受限 symlink/link API 需原生工具（win32 `cmd.exe` / POSIX `ln`），仅写已验证的 fixture 链接——创建前对 target 与 link path 逐一执行中央 `assertProjectPath`，target 必须是现有普通文件/目录（lstat 同时拒绝 symlink 并断言 `isFile() || isDirectory()`），link path 必须尚不存在；spawn 固定 `["/d","/c","mklink",…]` 首项 `/d` 关闭 cmd AutoRun 再 `/c`（POSIX `ln` 固定参数顺序）、`shell:false`、`windowsHide:true`、显式 `env`（本 sandbox 快照）与 `cwd`（target 所在 fixture 目录），失败 stderr 只以 `<project>` 掩蔽绝对路径后保留；创建成功不等于介质可信，必须回读 lstat/stat：软/目录链接须 `isSymbolicLink` 且 realpath 可读，硬链接须与 target 同 dev/ino 且 nlink≥2，回读不符即报错，之后才调用产品代码。helper 只存在于 fixture 本地，不建立第二环境 owner、不触碰中央 runner。

## 独立任务：WAL 原介质零写 committed snapshot port

本次仅本模块、本项spec及`workspace-alias*.test.mjs`/专属OS-temp fixture；不接Host/UI/Server或真实lease，不改migration/checksum/基线/并行WIP。前项92回归原样复跑。原DB、WAL、SHM只允许经过已有根/realpath/硬链接/打开handle边界的异步文件读取；任何原文件都不交给SQLite打开，不checkpoint、不转换journal_mode、不用immutable忽略WAL。OS-temp独立副本可生成SHM和恢复，副本结果绝不能被误称为原主文件的完整快照。

### narrow contract 和证据

- snapshot port是可信Node composition注入的后端能力，不是UI DTO、`writersStopped`布尔或从客户端接受的“已一致”声明。`withSnapshot`拥有捕获、隔离资源生命周期、原介质复核和清理；只在完整证明成功后才调用consumer，不返回可脱离生命周期使用的临时文件句柄。
- 必须覆盖原root generation与精确database path hash、DB/WAL/SHM的存在性、文件身份generation、完整byte length/hash及change-generation；缺失sidecar必须记录不存在并复核没有后来创建。捕获前后同一原介质tuple逐项一致，发现变化返回`snapshot-stale`，要求重新preview，禁止内部悄悄重试后发布另一个image。
- committed evidence须确认WAL salt/checksum、最后完整commit frame与数据库页数；未提交/残缺尾帧不进入committed image。隔离SQLite打开的副本必须包含完整DB/WAL/SHM捕获，不能只复制主库、不忽略WAL，也不能把副本自己修复后的SHM身份误当原证据。
- 同一时刻的完整tuple及整个捕获区间无变化必须由实际native read barrier，或atomic capture配合单调source-change epoch证明。前后文件hash/stat相同仅是观察证据，不是这个能力的替代；port证据schema只校验形状，不能把JSON字段当作原生原子性证明。
- 纯Node文件API先做边界和完整前后观察，在可观察变化时明确返回`snapshot-stale`。若真实mmap/代际实验证实它无法证明整个区间，Node adapter必须返回`snapshot-unproven`，consumer永不调用，默认原WAL安全阻断不变；不创建无证明的业务image、不接自动fallback、不加假的停写flag。
- 当前Node实现只负责只读观察和拒绝，不生成隔离SQLite副本、不发布证据或调用consumer；`withSnapshot`仍为未来可信原生能力的唯一生命周期入口。按固定位置分块异步读取并哈希DB/WAL/SHM，覆盖root generation、精确路径、存在性、handle身份、长度、mtime/ctime和完整字节；重复读取不能沿用FileHandle的EOF偏移。Windows被SQLite锁住的SHM可能`EBUSY`，缺少完整字节时必须拒绝为`snapshot-unproven`，不能调用测试中的PowerShell映射读取代替生产能力。已观察到的介质变化优先拒绝为`snapshot-stale`。
- 捕获phase observer仅用于Node装配的取消/故障fixture，不接受客户端证据或自称可信的epoch。任意取消、读取/observer失败都关闭已打开的handle；清理异常不得覆盖原始失败，安全错误只公开固定code。
- 本轮先红实际结果：Windows Node24.18.0执行专属WAL20项，4通过/16失败；失败为公开schema/工厂尚不存在。完整副本看见已提交WAL行、未提交spill不进入结果、SHM映射变化后恢复且endpoint manifest相同、原WAL默认阻断四项已通过。这些只证明fixture和安全限制，不证明产品WAL快照能力。

```text
可信 composition -> snapshot port（唯一资源所有者）
  -> 原root/DB/WAL/SHM readonly handles + 完整tuple观察
  -> 原生区间证明 + isolated full tuple -> committed boundary验证
  -> 再次原tuple/epoch验证 -> consumer（仅隔离资源） -> 终检 -> cleanup
  -> observed change: snapshot-stale / proof unavailable: snapshot-unproven
```

### 先红回归与验收

先补专属fixture/回归、实际看到新port缺失的红结果，再实现。真实OS-temp WAL writer应包括已提交但未checkpoint的数据、spill到WAL的未提交尾帧、checkpoint/TRUNCATE及WAL复用salt代际、捕获中变化、SHM mmap读标记窗口。原完整文件manifest在无外部写者时逐项零写；有测试写者时只比较写者完成后adapter是否额外改动，不把合法fixture写者变化误记为adapter写。取消、失败、callback不调用、handle/隔离clone清理、DB/WAL/SHM硬链接与跨根均验收。若不能提供区间证明，保留可复现实证与明确未实现的native capability，不将负向安全验收写成产品WAL支持已完成。
