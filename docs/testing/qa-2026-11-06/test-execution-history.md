# 阶段性测试执行历史

本文件保留截至最后本地补测收尾前的阶段记录，含运行中统计和已撤回假设。它不代表最终结果；最终结论、最新计数及未覆盖项查 [测试报告](test-report.md)、[质量验证](validation.md) 和 [覆盖矩阵](coverage-matrix.md)。后续 QA owner 复验的证据在专项计划与最终报告追加。

# 菜单与功能专项测试报告

测试日期为 **2026-11-06至2026-11-07（Asia/Shanghai）**，目录沿用开始日期。已建立全部 **87个功能组**的针对性检查与覆盖边界；当前已确认 **8项问题：6项产品缺陷、2项测试门禁缺陷**。优先修复敏感权限装配、旧项目迁移与macOS开发入口三个P1问题，再修复两项工具栏压缩和命令中心选择状态三个P2问题；测试契约欠账独立处理。完整复现与修复验收见 [Bug报告](bug-report.md)。

截至已完成归档动作独立复验，实际E2E为 **178个唯一case、226次记录**（其中174个唯一case至少执行一次）；最新结果138通过、35原始失败、5跳过。原始失败包含测试前置、旧契约和session级超时，不能等同35项产品bug。最后一批本地补测与必需门禁仍待实际结果；挂起复验已结束并作为运行候选交接，本报告不宣称87组全操作、macOS真机、真实模型/远端或安装包全量验收。旧截点归入执行历史。

## 源码与运行环境

- 项目：ZCodium 3.17.1，分支 `main`，HEAD `10e168b7832af6332a14e590739e7cd87b9cf2bf`（“修复全仓审查问题并完善回归与架构边界”）。
- 测试对象为当前根工作树，开工前已含会话协议、输入 admission、侧栏、通知、work duration 等未提交修改与新增回归文件，另有生成的声明 map。结果不能等同仅对 HEAD commit 的验证。本轮只新增测试材料，没有修复产品代码、提交、推送、依赖安装、installer 打包或 GitHub 构建。
- Node 实际为 **24.18.0**，`mise.toml` 固定 **24.14.0**；pnpm 实际 **10.33.2**，与仓库固定版本一致。Windows x64 内部 Electron 44.7.0 / WDIO 9 环境，不能据此代表 macOS。
- 初始freshness fetch因Git TLS失败；feature_inventory随后独立执行无 `--no-fetch` 的正式检查退出0，脚本默认实际fetch origin --prune，main与origin/main ahead/behind=0。见 [独立原始记录](feature-inventory-freshness.log)。该成功记录只抓取日期2026-11-06，未推断秒级时刻；保留首次TLS失败历史和独立 `--no-fetch` 检查，不把后者当作此次真实fetch。成功范围是fork origin/main，不扩认为刷新所有upstream来源。见 [计划与基线](test-plan.md)、[环境审查](e2e-environment.md)。
- 每个 run 的 HOME、USERPROFILE、APPDATA、TEMP、XDG、Corepack/tsx/npm cache、应用 `.zcodium`、fixture 与证据均在 `C:/vibecoding/zcodium`。启动前检查祖先/既有子项与重解析点；只复用工作树内固定 pnpm/driver cache，Corepack 网络禁用。见 [执行与安全审查](validation.md)。

## 统计口径与当前结果

唯一确定性用例按测试文件及独立 test 定义去重；E2E 唯一 case 按归一化文件路径与 fullTitle 去重，主题/语言组合保留独立标题。跨批次重跑只增加尝试次数；未抵达 test body 的 hook/启动失败没有 case 记录，不能计为通过、跳过或新增功能 bug。实际this.skip/pending单列，遵循当前reporter summary的status/旧空error兼容合同并与CLI及步骤证据复核，既不计PASS也不计FAIL。一个功能组可包含多项已测和未测动作，所以不计算“87 组通过率”。

| 层级 | 唯一用例 | 已落盘 case/test 尝试 | 结果与解释 |
| --- | ---: | ---: | --- |
| 确定性源码/schema/mock/隔离文件 | 133 | 138（首轮133 + 独立复跑5） | 唯一结果131通过、2稳定失败；复跑3通过/2同样失败，不重复计数 |
| Desktop E2E全部实际记录 | 178（174至少执行一次） | 226（221执行、5跳过） | 最新138通过/35原始失败/5跳过；所有尝试160通过/61原始失败/5跳过。含取消core重复VP30的一次通过；排除此尝试的已完成批次为225记录、159通过/61失败/5跳过 |
| 初始17个spec的静态 replay fixture preflight | 17个检查入口 | 17 | 均退出0，部分有已保留warning；不属于UI通过用例 |
| QA工作树路径扫描guard探针 | 9个安全场景 | 当前记录9项PASS，原6项复跑证据另保留 | 只验证受控动态目录消失/错误分类/越界拒绝，既不属于133个产品确定性test，也不属于Electron UI用例 |
| QA ReplayFixtures参数防护 | 4个参数场景 | 4项PASS | 正向有限7文件列表与空token/缺失json/越界负例的runner前缀预检，无runtime创建、build或UI；独立于上面的9项目录guard |
| core canonical首批（18 specs，已取消） | VP30与已完成core-retry重合 | 1条实际case记录 | VP30通过；plus beforeAll缺项目，CLI未挂bootstrap；18spec未完成。QA INFRA取消exit1，尝试次数另计 |
| 启动/加载/Hook失败 | 不构成case | 另列运行记录 | 初次smoke/外置spec准入与F中2个hook未形成完整case结果；不能由summary infra=0推断无基础设施错误 |

最新全轮结果见 [counts029逐条去重](logs/validation-e2e-counts-029.json)。local-supplement完整19条为11通过/7原始失败/1真实跳过；QLA05/08、RLM08–13与SLM06/08/09已补验通过。GRP第二轮仅在缺grouped前置停止，未抵达pin；archive-list-retry实际ARM03通过，ARM01旧layout switch、ARM02缺alpha前置失败。随后QAR两个新场景完整验证restore/单删/冷重启不复活，GRP第三轮同pin后协议超时已有现场资源且仍待归属。详情见运行索引与[补测归因](logs/validation-supplement-attribution.md)。

<details>
<summary>执行历史与早期统计截点</summary>

menu-reviewed于11-07 **02:38:45北京时间**完成exit1，5spec/47it计划形成 **37条记录：18通过、15原始失败、4真实跳过**。该批结束截点见 [counts018逐条去重](logs/validation-e2e-counts-018.json)。QLA07的记忆开关保存有局部通过，空catalog的scope/refresh未验；SLM05/14为只读归档没有runtime复制/查找入口；SLM07本run已有AstrBot配置，安全guard保留不修改。这四项实际Pending与步骤证据联核，不计PASS或FAIL。QLA09 Browser总开关真实通过。RLM03点击未读后整session协议超时，后10项未抵达；不拆为10个bug。SPFV002真实560px DOM与PNG确认独立 [BUG-007](bug-report.md#bug-007)。ARM后3项沿用前例停留General页，属于QA级联前置失败，不能据groups=0认定归档数据缺失。

早期smoke/features/settings为45唯一E2E；[旧阶段计数](logs/validation-stage-counts.json)保留当时记录。settings retry与final的23个case身份相同，最终23/23通过；retry中4个combo在最后composer等待使用错误QA selector，修正精确locator后四组合全部抵达18页、自动化、商店、新任务，属于已纠正的测试基础设施误报，没有确认新任务产品缺陷。初次smoke的失败发生在用例结果产生前，smoke retry的真实1项通过单独保留。

core-retry于11-07 00:05:11（北京时间）完成：56case，49通过/7原始失败，exit1。纳入此前已完成批次为97唯一case/124尝试；再加取消core的VP30尝试，共 **97唯一case/125次记录**、所有尝试106通过/19原始失败。VP30的身份与core-retry相同，所以取消批次增加尝试、不增加唯一case。[恢复检查点](logs/validation-e2e-counts-checkpoint.json)于11-07 00:51:17（北京时间）重新独立读取全部实际NDJSON，统计不变；local-actions前置失败没有case，后续有效local/filtered/Browser/residual结果仍待追加，不把static目录或启动成功当作功能通过。

恢复后filtered于11-07 **01:31:31北京时间**完成exit1，实际 **19case：11通过/8原始失败**，另有subagent前置与SPFV观察器hook失败。全轮纳入取消core重复VP30后共 **113唯一case/144尝试**，最新96通过/17原始失败、所有尝试117通过/27失败，见 [01:32:19独立去重快照](logs/validation-e2e-counts-006.json)。较早 [01:18:11快照](logs/validation-e2e-counts-005.json)保留运行中仅2条GRP通过的截点，不代表本批最终结果。计划23项中GRP后2条和subagent2条未形成case；标题中的“重载”也不直接证明Electron冷重启。

随后Browser5于11-07 **01:39:28北京时间**结束exit1，实际4case：2通过/2失败，tab-residency的bootstrap reparse前置未形成case。全轮纳入取消VP30后共 **116唯一case/148尝试**，最新98通过/18原始失败/0跳过、全部119通过/29失败/0跳过，见 [01:40:32去重与skip分类快照](logs/validation-e2e-counts-007.json)。空tab/草稿延迟guest与close幂等通过；站点默认permission为高置信候选待第二新run，human冷重启已退出旧进程但后续Browser launcher前置失败，没有完整viewport恢复验收。

menu-final于11-07 **01:49:19北京时间**结束exit1：5spec/43it计划仅权限复验形成1条实际case失败，QLA12/RLM13/SLM15/SPFV2全部在hook前置受阻；没有QLA07/09的实际skip。第二独立guest query稳定`granted`，结合当前源码policy未接线，已确认 [BUG-005/P1](bug-report.md#bug-005)。全轮共 **116唯一case/149尝试**，最新98通过/18原始失败/0跳过、所有119通过/30失败/0跳过，见 [01:50:34独立统计](logs/validation-e2e-counts-009.json)。重复权限case只增加尝试，不增加唯一用例。

local-canonical本轮计划9spec/13case。11-07 **02:02:48北京时间**的历史运行中截点已落2条实际case、0通过/2原始失败：MPS直接将未CSS转义的Windows路径拼入attribute selector，已确认为QA locator错误，未抵达Markdown选择动作；SSC真实拖选最终未保留目标选区，当时仍待现场归因。不新增确认Bug，后续断言未抵达不能计FAIL。此运行中截点全轮为 **118唯一case/151尝试**，最新98通过/20原始失败/0跳过、全部119通过/32失败/0跳过，见 [运行中去重快照](logs/validation-e2e-counts-010.json)。当时没有本批退出证据，完整结束结果另见下文。

本批后续截至11-07 **02:07:34北京时间**已有8条实际case：6通过/2失败；新增通过为PIA01/02、两条深层文件树搜索定位、OPS01/02。全轮124unique/157attempt，latest104通过/20原始失败，全部125通过/32失败，skip仍0，见 [较新运行中截点](logs/validation-e2e-counts-011.json)。没有final退出记录或fit DOM证据，不扩认后续任务拒绝、已有任务命令或240px布局结果。

local-canonical于11-07 **02:11:09北京时间**完整结束exit1，9spec/13case：**8通过/5原始失败**。新增SE-02/03模型默认档位与删除已选模型后候选状态通过；TRJ自动model-I/O写入、TSL08自动切无项目沿用已退休合同，未验它们后续viewer/输入/刷新；MPS为QA locator，SSC切Terminal后选区被focus清空仍待归因，已有多child创建/关闭/路由保留局部通过证据。fit真实24帧与生产源码内存probe确认 [BUG-006/P2](bug-report.md#bug-006)，不扩认普通真窄窗或SPFV同因。全轮纳入取消core重复VP30后共 **128unique/162attempt**，latest106通过/22原始失败/0跳过、全部127通过/35失败/0跳过，见 [本批结束后的独立去重](logs/validation-e2e-counts-012.json)。唯一case只增加12，fit与filtered重合；已完成表排除取消重复的1次通过。

menu-reviewed串行运行中。11-07 **02:23:23北京时间**独立读取14条记录：**10通过/3原始失败/1跳过**；全轮142unique（141至少有一次执行）/176attempt（175执行），最新116通过/25原始失败/1跳过，全部137通过/38失败/1跳过，见 [运行中counts014](logs/validation-e2e-counts-014.json)。QLA01–04、06、09–12与RLM01通过；QLA05外部链接第二请求、QLA08归档switch可见性、RLM02 Markdown复制捕获失败仍需归因，未登记新产品bug。QLA07步骤证据为limited：记忆switch保存通过，合成profile没有saved-memory catalog，scope/refresh未验，实际调用context.skip；它不是PASS或FAIL。QLA09 Browser总开关真实通过，不能沿用早期计划的BLOCKED假设。此时5spec/47it计划尚未完整结束，未执行的Residual/Short/SPFV/归档结果不预记。

较新 **02:26:07北京时间** [counts015](logs/validation-e2e-counts-015.json)已有15记录：10通过/4失败/1跳过，全轮143unique/177attempt，最新116通过/26原始失败/1跳过、全部137通过/39失败/1跳过。新增RLM03真实Mark as unread点击后，同WebDriver session的element/诊断DOM/finally/afterEach连续协议超时，后续动作没有完成，不能分拆成多项功能bug。见 [最后成功动作与第一错误](logs/validation-menu-reviewed-session-attribution.md)；未采挂起期间CPU，不称死循环。

</details>

## 运行与证据索引

| 批次 | 完成结果 | 原始记录与后续边界 |
| --- | --- | --- |
| 确定性菜单/设置/导航/fork审计 | 89项：88通过/1失败 | [日志](logs/validation-tests-menu.log)、[完整命令](logs/validation-tests-menu.json)、[覆盖明细](validation.md#针对性覆盖) |
| 确定性本地功能/通知/Bot/模型 | 44项：43通过/1失败 | [日志](logs/validation-tests-local.log)、[完整命令](logs/validation-tests-local.json) |
| 两项确定性失败独立复跑 | 5项：3通过/2失败 | [日志](logs/validation-tests-reproduce.log)、[命令](logs/validation-tests-reproduce.json) |
| smoke 初次 | exit1，0 case | [summary](runtime/qa-menu-20261106-smoke/evidence/summary.json)、[运行日志](logs/e2e-qa-menu-20261106-smoke.log)；启动前失败，非有效UI验收 |
| smoke retry | exit0，1/1通过 | [case](runtime/qa-menu-20261106-smoke-retry/evidence/test-results.ndjson)、[summary](runtime/qa-menu-20261106-smoke-retry/evidence/summary.json) |
| features 初批12 specs | exit1，21 case：13通过/8原始失败，另2 hook失败 | [case](runtime/qa-menu-20261106-features/evidence/test-results.ndjson)、[summary](runtime/qa-menu-20261106-features/evidence/summary.json)、[workers](runtime/qa-menu-20261106-features/evidence/workers.ndjson)、[日志](logs/e2e-qa-menu-20261106-features.log) |
| settings 初次外置加载 | 未形成有效case | [运行日志](logs/e2e-qa-menu-20261106-settings.log)；pending准入修正后执行retry，不将加载失败计作产品bug |
| settings retry | exit1，23 case：19通过/4 QA selector失败 | [case](runtime/qa-menu-20261106-settings-retry/evidence/test-results.ndjson)、[summary](runtime/qa-menu-20261106-settings-retry/evidence/summary.json)、[逐步PNG/JSON](runtime/qa-menu-20261106-settings-retry/evidence/qa-settings-menu-20261106) |
| settings final | **exit0，23/23通过** | [case](runtime/qa-menu-20261106-settings-final/evidence/test-results.ndjson)、[summary](runtime/qa-menu-20261106-settings-final/evidence/summary.json)、[逐步PNG/JSON](runtime/qa-menu-20261106-settings-final/evidence/qa-settings-menu-20261106)、[日志](logs/e2e-qa-menu-20261106-settings-final.log) |
| core canonical首批18 specs | QA INFRA取消，exit1；仅VP30的1条case通过 | [实际case](runtime/qa-menu-20261106-core/evidence/test-results.ndjson)、[run目录](runtime/qa-menu-20261106-core)、[日志](logs/e2e-qa-menu-20261106-core.log)；CLI `--mochaOpts.require` 未挂bootstrap，plus beforeAll未抵达目标；待修测试入口后重跑 |
| bootstrap 单 plus 检查 | exit1，hook 拒绝 WDIO 自注入 loader，0 case | [日志](logs/e2e-qa-menu-20261106-bootstrap.log)；测试 guard 已改为精确受控 importer；非新增产品bug |
| core-final canonical21 specs | exit1，CLI把逗号连接spec当作单文件，config初始化失败 | [run目录](runtime/qa-menu-20261106-core-final)、[日志](logs/e2e-qa-menu-20261106-core-final.log)；无summary/NDJSON/build/UI，不构成case结果或产品bug |
| core-retry canonical21 specs | **exit1，56case：49通过/7原始失败** | [case](runtime/qa-menu-20261106-core-retry/evidence/test-results.ndjson)、[summary](runtime/qa-menu-20261106-core-retry/evidence/summary.json)、[日志](logs/e2e-qa-menu-20261106-core-retry.log)；bootstrap真实UI恢复项目前置，7条失败独立归因 |
| local-actions补充12项初次 | exit1，0case，运行中seed-lock消失使bootstrap路径扫描失败 | [日志](logs/e2e-qa-menu-20261106-local-actions.log)、[summary](runtime/qa-menu-20261106-local-actions/evidence/summary.json)；仅QA INFRA，setup修复确认消失路径的扫描竞态后retry，尚无本批菜单通过结果 |
| local-actions retry | exit1，0case，DirIOError/DirectoryNotFound扫描前置失败 | [日志](logs/e2e-qa-menu-20261106-local-actions-retry.log)、[summary](runtime/qa-menu-20261106-local-actions-retry/evidence/summary.json)；当时旧修正仅处理PathNotFound，后补精确错误族仍要求当前路径不存在。日志目标为同类长路径，不能据错误名证明目录曾瞬时消失；不是12项菜单失败 |
| local-actions final首次 | exit1，0case，Windows PowerShell 5.1现有长路径枚举失败，00:27:17北京时间结束 | [日志](logs/e2e-qa-menu-20261106-local-actions-final.log)、[summary](runtime/qa-menu-20261106-local-actions-final/evidence/summary.json)、[实际259字符目录对照](logs/e2e-preflight-long-path-powershell.json)；同目录确实存在，PS5.1报DirIOError，PS7.6.9与Node成功读取2项。不是瞬时child消失，不能吞存在路径上的异常 |
| local-actions PS7重试 | exit1，0case，01:13:15北京时间结束 | [summary](runtime/qa-menu-20261106-local-actions-ps7/evidence/summary.json)、[日志](logs/e2e-qa-menu-20261106-local-actions-ps7.log)；PS7扫描已跨过，beforeAll/afterAll均在footer locale submenu locator停止，尚未抵达12项test body。新的QA hook前置待定位，不计菜单product fail；[旧失败HOME集成扫描](logs/e2e-preflight-long-path-integrated-scan.json)229目录/1169项通过仍仅是环境证据 |
| filtered补测10 specs | **exit1，19case：11通过/8原始失败，01:31:31北京时间结束** | [实际case](runtime/qa-menu-20261106-filtered/evidence/test-results.ndjson)、[summary](runtime/qa-menu-20261106-filtered/evidence/summary.json)、[日志](logs/e2e-qa-menu-20261106-filtered.log)；GRP前2、toolbar配置/tooltip/外部点击、MODE01、SC13、SPFV001、单题Enter、工具详情/无edit-fork真实通过。subagent在bootstrap侧面板前置停止，无case；SPFV afterEach观察器失败没有有效DOM/PNG，不扩认布局根因 |
| Browser5 | **exit1，4case：2通过/2失败，01:39:28北京时间结束** | [case](runtime/qa-menu-20261106-browser/evidence/test-results.ndjson)、[summary](runtime/qa-menu-20261106-browser/evidence/summary.json)、[log](logs/e2e-qa-menu-20261106-browser.log)；第五文件bootstrap拒reparse无case。站点query候选、human reload后launcher前置失败分别归因，不把5spec算5完成case |
| GRP挂起候选单复现 | fresh Agent build写声明map时报TS5033，onPrepare退出1、0case；85点sampler未确认Main | [复现计划](test-plan-grp-pin-targeted-repro.md)、[启动前身份检查](logs/validation-grp-pin-prelaunch.json)、[采样NDJSON](logs/validation-grp-pin-sampler-1793990457431.ndjson)、[build日志](logs/e2e-qa-menu-20261106-grp-pin-repro.log)。18:40:57至18:43:46 UTC自然收尾，无UI挂起资源证据；静态9guard与lint仍独立于133/UI |
| RLM挂起后CIM观察 | 2次只读查询，完整identity未匹配，拒绝资源选取exit1 | [先行计划](test-plan-menu-hung-observation.md)、[实际两点记录](logs/validation-menu-hung-cim-1793989860430.json)、[生命周期归因](logs/validation-menu-reviewed-session-attribution.md)。执行已在RLM worker退出之后，不含挂起现场CPU/内存，不使用后续SLM进程，也不计产品test/UI |
| menu-final合并批次 | **exit1，5spec计划43it，实际1case失败，01:49:19北京时间结束** | [case](runtime/qa-menu-20261106-menu-final/evidence/test-results.ndjson)、[summary](runtime/qa-menu-20261106-menu-final/evidence/summary.json)、[log](logs/e2e-qa-menu-20261106-menu-final.log)、[先行计划](test-plan-menu-final.md)。QLA/SLM旧menu handle stale、RLM导入激活前置待查、SPFV bootstrap launcher未出现，均0case；权限第二query确认BUG005。不存在的skip/42case不计结果 |
| local-canonical本地补测 | **exit1，9spec/13case：8通过/5失败，02:11:09北京时间完整结束** | [实际case](runtime/qa-menu-20261106-local-canonical/evidence/test-results.ndjson)、[summary](runtime/qa-menu-20261106-local-canonical/evidence/summary.json)、[日志](logs/e2e-qa-menu-20261106-local-canonical.log)、[先行计划](test-plan-local-canonical.md)；PIA01/02、文件树搜索2条、OPS01/02、SE-02/03通过。MPS/TRJ/TSL为QA合同，SSC终段选区待归因；[fit小摘要](logs/validation-composer-fit-attribution.json)及[源码probe](logs/feature-inventory-fit-probe.json)确认BUG006，普通窄窗未独立验 |
| menu-reviewed补测 | **exit1，37记录：18通过/15原始失败/4跳过，02:38:45北京时间结束** | [实际case](runtime/qa-menu-20261106-menu-reviewed/evidence/test-results.ndjson)、[summary](runtime/qa-menu-20261106-menu-reviewed/evidence/summary.json)、[完整去重](logs/validation-e2e-counts-018.json)、[先行计划](test-plan-menu-reviewed.md)、[前置归因](qa-menu-final-preflight-attribution.md)。QLA07/SLM05/07/14实际skip，QLA09通过；RLM后10项因session超时未形成case；SPFV002由真实DOM确认BUG007 |
| local-supplement | **exit1，19实际：11通过/7原始失败/1跳过，03:05:28北京时间结束** | [case](runtime/qa-menu-20261106-local-supplement/evidence/test-results.ndjson)、[summary](runtime/qa-menu-20261106-local-supplement/evidence/summary.json)、[日志](logs/e2e-qa-menu-20261106-local-supplement.log)、[归因](logs/validation-supplement-attribution.md)；计划22it，RFC/RMC replay hook前置0case，HIST公共codec旧前置2FAIL，RLM04/07与BUG008关联。SLM13为严格profile对象解析SKIP，PTY未打开 |
| GRP固定第二复验 | **exit1，1case前置失败，03:09:58北京时间结束** | [case](runtime/qa-menu-20261106-grp-pin-repro-retry/evidence/test-results.ndjson)、[summary](runtime/qa-menu-20261106-grp-pin-repro-retry/evidence/summary.json)、[121点sampler](logs/validation-grp-pin-sampler-1793991958119.ndjson)。实际Main启动，sampler未匹配身份；缺grouped前置，未执行pin。第三grouped轮随后实际重现协议失效，见下一行 |
| archive-list-retry | **exit1，3实际：1通过/2原始失败，03:19:55北京时间结束** | [case](runtime/qa-menu-20261106-archive-list-retry/evidence/test-results.ndjson)、[summary](runtime/qa-menu-20261106-archive-list-retry/evidence/summary.json)、[日志](logs/e2e-qa-menu-20261106-archive-list-retry.log)；ARM03筛选删除与分组更多取消归档通过；ARM01 layout截图旧switch前置失败，ARM02缺alpha，未登记新产品bug |
| residency-final | **exit0，1/1通过，03:26:30北京时间记录** | [case](runtime/qa-menu-20261106-residency-final/evidence/test-results.ndjson)、[summary](runtime/qa-menu-20261106-residency-final/evidence/summary.json)、[冷重启身份摘要](logs/validation-residency-reload-attribution.json)；第33逻辑tab淘汰最老项并完整重启0tab，复用1真实guest；旧Main10640及13初始PID全退出，新Main31192身份一致，非32live guest压力验收 |
| GRP第三grouped复验 | **exit1，1实际FAIL，03:33:56北京时间结束** | [case](runtime/qa-menu-20261106-grp-pin-grouped/evidence/test-results.ndjson)、[summary](runtime/qa-menu-20261106-grp-pin-grouped/evidence/summary.json)、[181点sampler](logs/validation-grp-pin-sampler-1793993275811.ndjson)、[资源窗口摘要](logs/validation-grp-pin-grouped-live-attribution-1793993639704.json)；项目/三视图/组内首发前置均到达，setTaskPinned与focus返回后同element/screenshot/quit/DELETE失效。确认自动化链路症状重复，产品/driver归属与根因待查，不增8确认数 |
| 归档动作独立QAR | **exit0，2/2通过，03:43:17北京时间结束** | [case](runtime/qa-menu-20261106-archive-actions-final/evidence/test-results.ndjson)、[summary](runtime/qa-menu-20261106-archive-actions-final/evidence/summary.json)、[冷重启PID](runtime/qa-menu-20261106-archive-actions-final/evidence/qa-reload-observe-0-0-4-31128-1793994171626.json)；明确展开组、恢复保留CLI，删除取消不改库、确认仅删目标、重启不复活且旁路task保留；旧Main30896及12PID全退出，新Main31376身份一致，内部observer readerror保留 |

<details>
<summary>QA加载、静态与安全探针历史（不计UI通过）</summary>

| 检查 | 当次结果 | 证据与边界 |
| --- | --- | --- |
| replay与前置审查 | 17入口退出0，UI结果独立 | [环境与具体spec写入审查](e2e-environment.md#证据与验证范围)、[项目bootstrap计划](test-plan-bootstrap.md)、[设置专项计划](test-plan-settings.md) |
| 残余本地菜单补充spec静态准入 | 最近保存18:40:26 UTC，13项注册/noEmit/public codec/targeted lint退出0；随后supplement已有实际case | [静态记录](logs/e2e-preflight-residual-static.json)为2eb73bb1…，代表该次静态输入；旧run装载SHA与前置修正见[menu-reviewed归因](qa-menu-reviewed-attribution.md)，不把单一可刷新静态文件反写为旧运行事实 |
| PS7外置QA适配静态核验 | 总QA noEmit/语法/只读扫描exit0；targeted lint exit1、1warning/0error | [适配及新source指纹](logs/e2e-preflight-ps7-adaptation.json)；local spec第146行spread空fallback警告保留，不能将该定向lint写为通过；旧residual静态SHA属于PS7修改前输入，不反写旧证据 |
| ReplayFixtures参数与SC13目录准备 | 4参数guard项PASS；截图父目录已准备，无UI结果 | [实际runner前缀预检](logs/e2e-preflight-replay-fixtures-parameter.json)、[SC13目录核对](logs/e2e-preflight-sc13-directory-ready.json)；只传有限受审JSON列表，未自动加载legacy池或开启capture；这些准备不增加133产品test/E2E数量 |
| QA目录扫描安全probe | 9场景PASS | [DirIOError三项](logs/e2e-preflight-reparse-dirio.json)、[原六项重跑](logs/e2e-preflight-reparse-race-recheck.json)；瞬时消失须精确NotFound类型且当前路径仍不存在，权限/存在路径/其它IO错误/越界/junction仍拒绝；无应用启动 |
| QA结果skip分类准备 | 7个纯内存分类probe退出0 | [结果](logs/validation-e2e-result-classification-static.json)；兼容当前reporter的动态Pending记录，未来实际skip须CLI/步骤证据联核。独立于133与UI计数 |
| Short15静态准入 | 总QA noEmit、15case真实import注册、定向lint、raw script/keepNames检查退出0；该静态时点未运行UI；随后实际结果见运行表 | [完整静态证据](logs/e2e-preflight-short-static.json)；4240B/3row/0artifact合成归档仅fixture，不是Host导入或UI通过 |
| Runtime复制/会话查找补测准备 | 历史2项静态注册，当前RFC/RMC为3it（18:32:44 UTC静态记录）、总QA noEmit/定向lint/9回调与3raw语法核验退出0；supplement的runtime replay前置失败，实际0case，复制/Find未验 | [计划](test-plan-runtime-copy-find.md)、[静态证据](logs/e2e-preflight-runtime-copy-find-static.json)；有限既有pure-text replay仅建立runtime history前置，不能作为clipboard、查找滚动或真实Provider通过结果 |

静态文件的旧SHA代表当次输入；后续QA修正与实际装载以各run及最新独立静态记录为准，不把旧静态状态当当前尚未运行。

</details>

NDJSON保存每条case的文件、fullTitle、时间、retry、passed与错误；summary仅作索引。失败归因优先结合worker日志、源码、现场与截图，不能直接相信自动errorCategory或infraFailureCount。步骤JSON中的passed只说明该保存点完成，不能覆盖整条case失败。使用 [外置pending spec](manual-review/pending/qa-settings-menu-20261106.test.ts) 不代表已转正或获得CI准入。

## 缺陷与受阻项

确认问题 **8项：产品问题6项、测试基础设施/契约问题2项**；另有2项静态候选欠账。详细前置、步骤、expected/actual、证据、确认程度、定位和修复验收见 [Bug报告](bug-report.md)。

| 分类 | 编号/级别 | 结论及范围 |
| --- | --- | --- |
| 产品 | BUG-001 / P1 | macOS dev脚本未声明变量ReferenceError；精确darwin分支VM与源码确认，未运行mac真机启动 |
| 产品 | BUG-004 / P1 | Desktop项目初迁移未传旧lastWorkspaceSession，合成live SQLite有设置但projects/roots空且0005已登记；未认定真实用户文件或会话内容丢失 |
| 产品 | BUG-005 / P1 | 两个独立新run未授权真实guest的geolocation query均granted，Browser权限policy有实现但未启动接线；未请求位置/设备，不宣称实际泄露 |
| 产品 | BUG-006 / P2 | 工具栏测量副本缺leading/content/trailing骨架，溢出时提前返回；真实人工240px两帧+生产源码内存probe确认，普通真窄窗与双ref/SPFV关联仍待验 |
| 产品 | BUG-007 / P2 | inline浮窗外壳已有压缩flag，内层named CSS owner无flag，真实560px空输入折为两行；与BUG006缺clone结构独立 |
| 产品 | BUG-008 / P2 | 同一Command Center中两个不同Settings命令使用相同cmdk选择值，真实两行同时可见且选中；未抵达Enter执行，未认定重复执行 |
| 测试基础设施 | BUG-002 / VAL-001 / P2 | 旧引导fixture空reportTelemetryEvent被源码守卫扫描；两次稳定失败，非实际遥测 |
| 测试契约 | BUG-003 / VAL-002 / P2 | 旧工作流快照期待遗漏合法offeredMode；两次稳定失败，后续分支首条失败遮挡，非官方购买网络回归 |
| 静态候选 | CAND-001 / P2 | 部分旧.zcode测试root漂移；未执行旧用例，不能计为真实产品失败 |
| 静态候选 | CAND-002 / P2 | About ZCode/Preview/旧日志归档期待漂移；未运行对应旧UI spec |

features原始8个case失败包括4条项目行/项目选择前置、1条Browser侧栏Windows快捷键前置、2条0.666667px对1px视觉期待差异、1条SC13硬编码截图目录不存在。另personalization与side-pane的2个hook未形成case。项目入口依赖功能当时按 **BLOCKED BY migration bug** 记录；“7个功能范围受阻”不是7个bug或7个已执行失败case。随后bootstrap通过正常UI创建合成项目，core-retry已经实际执行对应项目、设置、侧栏和会话动作，按矩阵更新最新结果，不再把历史受阻范围统列未测；迁移本身没有修复。Browser热键、像素期待和SC13证据路径仍保留旧失败原因及复验缺口。

core-retry的7条原始失败中，PLUS05是旧工作流启用mock前置，SPT000/007是旧Logo DOM/5px1px样式期待，W89是旧成功横幅期待；SC90退出屏障和F98 invalid session仍属INFRA/时序待查，尚未验收目标配置行为。SPFV002当时只有旧高度断言失败，menu-reviewed后已以真实DOM/PNG确认独立BUG007；其它项不增加产品bug数。详情见Bug报告QA-DEBT与 [reload只读观察计划](test-plan-reload-observation.md)。

filtered的8条原始失败中，工具栏4条已确认为旧badge/data-highspeed断言或点击role=group容器的QA helper错误；其后真正模型管理点击、hover白点、新draft scope验收没有完成，不能登记对应产品失败，见 [工具栏源码归因](logs/feature-inventory-toolbar-attribution.md)。240px picker后续真实观察与源码probe确认BUG006测量副本缺结构；GRP置顶后的整session协议超时、多题键盘value超时仍待独立归因。GRP旧worker的element/screenshot/quit/DELETE均超时，后新worker正常响应；[最后成功动作与事后PID归因](logs/validation-filtered-session-attribution.md)不含挂起期间CPU。第一独立GRP复验在Agent构建前置失败、85点sampler未确认Main，不能证明挂起根因；第二轮漏grouped前置、未到pin；第三轮按 [计划](test-plan-grp-pin-targeted-repro.md)实际复现同pin后协议超时，已获live资源；仍是高优先运行候选，旧main-null不代表无Main。SPFV旧观察器只有`__name2`错误、menu-final无rawDOM；menu-reviewed新rawDOM已确认BUG007，见 [压缩归因与证据SHA](logs/validation-spfv-attribution.json)。BUG007是inline压缩flag与CSS owner错位，与BUG006缺clone骨架独立。SC13真实通过，旧截图路径欠账保留。

Browser站点权限query两次独立新run稳定granted，源码接线与运行边界见 [独立归因](logs/validation-browser-permission-attribution.md)，已确认BUG005，不宣称设备访问或泄露。human的 [实际reload观察](runtime/qa-menu-20261106-browser/evidence/qa-reload-observe-0-3-2-32284-1793986710714.json)显示oldMain18192及13个初始PIDs全部退出，新Main32720有相同run/home；随后第86行旧Meta/Ctrl launcher helper失败。该次正常退出不能证明历史SC90/F98已解决，观察器内部第二delete的WebSocket未连错误与test.error=null限制也保留。

本轮自主修正的 QA 基础设施另记：外置 pending spec 准入、最后 composer 精确 selector、工作树离线 Corepack/driver 缓存与 loader/cache 隔离、Worker 证据唯一名称、新应用 HOME 的既有 E2E 安全前缀、图片截图目标，以及 pnpm/WDIO 参数转发。最后一项的 [安装版 CLI 纯解析对照](logs/e2e-preflight-cli-options.json)确认去掉单独 `--` 后 hook 的 require 数组可被识别；旧 core run 因 hook 未挂载而取消。单 plus run 又暴露 guard 拒绝框架自己的 loader，已按 [精确 importer 正反例](logs/e2e-preflight-bootstrap-node-options.json)修正。core-final随后在config阶段把逗号连接的21spec作为单路径而退出，runner已改为逐个重复 `--spec`，core-retry随后完成56case。解析成功和 helper 导入成功均不能代替真实 hook 执行结果。这些瞬态问题限于测试材料，没有列为长期产品 BUG，也没有修改业务源码。复用 build 曾做审查，但缺 CLI 构建时完整源指纹，本轮未启用复用、未新增 helper，继续重建保证证据。

core-retry实际运行还发现Worker-only的bootstrap证据名会被同Worker后次调用覆盖：旧0-0-before截图/JSON已显示项目，不能标为首次迁移空表证据。15:53:22 UTC已修为调用序号/PID/timestamp独占名称，新Worker首次before确实保存项目表和侧栏为空的现场，已附 [BUG-004证据](bug-report.md#bug-004)。已装载的旧Worker仍有覆盖限制，不能把其后次内容解释为初始状态。后来独立的SPFV rawDOM与PNG支持BUG007，不反写早期没有有效DOM的尝试。

menu-reviewed的 [QA归因](qa-menu-reviewed-attribution.md)保留QLA/SLM当前旧locator、页面位置、PTY前严格对象解析以及RLM公开只读history边界。RLM02零新增clipboard捕获尚未确认根因，不能先说exactly-once断言过严。RLM03属于session级超时，后10条没有case；ARM08/07旧auto-archive页面期待失败后停留General，后3条归档列表失败属QA级联。补测只适配已退出QA套件并沿用真实UI/隔离边界，未修产品，静态READY不计PASS。后续QAR已完整验恢复/单删/冷重启；RLM05全局草稿改变当前workspace查询范围，RLM06/SLM15旧light-DOM读取不能进入File open shadowRoot，见[补测QA源证据](logs/qa-local-supplement-attribution.md)。修后版本仍待新的实际UI，不能把静态READY写成通过。

## 必需质量门禁

| 检查 | 已执行结果 | 最终状态 |
| --- | --- | --- |
| `corepack pnpm typecheck` | exit0；当前配置增量tsc-b | [首次日志/退出码](logs/validation-typecheck.json)，最后编辑后复跑待通知 |
| `corepack pnpm lint` | exit0，5664 files，0 warnings/errors | [首次输出](logs/validation-lint.log)，最终复跑待通知 |
| `corepack pnpm architecture:check --changed` | exit0，violations/baseline/new=0 | [首次输出](logs/validation-architecture-check.log)，最终复跑待通知 |
| 外置QA `tsc -p .../tsconfig.qa.json --noEmit` | exit0，无诊断；新增12项补充spec及SPFV/reload observers的targeted检查也退出0 | [初次退出码](logs/validation-qa-typecheck.json)、[observer检查](logs/validation-qa-typecheck-observer.json)，最后编辑后复跑待补 |

完整隔离命令、时间、测试文件和门禁失败摘要见 [validation.md](validation.md)。未执行fmt/全量engineering/全量617旧E2E、跨平台installer验收，不把可用命令或测试文件数量当作通过证据。门禁通过与133项确定性测试中2项失败可同时成立。

## 87个功能组逐项索引

每个链接直接跳到覆盖矩阵对应功能行，包含实际证据、partial/FAIL/BLOCKED/NOT-RUN状态以及下一步。源码入口、菜单动作与候选E2E见 [完整功能清单](feature-inventory.md)。同组进入父页面不等于保存/新增/删除/异常/重启持久化全部通过。

| 功能ID与结果详情 | 菜单和功能范围 |
| --- | --- |
| [NAV-01](coverage-matrix.md#nav-01) | 新任务；下拉“从文件导入对话” |
| [NAV-02](coverage-matrix.md#nav-02) | 定时任务主视图 |
| [NAV-03](coverage-matrix.md#nav-03) | 插件商店主视图 |
| [NAV-04](coverage-matrix.md#nav-04) | 折叠左侧栏、拖动宽度、命令中心入口 |
| [NAV-05](coverage-matrix.md#nav-05) | 任务视图：按项目/按分组/最近更新/未读 |
| [NAV-06](coverage-matrix.md#nav-06) | 偏好菜单：语言系统/中文/英文 |
| [NAV-07](coverage-matrix.md#nav-07) | 偏好菜单：主题系统/深色/浅色 |
| [NAV-08](coverage-matrix.md#nav-08) | 偏好菜单：编码/办公界面；界面缩放 |
| [NAV-09](coverage-matrix.md#nav-09) | 设置按钮/返回工作区；上次分区记忆 |
| [NAV-10](coverage-matrix.md#nav-10) | 帮助：产品文档、社区、问题反馈、产品需求 |
| [NAV-11](coverage-matrix.md#nav-11) | 帮助：导出日志、资源管理器、关于、条件更新 |
| [NAV-12](coverage-matrix.md#nav-12) | macOS 原生菜单：应用/文件/编辑/视图/窗口/帮助 |
| [NAV-13](coverage-matrix.md#nav-13) | 原生帮助中的变更记录、开发工具、清除全部数据 |
| [NAV-14](coverage-matrix.md#nav-14) | Windows 窗控、托盘关闭行为 |
| [PRJ-01](coverage-matrix.md#prj-01) | 添加项目：打开本地文件夹/远程项目/新连接 |
| [PRJ-02](coverage-matrix.md#prj-02) | 项目编辑：名称、图标、颜色、多 roots/主目录、设备选择 |
| [PRJ-03](coverage-matrix.md#prj-03) | 项目菜单：新任务/查看各 root 文件/编辑/置顶或取消/移除/管理项目/设备设置 |
| [PRJ-04](coverage-matrix.md#prj-04) | 项目展开、任务拖入、项目排序 |
| [PRJ-05](coverage-matrix.md#prj-05) | 分组菜单：新任务/改名/改颜色/取消分组；任务移组/移到顶部 |
| [TSK-01](coverage-matrix.md#tsk-01) | 任务菜单：置顶/改名/归档或恢复/未读/重启 |
| [TSK-02](coverage-matrix.md#tsk-02) | 任务菜单：文件管理器、复制工作区/任务/日志路径/Session ID/Markdown |
| [TSK-03](coverage-matrix.md#tsk-03) | 任务菜单：Provider 配置、模型调用轨迹、反馈问题 |
| [TSK-04](coverage-matrix.md#tsk-04) | 任务历史导航、未读、后台运行、多任务切换 |
| [TSK-05](coverage-matrix.md#tsk-05) | 项目less/不可用项目草稿 |
| [CMD-01](coverage-matrix.md#cmd-01) | 命令中心四 scope：全部/命令/对话/文件；搜索历史/清除/展开 |
| [CMD-02](coverage-matrix.md#cmd-02) | 命令列表：新任务/打开工作区/设置/切换侧栏/终端/预览/新终端/新浏览器/审查/主题/技能/MCP/反馈/社区/文档 |
| [CMD-03](coverage-matrix.md#cmd-03) | 当前对话/文件查找、上一项/下一项、范围切换 |
| [CHAT-01](coverage-matrix.md#chat-01) | 输入、发送、停止、queue/guide busy 输入、计划模式/权限模式 |
| [CHAT-02](coverage-matrix.md#chat-02) | 模型/Provider/推理强度/context 用量菜单 |
| [CHAT-03](coverage-matrix.md#chat-03) | “+”：附件、目标、工作流；@ 插件/文件/任务/白板 |
| [CHAT-04](coverage-matrix.md#chat-04) | 图片/文本/文件附件预览、删除、恢复、上传进度门禁 |
| [CHAT-05](coverage-matrix.md#chat-05) | 消息复制/选择：添加到任务、侧边问答 |
| [CHAT-06](coverage-matrix.md#chat-06) | 工具调用、reasoning、todo、文件修改分组、折叠/展开、后台 Bash |
| [CHAT-07](coverage-matrix.md#chat-07) | AskUserQuestion：选项、自填、键盘、自动解决 |
| [CHAT-08](coverage-matrix.md#chat-08) | 子 Agent 会话/目录、工作流运行/参与者/脚本/产物 |
| [CHAT-09](coverage-matrix.md#chat-09) | 本地对话导出：选择范围、取消该轮、确认、保存；导入只读对话 |
| [PANE-01](coverage-matrix.md#pane-01) | 标签打开/切换/关闭/拖排/overview 搜索、全视图/浮动对话 |
| [FILE-01](coverage-matrix.md#file-01) | 文件管理器、树展开/搜索/sticky folders/Git 标记 |
| [FILE-02](coverage-matrix.md#file-02) | 文件右键：打开/外部应用/浏览器/另存为/定位/绝对或相对路径/添加到聊天 |
| [FILE-03](coverage-matrix.md#file-03) | 文件预览：代码/Markdown/SVG、源码或预览、主题/行号/换行/字号 |
| [FILE-04](coverage-matrix.md#file-04) | 图片预览：缩放/复制/另存/编辑入口 |
| [FILE-05](coverage-matrix.md#file-05) | PDF/PPTX/DOCX/XLSX/旧 DOC/音视频 |
| [GIT-01](coverage-matrix.md#git-01) | Git 审查：变更范围、当前会话/上轮、搜索、刷新、diff 展开 |
| [GIT-02](coverage-matrix.md#git-02) | Git 文件右键：复制路径、定位文件管理器/文件树；代码评论 |
| [GIT-03](coverage-matrix.md#git-03) | 分支菜单：搜索、切换、创建、dirty assistance；Git 图/commit 详情 |
| [GIT-04](coverage-matrix.md#git-04) | 提交菜单：message、生成 message、含未暂存、提交/提交并推送/推送 |
| [TERM-01](coverage-matrix.md#term-01) | 集成终端：开关、新 tab、切换/关闭、字体/shell/profile、输入输出/链接 |
| [BROW-01](coverage-matrix.md#brow-01) | 浏览器：地址/后退/前进/重载、responsive/元素选取、更多外部打开/devtools |
| [BROW-02](coverage-matrix.md#brow-02) | 浏览器权限请求、站点设置、JS dialog、下载/新窗口 |
| [BROW-03](coverage-matrix.md#brow-03) | 浏览器 tab 生命周期、Agent 控制与人工视图、截图/录制 |
| [EXTRA-01](coverage-matrix.md#extra-01) | 网站内置插件 UI、普通插件 UI/嵌入 MCP App |
| [EXTRA-02](coverage-matrix.md#extra-02) | 白板、@ 白板；文件活动图 |
| [EXTRA-03](coverage-matrix.md#extra-03) | 开发工具页；模型调用轨迹筛选/展开 |
| [SET-01](coverage-matrix.md#set-01) | 常规：语言、编码/办公模式 |
| [SET-02](coverage-matrix.md#set-02) | 常规：终端继承 profile、字体、Windows shell auto/指定 |
| [SET-03](coverage-matrix.md#set-03) | 常规：增强文件搜索、Tool Search、主动建议、动态工作流设置 |
| [SET-04](coverage-matrix.md#set-04) | 常规：HTTP proxy、NO_PROXY、CA 文件 |
| [SET-05](coverage-matrix.md#set-05) | 常规：Chromium 硬件加速、条件 Preview/自动更新 |
| [SET-06](coverage-matrix.md#set-06) | 常规：通知/声音、关闭到托盘、运行保持唤醒 |
| [SET-07](coverage-matrix.md#set-07) | 常规：busy 输入 queue/guide、自动回答、reasoning/todo、探索/终端/修改工具分组 |
| [SET-08](coverage-matrix.md#set-08) | 常规：数据目录选择/手写/恢复默认、重新打开引导 |
| [SET-09](coverage-matrix.md#set-09) | 外观：主题、UI 字号、light/dark 代码主题、行号/换行/代码字号/样例预览 |
| [SET-10](coverage-matrix.md#set-10) | 模型供应商：模板、新建/删除、名称/Base URL/API format/Key、连接检查 |
| [SET-11](coverage-matrix.md#set-11) | Provider 模型：新建/删除/目录选择/排序、context/output/capability/reasoning/advanced |
| [SET-12](coverage-matrix.md#set-12) | Source Server：SSH/WSL/Docker profile 名称与连接配置、目标/镜像个人配置 |
| [SET-13](coverage-matrix.md#set-13) | Source Server：连接/断开/重启/停止/身份变化确认/移除 |
| [SET-14](coverage-matrix.md#set-14) | 浏览器：Agent 控制、Windows Chrome 导入 consent、忽略不安全证书、清 cache/全部数据 |
| [SET-15](coverage-matrix.md#set-15) | 电脑控制：启用/禁用、输入入口开关、权限申请/状态/OS 能力 |
| [SET-16](coverage-matrix.md#set-16) | 键盘快捷键：搜索/按键搜索、录制/冲突抢绑/删除/恢复 |
| [SET-17](coverage-matrix.md#set-17) | 个性化：本机全局 AGENTS 指令、保存/取消/大小限额/失败重试 |
| [SET-18](coverage-matrix.md#set-18) | 记忆：workspace memory 开关、摘要模型、项目选择/搜索/文件只读/刷新 |
| [SET-19](coverage-matrix.md#set-19) | 子 Agent：用户/内置/项目分组、新建/编辑/删除/启用、模型/推理/tools/prompt/inject AGENTS |
| [SET-20](coverage-matrix.md#set-20) | 插件：scope、搜索/启用筛选、安装/更新全部/卸载、详情与 config、内置/远程同步入口 |
| [SET-21](coverage-matrix.md#set-21) | MCP：新建/edit/delete/toggle，stdio/SSE/HTTP，env/header/OAuth/status/tool 列表 |
| [SET-22](coverage-matrix.md#set-22) | 技能/命令：列表、搜索、scope、创建/edit/delete/启用、插件托管资源/导入 |
| [SET-23](coverage-matrix.md#set-23) | Hooks：列表/启用筛选、创建/edit/delete/import、workspace trust |
| [SET-24](coverage-matrix.md#set-24) | 使用统计：时间范围、日用量/模型趋势/占比/热图、自带 Key Provider 额度 |
| [SET-25](coverage-matrix.md#set-25) | 项目管理：搜索/过滤/sort、选中/批量移除、unused、removed 恢复、分页 |
| [SET-26](coverage-matrix.md#set-26) | 归档管理：scope 搜索/恢复/删除/全部删除、自动归档开关及 3/7/14/30 天 |
| [AUTO-01](coverage-matrix.md#auto-01) | 定时任务：状态过滤/搜索、模板/新建、name/instructions/project/model/权限/schedule |
| [AUTO-02](coverage-matrix.md#auto-02) | 定时任务：启用/暂停、编辑/删除/立即运行、运行历史/打开结果 |
| [AUTO-03](coverage-matrix.md#auto-03) | 自动化中心保存工作流 tab：全局/项目、详情/meta/args、启动/移组/提升、历史 |
| [REM-01](coverage-matrix.md#rem-01) | 手机远控弹窗：启停、QR/link/copy、refresh 二次确认、连接状态 |
| [REM-02](coverage-matrix.md#rem-02) | 手机远控设备/项目切换、聊天/权限/终端/未读/恢复 |
| [REM-03](coverage-matrix.md#rem-03) | 远程连接流程：线路类型、credentials/目录、连接日志/重试/取消/历史 |
| [BOT-01](coverage-matrix.md#bot-01) | 远控弹窗的 Bot Channel/管理 Bot：渠道选择、新建/删除/name/model/tools/workspace access |
| [BOT-02](coverage-matrix.md#bot-02) | 绑定码/二维码、渠道配置、群组/主题、private retry/automation delivery |

## replay、平台与外部动作边界

本轮真实Electron点击只针对隔离内部Windows应用；模型请求使用case-owned loopback replay与合成响应，不读取真实Key，不把replay完成当作真实Provider能力、网络故障恢复或费用/额度验收。普通目录选择和部分原生窗口/OS动作使用mock；项目bootstrap保留真实创建持久化链路但原生目录选择仍是mock。源码manifest只对packages各src与staged app输出保存指纹，不能覆盖未记录的docs QA/hook、CLI/build scripts和配置输入。

macOS原生菜单、系统权限/屏幕录制、dmg、真实手机触控与网络重连、SSH/远端服务器、self-hosted relay/更新/OTLP、真实MCP OAuth/Bot发送、Provider联网、真实Chrome导入、安装升级及大数据性能未完成验收，按矩阵具体项保留条件与缺口。没有下载Linux安装资源、恢复官方账号/云控制面、自动上传诊断、发送外部消息或发布站点。

测试仍在进行。最终报告应追加canonical批次及专项复跑、最后质量门禁、完整可复放证据，保持历史失败原因与最新结果各自可追溯；没有新证据的功能继续保留NOT-RUN/BLOCKED/partial。


### 测试副本清理限制

root已准备只清理本轮自己创建的`packages/desktop/.e2e-cache/qa-menu-20261106-core`与`packages/desktop/.e2e-cache/qa-menu-20261106-grp-pin-repro`两个staged副本；目标祖先/后代重解析审查与native PowerShell删除命令在CreateProcess之前被自动审批拒绝（`blocked by policy`），没有执行、没有删除或cleanup JSON。两个副本仍保留，未重试或换工具绕过。其它运行的自然清理按既有runner执行；没有清理out、bundled Agents、声明map或真实用户目录。
