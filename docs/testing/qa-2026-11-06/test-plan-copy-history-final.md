# 消息复制与历史首条窗口的最终QA合同复验

最后local-final-targeted已于2026-11-06T20:15:28.484Z完整结束、exit1，6actual=3PASS/3FAIL。RLM05任务查询/真实键盘清空后Recent、FLG04已有Bot名称Escape取消/合成路径复制、FLG05 owned memory scope/search/refresh已通过，均不再重跑。本计划仅两个pending spec、三个顺序目标，root统一串行运行；本作者不运行UI/build、不改产品或主报告。

| 源与目标 | 上次真实失败及本次最小QA修改 | 保留范围 |
| --- | --- | --- |
| qa-runtime-copy-find-20261106.test.ts：RFC01 | whole-turn包含user与assistant两个copy动作；以唯一正文marker对应的assistant rowId关联实际轮尾button，assert前捕获所有candidate testid/kind/visible/assistantIds | 完整正文、受控writeText、勾选出现/恢复、main/title有限loopback200及前后request数量；不读系统clipboard |
| qa-historical-trajectory-20261106.test.ts：HIST01→HIST02 | 首个snapshot只读挂载record1–8，首record0独有system/tool-result已出虚拟窗；真实timeline父owner scrollTo0，等待index0的两role实际挂载/展开，再执行原六角色断言，snapshot新增scrollTop/indices | 当前累计messages、80条、双marker1/42、long55/foreign过滤、完整system复制/折叠/自定义角色、虚拟override跨卸载、双导航/无命中/长正文/33MiB尾读全部原断言和超时 |

HIST仍要求HIST01成功后HIST02执行，不修复或伪造前置。只读[首条窗口归因](logs/feature-inventory-historical-initial-viewport.json)区分逻辑全量六角色和DOM挂载子集，初始scroll原因未证明，不登记产品Bug。上一HIST01真正PASS仍保留；新UI结果只按实际NDJSON回填。

冻结源SHA：RFC `94f2788e1be06dc116e1bd361083ac49ecfd77eaa1569045710203a9e9d7b5d2`；HIST `c1d9a330906001f8ae36d42b1556878d857a16cae30dea7eaffd341990de061b`。前一冻结源分别`7061de5b…`与`774f4c92…`，旧证据保留。HIST计划在修改前已追加本次契约，详见[历史计划](test-plan-historical-trajectory.md)。

新RunId为`qa-menu-20261106-copy-history-final`，仅Bootstrap，无OpenSidePane/SafeTerminal/SafeGit。finite仍精确common/chatfind/title三文件，不混archive，不新增宽松match或忽略500。common只满足noPrompt HIST环境；RFC exact main/title由chatfind/title各自准入。

```text
(?:^| )(?:RFC01:|HIST0[12]:)
```

合并静态已实际exit0/accepted=true：真实describe栈5fullTitles选3排2（RFC1/HIST2）、外置QA noEmit0、22段rawJS含String.raw语法0、17个keepName callback闭包0、target/helper5文件lint0warnings/errors，finite路径/SHA均复核。当前实际纯投影80条仍marker[1,42]；[公开codec --current](logs/feature-inventory-historical-codec-4460-1793996424576.json)exit0、502bytes、rows/selectedIDs相等、artifact空。首次误用旧original-rejection模式的acceptedfalse输出32136保留，该次实际encode/decode也成功，是本轮QA调用模式错误，不是schema失败。

最终合并[静态证据](logs/feature-inventory-copy-history-final-preflight.json)与[参数JSON](logs/feature-inventory-copy-history-final-parameters.json)均已落盘；root按该参数实际运行已完整结束，源持续冻结。静态不计133确定性或UI用例通过数。

```powershell
pwsh -NoProfile -File docs/testing/qa-2026-11-06/run-menu-tests.ps1 `
  -RunId 'qa-menu-20261106-copy-history-final' `
  -Specs '../../docs/testing/qa-2026-11-06/manual-review/pending/qa-runtime-copy-find-20261106.test.ts,../../docs/testing/qa-2026-11-06/manual-review/pending/qa-historical-trajectory-20261106.test.ts' `
  -Grep '(?:^| )(?:RFC01:|HIST0[12]:)' `
  -ReplayFixtures 'test/e2e/fixtures/upstream/common.json,test/e2e/fixtures/upstream/conversation-session/conversation-session-chat-find-refocus.json,../../docs/testing/qa-2026-11-06/fixtures/qa-runtime-copy-find-title.json' `
  -Bootstrap
```

## 最终执行结果

RunId `qa-menu-20261106-copy-history-final`于2026-11-06T20:31:06.809Z完整结束、summary/wrapper exit1，**3actual=2PASS/1FAIL**。RFC01于20:29:11.538Z完整PASS：真实assistant rowId关联轮尾复制、完整合成正文、受控clipboard及勾选出现/恢复、有限main/title请求断言。HIST01于20:30:24.447Z完整PASS：首call真实挂载、六role、完整system复制、折叠与自定义角色。HIST02于20:30:57.333Z FAIL在Escape后等待index42挂载；前面的logical双marker2/2已达，虚拟override/后续导航/no-match/long55/33MiB尾读未达。

实际[NDJSON](runtime/qa-menu-20261106-copy-history-final/evidence/test-results.ndjson)、[summary](runtime/qa-menu-20261106-copy-history-final/evidence/summary.json)、[HIST独立归因](logs/feature-inventory-historical-final-attribution.md)为最终证据。HIST02当前为QA同步/虚拟窗口候选，未确认产品Bug；本轮不再修改源、不扩测，未完成范围交接至覆盖矩阵。
