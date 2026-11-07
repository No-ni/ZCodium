# 本地菜单与历史viewer合并补测

当前5spec/22it已完成修正后的Mocha fullTitle静态READY；root已启动独占run，功能结果尚待真实NDJSON/summary。原probe仅按it.title过滤，起始`^`不能匹配有describe前缀的实际Mocha fullTitle，旧3/17/22及ARM3的grep准入结论无效；本计划执行grep已改`(?:^| )`。18:50:23.428UTC最终真实注册45、fullTitle选22/排除23、noEmit0、accepted=true；旧anchored表达式按fullTitle实际选0，已归QA准入修正，不计UI失败或产品bug。root授权原3spec/7it为QLA05/08、RFC01/02/RMC03、HIST01/02，加RLM04–13及Short06/08/09/13/15五项。计划作者不启动UI/build，不修改产品或canonical，不重复已通过的QLA其他10项、RLM01/02/03或SLM。归档ARM3独立run，不混入RFC的exact两条fixture。

| spec                                                                                        | 精确选中标题                                                                                                                                                                                   | 范围与本轮缺口                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [qa-local-menu-actions](manual-review/pending/qa-local-menu-actions-20261106.test.ts)       | `QLA05: 帮助四个fork链接只请求mock openExternal`；`QLA08: 自动归档关闭时可设30天、开关保存并恢复`                                                                                              | menu-reviewed首个文档链接mock出口通过、第2社区未捕获；归档开关在旧general路径未找到。只修QA当前入口/配置合同后复验，不放宽产品行为。QLA05只拦截外部打开，QLA08值只写本run HOME并恢复。         |
| [qa-runtime-copy-find](manual-review/pending/qa-runtime-copy-find-20261106.test.ts)         | `RFC01: finite runtime assistant正文真实复制并恢复勾选反馈`；`RFC02: runtime会话唯一命中滚离后四种导航与重开居中`；`RMC03: runtime任务Markdown完整复制、受控拒绝与恢复重试`                    | 用有限本树replay纯文本首发建立真实runtime历史；补public readonly投影没有runtime message copy/Find与Markdown导出rows的前置。3项顺序共用一次受控首发，不增加真实Provider请求、不初始化/提交Git。 |
| [qa-historical-trajectory](manual-review/pending/qa-historical-trajectory-20261106.test.ts) | `HIST01: public imported synthetic history renders six roles, collapse, expansion and captured copy`；`HIST02: historical virtual matches navigate, retain expansion and bounded tail refresh` | 2项顺序：公开合成archive导入建立task，再wx独占本树历史JSONL，真实Host只读viewer。六role、展开/复制、80虚拟行、查找/override及33MiB有界尾读；不恢复自动writer，不发prompt。                     |

精确5spec列表和22it grep，路径由根runner从`packages/desktop`解析；不会以逗号字符串直接作为WDIO单spec，runner使用逐个`--spec`：

```powershell
$qaSupplementSpecs = @(
  '../../docs/testing/qa-2026-11-06/manual-review/pending/qa-local-menu-actions-20261106.test.ts'
  '../../docs/testing/qa-2026-11-06/manual-review/pending/qa-runtime-copy-find-20261106.test.ts'
  '../../docs/testing/qa-2026-11-06/manual-review/pending/qa-historical-trajectory-20261106.test.ts'
  '../../docs/testing/qa-2026-11-06/manual-review/pending/qa-residual-local-menus-20261106.test.ts'
  '../../docs/testing/qa-2026-11-06/manual-review/pending/qa-short-local-menus-20261106.test.ts'
)
$qaSupplementGrep = '(?:^| )(?:QLA(?:05|08):|RFC0[12]:|RMC03:|HIST0[12]:|RLM-?(?:0[4-9]|1[0-3]):|SLM(?:06|08|09|13|15):)'
$qaSupplementFixtures = './test/e2e/fixtures/upstream/common.json,./test/e2e/fixtures/upstream/conversation-session/conversation-session-chat-find-refocus.json'
# 仅root在当前桌面/Host退出屏障完成、所有选中源final READY后串行执行：
& .\docs\testing\qa-2026-11-06\run-menu-tests.ps1 -RunId qa-menu-20261106-local-supplement -Bootstrap -SafeTerminal -Specs ($qaSupplementSpecs -join ',') -Grep $qaSupplementGrep -ReplayFixtures $qaSupplementFixtures
```

无OpenSidePane；SLM13要求SafeTerminal，并在真实Host/PTY中核shell/profile/cwd。原7/17it不含SLM13时不需SafeTerminal；HIST自行通过真实task菜单打开轨迹。只选HIST02会缺HIST01的viewer/owned文件前置；RFC三项均必须保留同suite before的唯一首发。所有未选case不执行，suite必要before/after仍执行，不能把grep理解成取消生命周期。

## 源、fixture与注册证据

当前源SHA256如下；QLA05/08由setup独立核对当前合同的final静态READY确认，合并实际注册/noEmit也已exit0；静态就绪不代表本次修过的QA路径已经UI通过：

| 输入                                        | SHA256                                                             | 准入状态                                                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| qa-local-menu-actions-20261106.test.ts      | `fb3c4976fb123617561f22e6de64b02e428070ec29f1510be1c45298aad98b2d` | [QLA05/08静态READY](logs/e2e-preflight-qla-reviewed-static.json)，12注册/noEmit/lint与4个QA边界probe；不是UI通过                    |
| qa-runtime-copy-find-20261106.test.ts       | `9187dfd0a79c389db3a7a9e96af22d7d1024e8a5a22bdf9db43b8bbdb87da9ff` | [3it静态READY](logs/e2e-preflight-runtime-copy-find-static.json)，不是UI通过                                                        |
| qa-historical-trajectory-20261106.test.ts   | `aa474c825ed0ae27c0af0e4b168aaba193282185a7dcdd7aad4c01c156335c1d` | [2it静态READY](logs/feature-inventory-historical-static.json)，不是UI通过                                                           |
| qa-residual-local-menus-20261106.test.ts    | `2eb73bb1cb66625d0d074c71ecfe68649c43d29b0e1c57442c12d8499fa70ab7` | [RLM04–13独立静态READY](logs/e2e-preflight-residual-static.json)，13注册/选10，不是UI通过                                           |
| qa-short-local-menus-20261106.test.ts       | `abb2086e369104e2dd2e0a47405966296ea254e9aa8aefd426ae1a1906f39fbe` | [Short5独立静态READY](logs/e2e-preflight-short-static.json)，15注册/选5，65callback/5raw/严格边界2good8bad；不是UI通过              |
| common.json                                 | `60f4898eb393afc84f86d9d492af910928658a954b1a777d7d5d5cb537033210` | 既有有限1条合成Read响应；不是空fixture，不代表已调用Read                                                                            |
| conversation-session-chat-find-refocus.json | `923ba7e0bd67592b79ee3b5c2eca589f81ba6fa578d6c3598ab9cd01b417e50b` | 既有`chat-find-refocus-long-body`，pure text/fast-text/synthetic，响应3930字符，marker恰1；RFC唯一main请求匹配并完成200才算前置通过 |

合并注册检查见[preflight脚本](logs/feature-inventory-local-supplement-preflight.cjs)与[输出](logs/feature-inventory-local-supplement-preflight.json)，最终5spec版本实际exit0、accepted=true、noEmit诊断0、注册45个it、真实describe栈构造Mocha fullTitle后精确选22/排除23。原probe以it.title算的3/17/22过滤输出不是Mocha准入。脚本在新本树static HOME/缓存内实际tsx import模块，describe只注册it，before/after不调用，browser Proxy拒绝任何UI读取；不生成会话/历史，不启动Host/Provider/build。只有最终实际输出的source SHA/count/accepted为静态准入证据。源变化后重新核对，静态结果不写入UI通过计数。

## 路径、I/O与混合pending边界

根runner只接受本树现有spec/JSON，审绝对路径、祖先/父树重解析点，不放宽guard。每次使用独占`R=docs/testing/qa-2026-11-06/runtime/<runId>`，`HOME=USERPROFILE=R/.e2e-home-<runId>`；TEMP/TMP/APPDATA/LOCALAPPDATA/包缓存/tsx/Node缓存/网络capture与artifact均绑定R。需核对bootstrap项目根、public codec数据根与Host owner实际一致；不能依赖真实用户目录或系统temp。既有失败run及其reparse节点不删除、不恢复。

任何`/manual-review/` spec会全局启用`ZCODE_E2E_MANUAL_REVIEW=1`并先默认common；这里**显式ReplayFixtures两条**在runner后段覆盖默认，避免common误盖RFC的case-local合同。RFC还逐项核配置路径恰为上述两条、HTTP replay owner为`127.0.0.1`、fixture key及main请求id/status/count；HIST/QLA不发prompt，不消费chat-find。不得capture、不配置真实Key、不扩legacy fixture池、不安装联网依赖；loopback受控请求不等于真实Provider验收。

clipboard仅适配`write`/`writeText`并恢复descriptor，不读用户剪贴板。文件导入仅适配HTML input选择，真实Host事务执行，不验原生picker。HIST独占wx历史，扩33MiB前核exactPath/初始SHA/大小，只append或r+自己创建的文件，不清理已有历史。每case/关键步骤PNG、JSON、NDJSON与失败帧序列只写R/evidence；没有标准encoder时不称已编码视频。根afterSession负责当前run进程退出与既有收尾，suite不调用clearAppData或清除真实配置。

## 待追加Residual10

只有setup独立READY且根确认同SHA后，追加第4spec [qa-residual-local-menus](manual-review/pending/qa-residual-local-menus-20261106.test.ts)，grep追加`RLM-?(?:0[4-9]|1[0-3]):`，总17it。RLM04–07覆盖Command Center操作/任务/文件/All与历史；RLM08–10覆盖原生选择适配的取消/单飞、有效重复只读导入/草稿、损坏archive恢复；RLM11 MCP表单填写取消不启动server，RLM12 commands草稿取消无新文件，RLM13 skill-creator真实draft且不发送。RLM01–03不选，避免再次用readonly导入作Markdown复制前置或重复driver失联链。

RLM10现已加入上面的5spec完整参数；若只运行原4spec17版，应仅移除Short并用以下grep，有限fixture仍是common+chat-find：

```powershell
$qaSupplementGrep = '(?:^| )(?:QLA(?:05|08):|RFC0[12]:|RMC03:|HIST0[12]:|RLM-?(?:0[4-9]|1[0-3]):)'
# 仅4spec17版本，不含Short。根当前已授权上面的5spec22版本。
```

Residual10 final source SHA为`2eb73bb1cb66625d0d074c71ecfe68649c43d29b0e1c57442c12d8499fa70ab7`；18:40:26UTC [独立static](logs/e2e-preflight-residual-static.json) noEmit0、13真实注册、lint0、公开3rows编码前置通过。精确10标题为RLM-04…RLM-13；[最终合并fullTitle preflight](logs/feature-inventory-local-supplement-preflight.json)已包括这10条实际选择。不能预记UI完成或通过。实际执行后只按逐case动作回填87组矩阵，scope/form入口通过不代表CRUD/远端/运行结果全部通过。

## Short5已独立与合并准入

setup已确认18:45:23UTC以下5项final source SHA`abb2086e369104e2dd2e0a47405966296ea254e9aa8aefd426ae1a1906f39fbe`独立静态READY，已加到顶部5spec22参数。不是已有批次的完成数。SLM07本run已有AstrBot配置1项，真实非空前置，保留SKIP，不清空或更改Bot配置来纳入补测。

| 标题                                                   | 有限范围                                                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `SLM06: 引导侧栏和通用页两个入口进入退出`              | 当前两真实入口打开/退出，不改完成偏好；既有Rocket侧栏不属18section                                       |
| `SLM08: 文件树绝对相对路径复制只写mock剪贴板`          | 当前真实右键路径copy，clipboard仅mock，不读系统剪贴板                                                    |
| `SLM09: 文件加入聊天及另存为取消保留源文件`            | 合成文本添加引用不发送；SaveDialog返回取消，源SHA/tasks不变，不验原生picker                              |
| `SLM13: 安全门禁后的本地Terminal读取echo与办公PTY保留` | root显式SafeTerminal且审查实际shell/profile/module/cwd；仅本树合成文件read与echo，coding→office同PTY保留 |
| `SLM15: 长text真实预览滚动与当前无局部Find边界`        | 合成text预览滚动，当前无file-local Find的负测与快捷键任务Find路由；不伪造文件查找入口                    |

Short5精确grep为`(?:^| )SLM(?:06|08|09|13|15):`。含SLM13才需根runner `-SafeTerminal`，其余目标不据此发任何终端命令。源码变化后需再次核source/实际Mocha fullTitle注册，不仅凭旧标题沿用。

当前SLM source只检查`replay`/pending隔离，不像RFC强制exact fixture列表；选中5项不发prompt，所以可保留common+chat-find。setup修复后需再次核对这一边界、source hash和实际注册，不依赖旧静态结果准入新源。

## 独立归档列表重跑3it

root决定`qa-menu-20261106-archive-list-retry`独立运行，避免把archive第三条fixture加入RFC exact2导致beforeAll拒绝。源为[canonical archive-management](../../../packages/desktop/test/e2e/conversation-session/conversation-session-archive-management.test.ts)，SHA256 `151a25ad86037442d7eb5706133eafaa923be97790d79d3a798102c3d5bf04c6`；不修改正式case。

只选下列3个顺序it，排除ARM08/07。旧ARM08在归档页找已移动的开关失败，ARM07随后留在General而后3it缺archive搜索/列表，不能把这种cascade归为产品删除或空列表缺陷。beforeAll已自开Archives；第一条负责组展开/搜索/排序/筛选，第二条恢复删除，第三条批删，不能随意只选最后一条。

| 精确标题                                            | 有限动作                                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `ARM01/05/06：分组折叠、搜索、时间排序和项目选择`   | 本树3项目/5task合成历史，组开关、title搜索/时间排序、项目筛选及语言/主题/窄窗      |
| `ARM02：取消归档、取消删除与确认删除后刷新不复活`   | 对本树合成task执行restore、delete取消/确认与刷新；真实CLI/Host软删除，不碰真实历史 |
| `ARM03：全部删除仅作用于当前筛选，分组更多取消归档` | 本树当前过滤批删及组restore；固定fixture成员，不把标题视作全量归档功能通过         |

有限fixture为common+`conversation-session-archive-management.json`，后者SHA256 `d2295f799f005fb4b1a29d5d939b406f719e1fb110c51842b852617a792817c0`。本suite不prepare Provider、不发prompt，不消费其中main响应；common也不调用。参数严格独立：

```powershell
& .\docs\testing\qa-2026-11-06\run-menu-tests.ps1 -RunId qa-menu-20261106-archive-list-retry -Bootstrap -Specs './test/e2e/conversation-session/conversation-session-archive-management.test.ts' -Grep '(?:^| )ARM(?:01/05/06|02|03)：' -ReplayFixtures './test/e2e/fixtures/upstream/common.json,./test/e2e/fixtures/upstream/conversation-session/conversation-session-archive-management.json'
```

无OpenSidePane/SafeTerminal。scope仅本run HOME及DEFAULT_WORKSPACE，先退出旧Electron/Host/Agent，再由正式`afterElectronProcessExit`写本树两SQLite库的合成project/task/session；未经退出屏障不seed，不新增清理。原canonical冷重启在beforeAll，root reload observer从beforeEach安装，故不能声称此次seed已有独立PID JSON，仍保留正式helper屏障。写入表/固定ID详见[已审安全边界](test-plan-additional-local.md)。

[独立注册preflight](logs/feature-inventory-archive-list-retry-preflight.json)由同一检查脚本`--archive-list-only`输出，修正为Mocha fullTitle匹配后实际exit0/noEmit0/accepted=true，1spec原5it选3/排除2，`归档管理`describe前缀已保留；旧起始`^ARM`按fullTitle选0，不作准入。没有执行hooks、seed/删除或UI，不是新case计数或功能通过。
