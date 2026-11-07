# Runtime assistant复制与会话查找补测计划

状态：RFC01、RFC02、RMC03均已在独立实际运行中PASS。RFC01最后仅按唯一marker助手rowId关联同轮尾copy，通过真实hover/click、完整正文和成功勾选恢复断言；前两轮QA owner查询失败与旧证据继续保留。本专项补足 SLM05/14 只读归档无法建立的运行历史前置，以及同一正式runtime历史的任务菜单Markdown复制。不修改产品或原canonical，不执行原chat-find的Git初始化/提交/diff/clearAppData；测试源与静态脚本冻结，不再追加运行。

最终run `qa-menu-20261106-copy-history-final` 于2026-11-06 20:31:06.809 UTC完整结束，[summary](runtime/qa-menu-20261106-copy-history-final/evidence/summary.json) exit1、3actual=2PASS/1FAIL；[实际NDJSON](runtime/qa-menu-20261106-copy-history-final/evidence/test-results.ndjson)记录RFC01于20:29:11.538 UTC PASS（3197ms）、HIST01 PASS、HIST02在后续虚拟列表步骤FAIL。RFC01的[候选JSON](runtime/qa-menu-20261106-copy-history-final/evidence/qa-runtime-copy-find-0-0-30436-1793996933538/003-RFC01-copy-candidates.json)实际记录同turn的user `v4-copy-2`（隐藏）与轮尾 `v4-copy-3`（可见）；唯一assistantIds=[3]、markerRowId=3、samePane/sameTurn成立。此数量只属于本次现场，不能回写旧run缺失的候选采集。

真实hover后点击精确助手按钮，[复制JSON](runtime/qa-menu-20261106-copy-history-final/evidence/qa-runtime-copy-find-0-0-30436-1793996933538/005-RFC01-copied-check.json)仅1次mock writeText、3930字符，SHA256 `f79b3698c2a748a78ccb2c9623a4685ec1ee66967d262cbf1656cc6dd042d5d6`精确等于已有fixture全文；[Check PNG](runtime/qa-menu-20261106-copy-history-final/evidence/qa-runtime-copy-find-0-0-30436-1793996933538/005-RFC01-copied-check.png)与[恢复Copy PNG](runtime/qa-menu-20261106-copy-history-final/evidence/qa-runtime-copy-find-0-0-30436-1793996933538/006-RFC01.png)确认成功反馈出现后恢复。最终[passed JSON](runtime/qa-menu-20261106-copy-history-final/evidence/qa-runtime-copy-find-0-0-30436-1793996933538/006-RFC01.json)仍main/title各1、loopback complete200、精确fixtureId；原case断言action请求零增量、相同runtime task均通过。没有调用系统clipboard，也没有真实Provider/Git请求。最后冻结source SHA256仍为 `94f2788e1be06dc116e1bd361083ac49ecfd77eaa1569045710203a9e9d7b5d2`。

RFC02与RMC03在此前 `qa-menu-20261106-local-supplement-retry` 已分别于19:51:54.275、19:52:18.976 UTC实际PASS，最后一轮未重复运行，不把本次仅RFC01通过扩写为三项同run通过。HIST02剩余步骤按[历史计划](test-plan-historical-trajectory.md)作为QA欠账交接，不影响本专项三项实际结果，也不增加确认产品Bug数量。

HIST最终源码链与剩余动作的完整边界见[只读归因](logs/feature-inventory-historical-final-attribution.md)：最后已达logical2/2，后续index42 override/重挂、独立导航、no-match、long55及33MiB未抵达。它与本专项的实际复制/查找通过分别交接，未确认新的产品Bug。

`qa-menu-20261106-local-final-targeted` 于20:15:28.484 UTC完整退出，6actual=3PASS/3FAIL；RLM05、FLG04/05已实际PASS，不再复跑。RFC01于20:11:15.471 UTC失败 `RFC same-turn copy action is not unique`，[003 JSON](runtime/qa-menu-20261106-local-final-targeted/evidence/qa-runtime-copy-find-0-0-32396-1793995858149/003-RFC01.json)中main/title各1、complete200、clipboardAttempts=[]，[PNG](runtime/qa-menu-20261106-local-final-targeted/evidence/qa-runtime-copy-find-0-0-32396-1793995858149/003-RFC01.png)显示真实轮尾copy。当前group/assistant-turn通过ConversationTurnFlow也包含用户RowShell，其CopyRowAction也用v4-copy前缀；不能要求整轮全部copy总数1。该失败未保存候选数量，不能补称实际测得2或0；MessageAction经默认Button输出真实button，不按非button标签解释。

整批退出后本次最小修订：同PANE唯一MARKER→同turn的唯一group/assistant-row，核本pure-text fixture只有该一条助手row，取其数字data-row-id；只在同assistant-turn查询精确 `button[data-testid="v4-copy-<assistantRowId>"]`，再核其最近turn仍为原section，不选择usercopy或全局首个copy。先独占capture同turn全部候选的tid、nearest row ID/kind、visibility/disabled、assistantIds及markerRowId（不保存正文），再做唯一性断言与真实hover/click。保留3930字符expectedBody精确相等、恰一次clipboard、Check出现/消失、main/title各1和action零增量，不修改timeout或生产渲染。静态新模式 `--assistant-copy-retry` 用独立runtime/JSON，不覆盖前次owner-static证据。根最后只运行RFC01与HIST01/02两spec三项，不复跑已通过项。

2026-11-06 20:19:59 UTC [助手行精确copy静态证据](logs/e2e-preflight-runtime-assistant-copy-static.json)真实exit0：全外置QA noEmit0、两文件lint0警告/0错误、16callback closure0、4raw JS syntax0；三项真实fullTitle注册后精确仅RFC01一项，title七项正反matcher全部true。修后source SHA256 `94f2788e1be06dc116e1bd361083ac49ecfd77eaa1569045710203a9e9d7b5d2`，修前 `7061de5b67f14420edacec94a2a0f18ac01a991b8265819eff0c1bbed11b7a1b`。canonicalchecker仍exit0并保留原两条marker warning。该次只验证QA类型/注册/序列化，真实copy/勾选反馈仍待最终新run，不预记PASS。

2026-11-06 20:05:51 UTC [owner retry 静态证据](logs/e2e-preflight-runtime-copy-owner-static.json)：真实进程 exit0，全外置 QA noEmit0；两文件 targeted lint0警告/0错误，16个 callback 无 keepNames 闭包、4份 raw JavaScript syntax0，实际三项 fullTitle 注册后精确只选 RFC01 一项。新 source SHA256 `7061de5b67f14420edacec94a2a0f18ac01a991b8265819eff0c1bbed11b7a1b`，修前 `e5066f5ccf1fe6686ad4c69903fb53d654ebe4c2c00ccdfec9adef7a4461d50e`。title matcher 七项正反条件全部成立、该 title checker 无警告/错误；原 canonical checker exit0 仍含两条既有 marker warning，不记为无警告。整批20:01:09.916退出后才修改owner查询，不改变expected正文、两个请求门禁、timeout、成功勾选反馈或其它case。

2026-11-06 19:51 UTC `qa-menu-20261106-local-supplement-retry` 的独占 [runtime ready](runtime/qa-menu-20261106-local-supplement-retry/evidence/qa-runtime-copy-find-0-0-9812-1793994678142/001-runtime-fixture-ready.json)已实际确认main/title各1、loopback complete/200/exact fixtureId；新的title匹配不是旧500的反向归因。RFC01在19:51:35.505 UTC body第195行失败：QA要求marker所在 `group/assistant-row` 内有copy，但当前正常turn通过 `deferActions` 将动作移到同turn轮尾的兄弟区域。失败 [PNG](runtime/qa-menu-20261106-local-supplement-retry/evidence/qa-runtime-copy-find-0-0-9812-1793994678142/003-RFC01.png)底部已显示copy/赞/踩/fork；[JSON](runtime/qa-menu-20261106-local-supplement-retry/evidence/qa-runtime-copy-find-0-0-9812-1793994678142/003-RFC01.json)clipboardAttempts为空，真实复制未点击，不登记产品缺陷。RFC02在19:51:54.275、RMC03在19:52:18.976实际PASS；复制全文/勾选反馈仍只由RFC01补测。

修订必须等整个当前batch退出后再改spec。只在同一PANE内查找含唯一MARKER的assistant正文row，取得唯一最近 `section[data-turn-id]`，核same PANE及turn ID；copy按钮取该section轮尾实际 `v4-copy-<latestRowId>`，禁止跳到其他turn或全局第一个copy。真实hover其 `group/assistant-turn`（或Tab focus）后等可见，再真实click。保留捕获恰1条完整fixture正文、Check出现→消失、原timeout、main/title各1与无action新增请求的所有断言；不读取截断DOM作为expected，不伪DOM、不恢复退休功能。

当前源码owner：ConversationTurnGroup.tsx:1339/1357为turn section与hover容器，:1450–1467单独渲染轮尾动作；ConversationRowView.tsx:1580在deferActions时不渲染row内动作；:180–201仍使用v4-copy-rowId、writeText与成功1200ms勾选。resolveAssistantCopyText聚合整轮text段与去重计划正文，排除普通工具输出。本例纯text fixture的精确全文expected不变。RFC01修后静态使用 `node logs/e2e-preflight-runtime-copy-find-title-static.cjs --copy-owner-retry`，保存独立新证据，验证all外置noEmit、callback闭包/rawJS syntax、真实fullTitle仅选择RFC01；不会执行hooks/UI。

2026-11-06 18:55 UTC local-supplement 的 beforeAll 已真实首发并显示 assistant marker，但两个请求中一条 `chat-find-refocus-long-body` complete/200、一条 null fixture complete/500；严格门禁正确拒绝，RFC01/02/RMC03 均未执行。原网络 JSON 后续 worker 重置，failure 中两条均 loopback=true，只能确认未命中请求，不能把其类别称已证实 title。根授权根据当前 `title-generation-sidecar.ts` 的 system+normalized SETUP 构造最窄本次合成 title fixture；新 exact 名单仅 common、chat-find、该唯一 title JSON，未知继续拒绝。main 仍恰一条，title 单列 count/fixture/200；每请求角色、已知 marker 布尔、shape/query-kind/status 的只读脱敏摘要写独占证据，不能保存任意内容或凭据。修后再实际确认 title 匹配；若仍出现未命中/500，完整失败。

现有 `conversation-session/manual-review/pending/conversation-session-chat-find-refocus.test.ts` 的会话子链是prepareV4ConversationE2E、真实composer发送 `E2E_CHAT_FIND_REFOCUS_SETUP 请返回查找回归长正文。`、等待assistant marker与正式session完成。它使用现有有限replay `conversation-session-chat-find-refocus.json` 中 `chat-find-refocus-long-body`：fast-text/synthetic、纯正文、唯一 `E2E_CHAT_FIND_REFOCUS_NEEDLE`，没有tools或额外Bash动作。公开归档的readonly header不用作该前置。

| ID | 真实动作 | 验收与证据 |
| --- | --- | --- |
| RFC01 | 真实composer首发完成后唯一marker正文→same PANE/turn section→轮尾实际v4-copy-rowId，hover/focus可见后click | mock navigator.clipboard.writeText捕获唯一正文，精确等于现有fixture响应；Check→Copy恢复。write与writeText均完整拦截；无真实clipboard写/读；记录rowId、turnId、长度/sha、请求fixtureId、DPR、PNG/JSON。 |
| RFC02 | 同一runtime task真实Ctrl+F输入唯一marker，再反复next/previous/Enter/ShiftEnter | 计数1/1；先滚离视口再每次导航让同一命中回到中间范围，保存scroll/rect/中心差/DPR；关闭后重开按当前合同查询为空，重新输入再次定位。范围只有conversation，不切changes/Git。 |
| RMC03 | 同一完成runtime任务的任务菜单 Copy as Markdown，正常复制两次、受控拒绝、恢复重试 | write优先与writeText fallback均mock；write只消费唯一ClipboardItem的text/plain。正文中首发PROMPT与已有fixture全文各恰一次，User/Assistant段落存在；不复制产品formatter作为预期。记录method、attempt/count、长度/SHA与即时成功/失败toast，拒绝时无新增clip且pending释放，恢复后完整正文不变。 |

三项共用一个真实已完成runtime任务，不额外发送prompt。只允许 common、上述已有有限replay main 与本次专用 `qa-runtime-copy-find-title.json` 三份精确路径；准备门禁要求 main/title 各恰一条且 complete/200/loopback/精确 fixtureId，动作前背景已完成。未匹配fixture或重试不能当成功。运行前精确审查三份 JSON 树内真实路径；mode必须replay且实际runtime BaseURL为http127.0.0.1、artifact位于本树，不接受capture/真实key/未知fixture路径。不是对真实Provider质量或网络服务的测试。

menu-reviewed RLM02的公开import-only任务零clip不能直接判复制故障。当前Copy as Markdown只读取agent.conversationRowsRangeV4，不读取readonly header；缺可导出runtime rows时产品映射明确empty toast。但该现场20秒后toast已消失、没有rows响应摘要，所以目前仍是范围/QA前置候选，原FAIL保留。RMC03使用上述真实首发runtime历史覆盖正向和拒绝重试，不凭import-only无正文改产品或放宽预期。

HOME/TEMP/TMP/APPDATA/缓存/数据库/网络与截图等所有用户写入环境继续由根runner隔离到当前工作树。suite复查全部绝对路径的realpath/reparse祖先与窄PS7子树审查，再核对同worker bootstrap项目/根与DB路径；只读本树bootstrap/fixture/network证据，不迁移或清理历史数据。新增UI草稿、Provider配置、会话持久化仅在合成run HOME。after恢复clipboard与overlay，不调用clearAppData、不删除其他task、不重置真实配置。

每case首尾独占PNG/JSON；交互失败保存Electron capturePage帧时间序列。无标准WebM编码器时明确仅PNG序列，不把unencoded文件记视频。beforeAll失败也保存独立合成UI/网络诊断；所有断言需根实际串行运行。

历史owner-retry参数（保留先前计划；最终实际run及状态见本页首段）：

```powershell
& .\docs\testing\qa-2026-11-06\run-menu-tests.ps1 -RunId qa-menu-20261106-runtime-copy-owner-retry -Bootstrap -Specs '../../docs/testing/qa-2026-11-06/manual-review/pending/qa-runtime-copy-find-20261106.test.ts' -Grep '(?:^| )RFC01:' -ReplayFixtures './test/e2e/fixtures/upstream/common.json,./test/e2e/fixtures/upstream/conversation-session/conversation-session-chat-find-refocus.json,../../docs/testing/qa-2026-11-06/fixtures/qa-runtime-copy-find-title.json'
```

不需要OpenSidePane或SafeTerminal（本suite不打开终端）。计划与静态验证不计UI PASS；实际RFC01/02分别补CHAT复制与CMD03覆盖，RMC03补任务Markdown完整复制/拒绝恢复。真实系统clipboard、真实Provider、跨平台和Git/file diff仍不在本专项验收范围。

18:14:16UTC原两项版静态通过（SHA256 `7584892bc6117a3e085f3853e81dc2dc8449039b2fbdd1c5a3bde6326fe6aabd`），未执行UI。18:32:44UTC RMC03三项版 [静态证据](logs/e2e-preflight-runtime-copy-find-static.json)：all外置QA noEmit0、真实tsx注册RFC01/RFC02/RMC03、2file lint0、17callback闭包finding0、3rawJS syntax0，canonical fixture checker0（两marker非matcher警告保留）。新suite SHA256 `9187dfd0a79c389db3a7a9e96af22d7d1024e8a5a22bdf9db43b8bbdb87da9ff`。响应3930字符、唯一marker、pure text，expected SHA256 `f79b3698c2a748a78ccb2c9623a4685ec1ee66967d262cbf1656cc6dd042d5d6`；case fixture `923ba7e0bd67592b79ee3b5c2eca589f81ba6fa578d6c3598ab9cd01b417e50b`、common `60f4898eb393afc84f86d9d492af910928658a954b1a777d7d5d5cb537033210`。零hooks/cases/Host/Provider/clipboard/UI执行。

19:21:20UTC title 精确三份版静态 READY，仍未执行 UI：[独占新证据](logs/e2e-preflight-runtime-copy-find-title-static.json)。suite SHA256 `e5066f5ccf1fe6686ad4c69903fb53d654ebe4c2c00ccdfec9adef7a4461d50e`；专用 title fixture SHA256 `742c1eb7c965f428eb95709ec7ec8e3619bc2dc37b2be5b00ea6390c62c75631`。全外置 QA noEmit0、两文件 lint0、真实 describe 栈三 fullTitle 注册、17 callback finding0、3 rawJS syntax0。从当前 checker 抽取 validateFixtureFile 函数核新增 JSON，零 warning/error；从当前 replay matcher 与 title-sidecar 抽取真实函数构造输入，正向匹配及 main/异prompt/缺指令/错误method/path 六项反例均符合边界。旧 canonical checker 只覆盖原 case 两份 fixture，不宣称该命令直接验证 docs 新 fixture。原 500 类别仍待新 run 的独占 request 摘要确认，不称已证 title。
