# 归档管理与Browser限额补测计划

本计划只选择当前canonical spec，不修改产品或原用例，不启动UI。对应SET-26/TSK-01的归档列表操作和BROW-03的33逻辑tab限额；即使所选断言通过，仍只记组内partial。参数见[additional-local-batch.json](additional-local-batch.json)，执行前以本轮wrapper重新审查实际路径、子项重解析点、子进程环境及无并行writer。静态证据写在`logs/feature-inventory-additional-local-preflight.json`。

归档5it有顺序依赖，全部保留：ARM08页面用语/空结果/全删取消→ARM07关闭时保存阈值及开关/刷新→ARM01/05/06折叠、搜索、排序、项目筛选与中英文/主题/390px→ARM02恢复/删除取消和确认/刷新不复活→ARM03当前筛选批删与分组恢复。不能仅选删除case后把缺少展开前置误报产品。Browser只选BTL04/BTL12一条，和归档拆为两个串行调用：归档`-Bootstrap`无`-OpenSidePane`；Browser`-Bootstrap -OpenSidePane`，免其当前Meta-only的初始面板热键。不给其他spec添加Browser launcher前置。

## 归档5it的I/O与启动边界

`conversation-session/conversation-session-archive-management.test.ts:51–138`只接受`ZCODE_E2E_HOME_DIR` basename为`.e2e-home-*`或`zcode-archive-e2e-*`，本轮wrapper使用前者；名字不是安全证明，绝对位置及祖先/子项仍由guard确认。`H=runtime/<runId>/.e2e-home-<runId>`、`W=H/ZCodeProject`，App库`H/.zcodium/v2/tasks-index.sqlite`，CLI库`H/.zcodium/cli/db/db.sqlite`，设置`H/.zcodium/v2/setting.json`。

before经`restartIntoWorkspacePreservingProfile`保留本树userData，flush storage→deleteSession→按runId/HOME确认旧main/renderer/GPU/utility/Host/Agent进程树退出→`afterElectronProcessExit`双库seed→新Electron/bridge就绪。seed创建3个固定`arm-project-*`项目、5个`arm-*`task及对应CLI session，directory/root全部W；meta必填且无远程identity。未过退出屏障不得seed，屏障失败只记前置/退出层证据。

此冷重启发生suite `beforeAll`，当前外置reload observer从root `beforeEach`才包命令，因此本次归档seed退出屏障未必生成独立PID观察JSON。保留正式helper的退出屏障；没有JSON时不声称已获得外置生命周期实证，也不以首个it开始后的记录反推beforeAll。Browser residency及TSL08在case内重启，才可被当前beforeEach observer捕获。

恢复/删除走真实UI与Host：单删`arm-beta`、当前搜索筛选批删`arm-loose`，断言App `cli_deleted`与CLI `time_deleted`；分组恢复`arm-scheduled`、单条恢复`arm-alpha`。`zcodeTaskServiceAdapter.ts:2947–3006`对去重taskIds逐项归档guard后发CLI delete事实，不执行仓库提交、外部文件递归清理或远端命令。自动归档阈值仅改本树setting，五个session的时间为本次近期值，不触发7/14/30天老数据阈值；仍不验running-task/远端scope/3天阈值。

截图只写R/evidence；布局用当前Electron CDP设备宽度1200/390及本树profile的主题/locale，finally清除emulation并恢复主题/中文。spec无独立after删除fixture；数据清理由本轮afterSession先终止本身份进程再删除H的既有隔离owner负责，不新增清理策略。390px是桌面模拟，不能算手机/触控验收。

该manifest明确`providerRequestPolicy=none`、`noProviderRequests=true`、`requests=[]`，对应upstream JSON的fixtures为空。spec无sendPrompt/API/SSH/git/native external/clipboard调用。有限replay显式为common+此空JSON，抑制legacy池；没有生成录制、capture或真正Provider请求。

## Browser 1it的I/O与启动边界

`browser-tab-residency.test.ts:31–137`在it内`prepareConversationE2E({skipProvider:true})`，不创建/选择Provider，不发prompt；helper仍会写W/.zcode-e2e/shared/readonly-tool.txt，这是本树合成工具fixture而非旧业务数据根。开启初始空tab后仅真实UI建33逻辑tab，复用一个新`about:blank` webview，经公开preload的attach/detach IPC登记，不创建32个live guest、不访问外部URL、不使用设备权限。

第33个logical tab触发最老tab移除，核对renderer tab/live/suspended及main guest计数。随后同一已审查userData完整重启，复用上述进程退出屏障，断言所有tab不恢复。此条不代表真实33页面压力、Agent/人工切换、截图录制或跨workspace close授权。spec after只restoreAllMocks和clearAppData；本轮DEFER cleanup交给同run afterSession，不触碰用户数据。

Browser纯无请求case只显式common.json；这是无Prompt批次的有限空闲mock启动池，不套用此前9spec有Prompt批次禁止common-only的结论。root hooks仍装reload observer，用于采退出PID/cause；fit/SPFV target guard不匹配，不应额外采布局或改UI。

common.json含一个合成只读Read响应，不是空JSON。该skipProvider/noPrompt用例不会请求这一响应；不能因有限replay准入声称执行了模型或工具。

之前Browser批residency beforeAll因queue目录重解析点guard拒绝，0case；日志没有当刻节点绝对路径。后续不跟随Node/PS7扫描无节点，只能表述当前无可识别节点，不能判guard误报、目标安全或放宽guard。本次新runRoot必须重新通过同guard；若再次拒绝，立即保留独立错误/summary，排除未抵达行为，不修改/删除链接。

## 运行与验收

root串行运行各`runs`，使用JSON精确spec和完整标题尾锚grep；不得将候选/路径/fixture检查作为UI通过。此计划没有native picker、真实剪贴板、系统临时目录、自建服务或账号依赖。若运行时发现越界路径/重解析点或身份不明的清理PID，拒绝执行并保留原因。

每轮保存NDJSON、summary、workers、原错误和实际PNG/状态JSON；没有截图不引用不存在的现场证据。归档标题/几何断言可能仍有当前UI合同差异，按源码+实测分层归因，不为了绿测试恢复旧目录或产品行为。Browser入口或重启屏障失败同样不能写成限额产品bug。

状态：**归档5it已合并至menu-reviewed计划，原archive-final不另执行；residency-final仍独立READY / 无新UI证据**。见root维护的[test-plan-menu-reviewed.md](test-plan-menu-reviewed.md)：5spec/47it、Bootstrap+SafeTerminal、无OpenSidePane，有限common+归档JSON。实际[原静态preflight](logs/feature-inventory-additional-local-preflight.json)exit0：精确2spec/6it、558既有路径无symlink/redirect、有限JSON无重复fixture ID，归档none-request manifest确认且checker exit0；这只是原计划审查。最新合并[静态核对](logs/feature-inventory-menu-reviewed-preflight.json)exit0，精确47标题注册及有限replay最后覆盖顺序已核。Browser域不适用conversation checker，按源码skipProvider/about:blank/noPrompt审查记录，不伪造checker通过。没有import原spec、运行hook、UI或build，不据READY计业务通过。
