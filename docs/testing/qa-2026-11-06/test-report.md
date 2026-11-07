# 菜单与功能专项测试报告

本文保留修复前 QA 结果。本轮可执行测试阶段收尾后，8 项确认问题已完成本地修复与定向回归；当前状态与修后证据见 [修复报告](fix-report.md)，不代表各功能组或跨平台全量验收完成。

测试日期：**2026-11-06至2026-11-07（Asia/Shanghai）**。项目：**ZCodium 3.17.1**。最后一批 Electron 用例于北京时间 **11月7日04:31:06.809** 完整结束。

本轮按当前源码建立 **87个菜单与功能组**的测试索引，已形成 **8项确认问题：6项产品缺陷、2项测试门禁缺陷**。85组有针对性执行或失败证据，其余2组的目标动作未执行。各组仍有部分未覆盖动作，不能将入口通过、源码合同通过或单项交互通过写成整个功能组验收通过。详细范围见 [覆盖矩阵](coverage-matrix.md)，可直接修复的复现、原因与验收条件见 [Bug报告](bug-report.md)。

**收尾状态：UI批次及五项必需检查已实际执行。三项类型检查与架构检查通过；原始全仓Lint失败，生成目录的影响和源码补充检查分开记录。**

## 结果与统计口径

| 测试层级 | 唯一用例 | 最新实际结果 |
| --- | ---: | --- |
| 确定性源码、schema、mock与隔离文件测试 | 133 | **131通过、2稳定失败、0跳过**；两失败均独立复现，为BUG-002/003 |
| Desktop E2E全部实际记录 | 188 | **151通过、31原始失败、6跳过** |
| 其中：正式canonical目录 | 109 | 83通过、26原始失败、0跳过 |
| 其中：仓内manual-review/pending | 2 | 2通过、0失败、0跳过 |
| 其中：本轮docs外置pending | 77 | 66通过、5原始失败、6跳过 |

确定性测试共138次尝试（首次133＋复跑5），不重复增加唯一用例。E2E共 **250次记录：174通过、70原始失败、6跳过**，其中244次非skip记录；188个身份中183个至少有一次非skip记录。这不代表183个功能完整验收。统计包含取消core批次重复VP30的一次真实通过；排除此尝试，已完成批次为249次记录：173通过、70失败、6跳过。

全轮计数已由独立验证任务重新读取全部实际NDJSON确认，见 [最终独立统计counts033](logs/validation-e2e-counts-033.json)。[另一独立增量核对](logs/feature-inventory-final-e2e-counts.json)与最后3条实际结果也得到相同汇总；旧截点保留，不覆盖历史失败。

唯一E2E按归一化测试文件与fullTitle去重，主题/语言独立标题保留。重跑增加尝试，不增加唯一用例。未进入test body的启动、加载或hook失败另列，不补造case；实际skip不计通过或失败。原始FAIL包含旧测试契约、定位/前置错误和自动化超时，**31个原始FAIL不等于31个产品Bug**。静态fixture preflight、安全guard探针与类型检查不计入产品测试或UI通过数。详细计数、命令与证据见 [质量验证](validation.md)。

## 优先修复与复验

| 优先级 | 编号 | 确认问题与证据边界 |
| --- | --- | --- |
| P1 | [BUG-005](bug-report.md#bug-005) | 内置浏览器权限策略未接线，两个独立新run的未授权geolocation query均返回granted；未请求真实位置或设备 |
| P1 | [BUG-004](bug-report.md#bug-004) | Desktop旧项目迁移未传旧设置，合成profile中的项目入口未生成；未证明用户项目文件或会话内容丢失 |
| P1 | [BUG-001](bug-report.md#bug-001) | macOS开发入口读取未声明变量；精确darwin条件VM复现，macOS真机未验 |
| P2 | [BUG-006](bug-report.md#bug-006) | 工具栏测量副本缺布局骨架，压缩算法提前返回；人工240px帧与源码probe确认，普通真窄窗仍待验 |
| P2 | [BUG-007](bug-report.md#bug-007) | 浮窗压缩标记与模型CSS读取owner不一致；真实560px空输入DOM与PNG确认 |
| P2 | [BUG-008](bug-report.md#bug-008) | 命令中心两个设置命令选择值冲突、同时aria-selected；键盘执行后续尚未抵达 |
| P2／门禁 | [BUG-002 / VAL-001](bug-report.md#bug-002) | 遥测审计扫描到旧引导fixture的空reportTelemetryEvent方法；不构成实际遥测导出证据 |
| P2／门禁 | [BUG-003 / VAL-002](bug-report.md#bug-003) | 工作流审计期待对象遗漏必需offeredMode字段，遮挡后续分支；未确认官方购买或配置网络回归 |

先处理敏感权限、迁移和支持平台启动三个P1，再处理布局、选择状态及两个测试契约。每项Bug已附前置条件、复现步骤、预期与实际、源码/运行证据、确认程度和修复验收。修复前更新对应spec并补回归，保持本fork的遥测、官方云依赖和数据目录边界。

分组任务置顶后自动化会话失去响应已在两个隔离run重复，并采集现场资源；产品与driver责任未确定，作为高优先候选交接。未读动作后的session超时、若干旧fixture/selector问题另列为候选或QA欠账，不增加确认Bug数。见 [Bug报告的运行候选与QA欠账](bug-report.md) 及 [分组复现计划](test-plan-grp-pin-targeted-repro.md)。

## 菜单覆盖与最后复验

[功能清单](feature-inventory.md) 按窗口/帮助、主导航、项目/分组/任务菜单、会话输入与工具、面板/文件预览、Git、设置/模型供应商、自动化/工作流、浏览器、远程与Bot列出当前入口和验收动作。[覆盖矩阵](coverage-matrix.md) 为全部87组提供已测范围、失败归因、未测动作与证据。

87是功能组数量，原子菜单和动作总数未独立枚举。84组有部分通过证据，浏览器权限组另有真实失败证据；NOT-RUN两组是Git diff（GIT-02）与Source Server生命周期（SET-13）。终端组已有tab/合同partial，PTY动作仍受阻。BLOCKED为10组且包含上述2组，集合不能相加；其它partial组仍有未完成的增删改、持久化、失败恢复或平台动作。

| 最近批次 | 完整实际结果 | 主要证据与边界 |
| --- | --- | --- |
| settings-final | 23/23通过，exit0 | 18个设置入口、四组中英文/深浅主题导航；[NDJSON](runtime/qa-menu-20261106-settings-final/evidence/test-results.ndjson)，不替代每页全部业务操作 |
| archive-actions-final | 2/2通过，exit0 | 合成归档行恢复、单删取消/确认、双库状态和冷重启不复活；[结果](runtime/qa-menu-20261106-archive-actions-final/evidence/test-results.ndjson) |
| local-supplement-retry | 15条：9通过、5原始失败、1跳过，exit1 | 会话Find、完整Markdown复制/拒绝恢复、文件shadow预览、长文本滚动、开关/目录取消及51项目分页排序；[结果](runtime/qa-menu-20261106-local-supplement-retry/evidence/test-results.ndjson) |
| local-final-targeted | 6条：3通过、3原始失败，exit1 | 任务范围查询/Recent、已有AstrBot名称Escape取消/路径复制、记忆scope/search/refresh通过；[结果](runtime/qa-menu-20261106-local-final-targeted/evidence/test-results.ndjson) |
| copy-history-final | **3条：2通过、1原始失败，exit1** | RFC01完整助手正文复制与反馈恢复、HIST01六角色/复制/折叠/自定义展开通过；HIST02在关闭搜索后等目标行挂载超时；[结果](runtime/qa-menu-20261106-copy-history-final/evidence/test-results.ndjson)、[summary](runtime/qa-menu-20261106-copy-history-final/evidence/summary.json) |

RFC01使用真实hover/click和受控clipboard捕获，3930字符精确等于有限合成响应，Check出现后恢复Copy，main/title各一次且动作无新增请求。前两轮QA定位失败保留；本次实际候选摘要确认用户copy与助手轮尾copy同容器，不能将本次数量反写为旧现场已测数量。见 [复制复验计划](test-plan-runtime-copy-find.md)。

HIST01先滚动真实timeline owner至顶部并等待首条挂载，再完成原六角色等断言。HIST02已达到双marker逻辑计数2/2，随即Escape清搜索；没有证据证明目标42在关闭前完成挂载和文本定位。关闭后恢复折叠与重新测高，目标等待超时，暂归QA同步/虚拟窗口候选。**手动展开override、卸载重挂、后续导航/no-match、长正文55及33MiB尾读均未验收。** 见 [最终只读归因](logs/feature-inventory-historical-final-attribution.md)、[最后复验计划与参数](test-plan-copy-history-final.md)。保留失败，不放宽断言或将未达步骤写为通过。

## 最终门禁

<a id="final-validation"></a>

| 必需检查 | 最终结果 | 证据 |
| --- | --- | --- |
| Desktop E2E类型检查 | 固定嵌套工具后复跑退出0 | [输出](logs/validation-desktop-e2e-typecheck-final-pinned.log)、[版本/命令/退出码](logs/validation-desktop-e2e-typecheck-final-pinned.json) |
| 根typecheck | 退出0 | [输出](logs/validation-typecheck-final.log)、[记录](logs/validation-typecheck-final.json) |
| 原始根lint | **退出1：76 errors、38388 warnings；扫描16053文件** | [完整输出](logs/validation-lint-final.log)、[独立错误路径归因](logs/validation-lint-final-attribution.json) |
| architecture:check --changed | 退出0、violations=0 | [输出](logs/validation-architecture-final.log)、[记录](logs/validation-architecture-final.json) |
| 外置QA noEmit | 退出0 | [输出](logs/validation-qa-typecheck-final.log)、[记录](logs/validation-qa-typecheck-final.json) |
| 源码补充Lint，仅排除本轮runtime/** | 退出0；5731文件、0 errors、3 warnings | [输出](logs/validation-lint-final-source.log)、[实际参数/范围](logs/validation-lint-final-source.json) |

早期门禁通过仅为当时截点，不替代最后QA源的检查。首轮最终Desktop E2E类型检查退出0，但嵌套裸pnpm实际调用Codex回退Node24.22.1/pnpm11.25.0，不纳入本轮指定工具结果，原日志保留。运行器经路径/缓存审查后使用工作树内shim，嵌套实测为pnpm10.33.2/Node24.18.0，再复跑类型检查退出0；没有修改package.json或安装新工具。见 [工具链审计](logs/validation-pinned-toolchain-path-audit.json)。

原始根Lint的76条错误均位于本轮runtime生成插件副本，为max-lines错误；生成的Jiti/cache等产生大量warning。此失败不改写为PASS。仅排除`docs/testing/qa-2026-11-06/runtime/**`的源码补充Lint退出0，其余QA源码仍在检查范围，剩余3条prefer-string-starts-ends-with warning均位于自有QA logs脚本。详细位置见质量验证；未修改生产Lint配置或删除证据来获得通过，未将全部38388条warning逐项结构化重建。固定工具审计与最后门禁发生在所有UI退出、测试源冻结之后。

## 基线、环境与未覆盖范围

- 分支`main`，HEAD `10e168b7832af6332a14e590739e7cd87b9cf2bf`。对象为含开工前未提交修改的当前工作树，不等同只验证HEAD。原有产品源码改动与声明map保留；本轮只修改QA材料，没有修产品、提交、推送、发PR/issue或触发GitHub构建。
- Node主要实际版本24.18.0、pnpm10.33.2、Windows x64、Electron44.7.0/WDIO9。`mise.toml`固定Node24.14.0，本轮未安装或切换，严格该版本仍未验。typecheck属于当前配置增量检查；内部E2E构建不属于exe/dmg安装包验收。
- 初始freshness因Git TLS失败；后续实际执行含`origin --prune` fetch的正式检查退出0，main与origin/main ahead/behind=0。[原始记录](feature-inventory-freshness.log)只保留日期，不推断秒级时间，也不扩称已刷新所有upstream来源。
- HOME、USERPROFILE、APPDATA、TEMP、XDG、工具缓存、合成`.zcodium`、数据库和证据均隔离在当前工作树，启动前审查实际路径/环境并拒绝越界重解析点。未使用真实用户`.zcodium`、系统临时目录或真实模型Key。详见 [环境审查](e2e-environment.md)、[验证与隔离运行器](validation.md)。
- macOS原生菜单/权限/开发启动、真实Windows DPI/设备权限、真实手机触控及断网恢复、远程SSH/Host、自建relay/Source Server/MCP OAuth、真实Provider/额度/Bot渠道与自建更新源、exe/dmg安装与升级均未完成真机或真实服务验收。390/560px桌面布局、mock和loopback replay不能替代这些环境。
- Git diff在未知继承Git环境键准入前真实skip，未执行Git操作；终端PTY在profile安全前置停止，未启动shell。其它partial组未覆盖动作见矩阵，尤其Provider完整CRUD/recovery、文件多格式/Markdown选择、任务未读/窗口恢复、资源/日志导出、MCP/Skills/Commands保存及Hooks实际生命周期。

本轮证据足以交接已确认缺陷和测试欠账，**不作为87组全动作、全平台发行验收通过结论**。完整阶段运行索引及曾撤回假设保留于 [执行历史](test-execution-history.md)；当前结论以本报告、覆盖矩阵和质量验证的最终截点为准。新增QA用例仍在`manual-review/pending`，没有转正或加入CI。

## 测试副本清理限制

此前自动审批以`blocked by policy`拒绝清理本轮两个staged测试副本：`packages/desktop/.e2e-cache/qa-menu-20261106-core`与`packages/desktop/.e2e-cache/qa-menu-20261106-grp-pin-repro`。拒绝发生在执行删除前，两个副本保留，未换工具绕过；没有清理真实用户数据、历史目录或原有产物。详见 [验证记录](validation.md)。
