# 最短剩余本地菜单动作计划

local-supplement SLM15 已显示真实预览且截图有首行，旧preview.textContent断言不读取当前 @pierre/diffs File的open shadowRoot。源码CodeViewer:12、208–226及已装File/renderer证明该owner，之前Monaco推断纠正。最小QA只在preview内递归open shadowRoot取[data-code]首行，去除唯一行终止符并仅U+00A0归一为普通空格，精确比完整已知首行；保留timeout、滚动与Find路由断言，不伪DOM。SLM13现场unknown profile keys继续真实SKIP，不放宽安全门禁、不复跑。旧证据/修前后SHA见 [独立归因](logs/qa-local-supplement-attribution.md)。

19:38:25 UTC [最终静态](logs/e2e-preflight-final-local-gaps-static.json)确认source SHA256 `5cff511dc4b82153fb71ff9d6e2bac8c229ec18cef4b171bac5bcb39174ad4af`，全外置noEmit0/相关六文件lint0/真实fullTitle精确SLM15。仅新版本SLM15待真实运行，其余旧PASS/SKIP/FAIL不改写。

2026-11-06 menu-final 实际 worker 0-2 在beforeAll遭遇菜单退出期旧WDIO handle的stale，15项均未执行。补测先以renderer同步DOM快照读可见菜单/状态，新句柄仅用于实际点击，狭义stale可重查，其它driver错误保留。归档导入生成独立shared context和顶部只读rows，标题精确带当前locale前缀。SLM05 runtime assistant copy及SLM14 runtime会话find不能从该只读fixture取得原计划runtime前置；本轮实际确认只读块存在且没有runtime目标后记录BLOCKED，不能记产品缺陷或功能PASS。其余13项继续真实UI。下一阶段另用有限已有replay真实composer首发建立runtime历史后补这两项，不运行Git提交或diff部分。

状态：READY（静态）/ UI 尚未执行。新增外置 pending suite；不改产品、旧 canonical 或当前运行中的 bootstrap。每项保存独占 PNG/JSON；失败保留窗口帧与时间序列，不宣称未编码 WebM 为录屏通过。仅当前 run HOME / evidence / project 写入，全部祖先、子树及子进程环境通过原窄 reparse 守卫 + 已安装 PS7。

## 可执行场景与范围

| ID | 实际操作 | 验收 |
| --- | --- | --- |
| SLM01 | Electron 实际 application Help menu 的 What's new / 更新日志 | 真实 menu callback 请求 mock shell.openExternal，仅本 fork CHANGELOG URL，无真实联网 |
| SLM02 | help.toggle-dev-tools 真实开、关 | 当前主窗口 isDevToolsOpened false→true→false，恢复初始状态；不打开外部 URL |
| SLM03 | Native Clear All Data 对话框 mock Cancel | showMessageBox buttons/defaultId/cancelId准确；返回0；无 relaunch/exit，隔离setting文件与synthetic task数保留；不验确认删除 |
| SLM04 | 两个真实零root项目的 KeyboardSensor Space/ArrowDown/Space | DOM顺序交换，localStorage order持久化；反向键盘操作恢复。只创建合成项目，不访问外部目录 |
| SLM05 | 真实UI导入公开 completed 一轮后复制 assistant | 复用 residual 的公开header/user/assistantText格式和Host import事务；精确v4-copy-rowId；捕获唯一writeText，正确assistant marker，勾选态恢复 |
| SLM06 | Settings sidebar及general引导入口进入→关闭 | onboarding-page及唯一当前step真实出现；Close后原设置页面回归；不进行配置/迁移 |
| SLM07 | Remote Control总菜单 Manage Bots→新增Bot provider选择前取消 | 只读取本地空配置/状态；不选择provider、不Save、不触发注册/QR/外部账号；配置无新增 |
| SLM08 | 真实文件树右键复制绝对/相对路径 | Host文件树提供本树中文空格文件；双clipboard拦截；每次正确唯一path，无真实剪贴板 |
| SLM09 | 同文件 Add to chat，然后Save As取消 | 正式composer产生该文件mention/attachment，不发送；Host读原字节，mock showSaveDialog canceled；源文件hash与任务数保留，无保存文件 |
| SLM10 | coding launcher Review→Git tab→关闭 | 真实Git面板和source selector出现；不commit/push；关闭后tab消失，composer/task不变。无Git根时只报告入口/空态，不称diff内容通过 |
| SLM11 | coding打开Review后切office再切回 | office隐藏新Review/Terminal launcher；已有Review tab与当前task保留；恢复原mode。PTY保活仅在SLM13安全门禁通过后补充，不借DOM存在替代PTY运行 |
| SLM12 | coding真实side pane launcher whiteboard负测 | launcher确实可见，whiteboard项不存在；不人为加launcher或direct store注入，不扩称白板编辑功能通过 |
| SLM13 | 受限真实Terminal echo/read输出，office切换后第二次echo | 先验证终端实际shell/cwd/env/PSModulePath和profiles；门禁失败标BLOCKED，仅本例停止。输出精确合成marker、文件正文marker、PWD路径留本树；切office后同tab/PTY继续输出，恢复coding并关闭本例tab |
| SLM14 | 公开导入长assistant正文后的会话查找 | 真实快捷键；同marker三处，next/previous/Enter/ShiftEnter改变active命中并重新居中；当前合同关闭会清空查询，重开确认空查询、重新输入并恢复首处定位。不发送Provider、不创建Git基线 |
| SLM15 | 本树1300行text preview及当前查找路由边界 | 正式文件树预览、滚动；当前CodeViewer没有局部find UI/路由，真实Ctrl+F仍打开任务conversation/changes查找。保存实际路由与preview保留证据，仅给FILE03预览partial，不称文件内容find通过。不执行commit |

## 终端门禁

root维护外置runner的显式 -SafeTerminal 开关。启动前只在QA进程env限定PSModulePath为 C:\Program Files\PowerShell\7\Modules 和 C:\Windows\System32\WindowsPowerShell\v1.0\Modules，先只读审查二者存在且无reparse。PSModuleAnalysisCachePath限定本树cache/pwsh-module-analysis；不改当前bootstrap required列表，由新suite自验证。

为在任何 canonical Terminal tab 创建前守住同一边界，runner 在 E2E 编译/启动前追加 `pwsh -NoProfile -NonInteractive` 只读预检：确认 PATH 命中已有 PS7、四个 profile 无外树现存文件、启动自动追加的模块路径仅限本树和两个已审系统目录。PS7 自动追加的 `C:\Program Files\PowerShell\Modules` 只在仍不存在且祖先无重解析点时接受。未知路径、外树现存 profile 或读取错误均在应用启动前拒绝；证据只保存布尔标记。suite 仍复查实际 Electron/Host 环境，不把预检当作 PTY 通过。

terminalService.ts 的 Windows nodePty.spawn(shell,[]) 会加载 profile，resolveTerminalEnv()直接来自 Host process.env。因此不能仅在已启动 Main 修改PSModulePath就声称改变了Host。suite用实际Electron继承env的pwsh -NoProfile -NonInteractive子进程只读检查四PROFILE存在性，报告布尔marker，不保存真实用户路径/内容。任何存在且树外profile拒绝实际PTY；树内profile需原reparse审查，不新建profile、不读取内容。所有用户缓存/临时env必须均在工作树；Windows shell解析必须命中已安装PS7，cwd必须由精确session确认。无法证明Host继承同一run环境则本例BLOCKED，其余继续。

PS7启动会自动前置当前用户Modules路径及C:\\Program Files\\PowerShell\\Modules；实际probe逐项分类：本树路径经audit、原2个installed系统根由runner全树audit、明确缺失的上述系统默认根仅审祖先且确认不存在。任意其它树外路径、已存在的额外默认根、或任一reparse均BLOCKED。不是简单要求子进程ModulePath与原输入字符串相等。当前root只读probe四profile均不存在，仍须每次实际Main环境重验。

命令只包含echo、Get-Content -LiteralPath本树合成文件及PWD输出，不使用printf、外部网络、用户目录或安装工具。不绕过正式退出屏障或kill别的运行进程。

## 当前不提供的动作

“设置环境变量开关”当前无可见页面或总开关消费者。仅components/ai-elements/environment-variables.tsx有未装配的本地showValues组件。SET07按源码标unsupported / 未执行，不编造UI开关，不借SET24使用统计冒充。Bot取消不代表配置注册/消息收发通过；Clear Cancel不代表清空数据成功；Git入口不代表提交/推送验证。

普通FILE preview局部Find同样当前未提供：previewPaneCodeContent→CodeViewer无search/find输入或路由。App的Ctrl+F打开TaskFindDialog，scope仅conversation/changes，后者属于GitPane文件变更查找。SLM15验证这一可见边界；CMD03会话内容查找由SLM14执行。源入口证据不扩大成已验证文件内容搜索。

## 来源

当前desktopApplicationMenu.ts / desktopCommandHandlers.ts；ProjectNodeContent.tsx / SortableProjects.tsx；ConversationRowView.tsx；SettingsPage.tsx / onboarding；WebRemoteControlDialog.tsx / BotsDialog.tsx；WorkspaceFileTreeRowView.tsx / FileSaveAsMenuItem.tsx / fileCopy.ts；AnimatedSidePanePanel.tsx / SidePaneTabTrigger.tsx；terminalService.ts。复用现有项目、V4、Host probe、recorder helpers，fixture只按共享公开schema经services/node encode/decode。

## 静态结果与串行执行

### menu-reviewed 失败后的最小 QA 复测

旧 worker0-2已退出后，仅调整可测的 SLM06/08/09/13/15。06当前侧栏实际文案为英文 `Onboard` / 中文 `引导`，原 `Onboarding` 是测试匹配错误。08失败帧确有完整文件右键菜单，日志124562的目标index3/e232也是Copy absolute path；随后QA `scrollIntoView`发wheel18，18:30:42.198在真正elementClick前stale，不能记为产品菜单缺失。09、15同样使用该多余滚动helper。复测限定当前open context-menu，已在视口的文件/菜单目标先等待几何与hit-test稳定，再用新WDIO句柄真实pointer点击，不产生额外wheel，也不伪造onSelect或contextmenu。

13在实际Electron继承env的NoProfile只读probe后返回结构对象，原无条件JSON.parse把它转成`[object Object]`报错，PTY尚未创建。QA只接受JSON字符串或完整同shape对象，严格验证profiles/modules两键、四个唯一绝对profile路径、布尔exists、唯一绝对module路径；未知形状继续拒绝。原Main/Host继承证明、PSModulePath、cache、profile、reparse安全门禁全部保留，增加返回类型和分类证据。

07现场本run隔离bot-config.v3.json中bots数组实际有一项AstrBot，非空guard正确；不清除或覆盖该配置，不列复测。05/14已证实公开readonly归档不提供runtimecopy/Findindex，保持BLOCKED，由独立有限RFC/RMC补运行时正向路径。新选项Grep `(?:^| )SLM(?:06|08|09|13|15):` 共五项，需要root `-SafeTerminal`，不需要预打开side pane；其余旧PASS不重复计数。Mocha匹配suite fullTitle，不用起始`^SLM`；独立stub裸it注册数不能证明filter准入，以[合并fullTitle probe](logs/feature-inventory-local-supplement-preflight.json)为准。新静态证据不是UI通过。

2026-11-06 18:45:23 UTC 修后静态 READY：all外置QA noEmit 0、SLM15项实际注册、5文件lint 0、65callback keepNames finding 0、5rawJS syntax 0；严格probe纯合成object/string两种输入接受、8种错误shape全部拒绝，未执行Main/Host/PTY。见[当前静态证据](logs/e2e-preflight-short-static.json)。修后suite SHA256 `abb2086e369104e2dd2e0a47405966296ea254e9aa8aefd426ae1a1906f39fbe`，menu-reviewed原loaded SHA `eaca839f6ba0a303d46adac1027745a7f898145d6d87463ddf70214571d2de1c`。真实复测结果另行保存，不覆盖旧5FAIL/3SKIP/7PASS。

2026-11-06 17:40:43 UTC：[suite](manual-review/pending/qa-short-local-menus-20261106.test.ts)实际tsx导入注册15项，全部外置QA TypeScript noEmit 0，4个外置文件定向lint 0 warnings / 0 errors；公开长归档encode/decode 4240 bytes、3rows、0artifact、assistant 28828字符。61个自有execute callback经keepNames编译并只读求值函数本身，没有内部__name闭包；3个raw browser script解析无错误。详见[静态证据](logs/e2e-preflight-short-static.json)。没有执行hook/case/UI/Host导入/PTY，不计UI PASS。

suite SHA256：`6abe6c4ba875b0a3197f33ce48db7662d35b654517bbd42406c7a580c51649ac`。两处clipboard/file picker适配器用rawJS避免tsx属性callback命名闭包；[外置RPC adapter](qa-local-rpc-probe.ts)等价复用当前Window Host端口，编解码仍用原callHandoffHost。正式helper/协议不改，纯本轮QA adapter可独立恢复。

root等前一批桌面完整退出后运行；不启动并行桌面：

```powershell
& .\docs\testing\qa-2026-11-06\run-menu-tests.ps1 -RunId qa-menu-20261106-short-local -Bootstrap -OpenSidePane -SafeTerminal -Specs '../../docs/testing/qa-2026-11-06/manual-review/pending/qa-short-local-menus-20261106.test.ts'
```

合并QLA12/RLM13/SLM15/SPFV001+002为42条时仍各spec单worker串行，Grep为`(?:QLA\d{2}:|RLM-\d{2}:|SLM\d{2}:|SPFV-E2E-00[12])`。不得单跑SPFV002，因其依赖001真实创建side pane。全部外置菜单无Provider send，common空replay；SPFV使用skipProvider=true的QA配置。ROOT独占runner/运行hook，suite不会改它们。
