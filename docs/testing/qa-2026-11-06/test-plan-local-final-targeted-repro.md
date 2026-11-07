# 最后一批针对性QA合同复验

状态：**静态READY，UI由root串行执行；源已冻结**。不启动UI/build、不改产品或主报告。上一15it批已于2026-11-06T20:01:09.916Z完整结束，summary/wrapper exit1，15actual=9PASS/5FAIL/1SKIP，全部worker退出后才修改本轮owned源。下一次仅4spec6it，Bootstrap、无OpenSidePane/SafeTerminal/SafeGit，finite精确common/chatfind/title三条，不混归档fixture。

| 源 | 精确目标 | 修改与保留的既有验收 |
| --- | --- | --- |
| qa-runtime-copy-find-20261106.test.ts（setup） | RFC01 | 仅当前真实turn尾assistant copy owner locator；runtime exact main/title各一次loopback200保留；完整正文、勾选出现/恢复、不读系统clipboard |
| qa-historical-trajectory-20261106.test.ts（feature_inventory） | HIST01、HIST02，順序保留 | 原44857be6源HIST01已真实PASS；HIST02夹具将主请求改成真实累计messages。仍80条/两个marker1和42/long55/foreign过滤；保留角色复制折叠、虚拟override跨卸载、双命中导航/no-match/长正文/33MiB尾读全部断言与超时 |
| qa-residual-local-menus-20261106.test.ts（feature_inventory，仅RLM05） | RLM-05 | 原eaebe0c7源已完成首recent/query/唯一ID结果ArrowDown/Up/Enter/打开alpha、anchor与重查；仅最后清空改真实input click/Ctrl+A/Backspace，截取搜索→recent的input/heading/data-value。保留原15s recent等待及完整唯一任务身份/重开断言 |
| qa-final-local-gaps-20261106.test.ts（setup） | FLG04、FLG05 | 仅此前Bot总入口/记忆范围locator QA修正；已有无凭据未绑定AstrBot只读名称取消/路径copy，自己两catalog/scope/search/refresh/恢复enabled；不连接/发送/新增真实渠道 |

HIST原因见[当前pure source与捕获SHA probe](logs/feature-inventory-historical-message-contract.json)：原文件已随worker reset不存在，未恢复；冻结generator重构SHA与seed一致，当前投影marker[1]、累计fixture投影[1,42]。RLM05 [失败JSON](runtime/qa-menu-20261106-local-supplement-retry/evidence/qa-residual-local-menus-0-2-32460-1793994895712/003-RLM05.json)input空，但[PNG](runtime/qa-menu-20261106-local-supplement-retry/evidence/qa-residual-local-menus-0-2-32460-1793994895712/003-RLM05.png)仍为Tasks搜索结果、query高亮与workspace标记。当前默认Recent tasks不用高亮/不带workspace标记；`.setValue("")`造成DOM值与React controlled rawQuery的疑似不同步，真实键盘清空是窄QA动作修正，本次不先登记产品最近列表Bug。

精确Mocha fullTitle grep：

```text
(?:^| )(?:RFC01:|HIST0[12]:|RLM-05:|FLG0[45]:)
```

RFC/HIST两个顺序前置保留：RFC01仍执行自己的runtime before，HIST02要求HIST01成功；RLM05仍执行公开导入before、自己的独占anchor，不改公共选中规则。未选FLG06，不继承SafeGit或尝试Git/Terminal；不重跑已PASS的九个动作。新的源码与helper SHA、真实describe栈/fullTitle注册6/排除数、实际source codec/generator noEmit/lint/rawJS闭包静态完成后，给root唯一新run参数；READY不当UI结果。

## 最终静态与执行参数

[合并静态](logs/feature-inventory-local-final-targeted-preflight.json)于2026-11-06T20:06:18.923Z实际完成：accepted=true、QA noEmit diagnostics0、4spec共25个真实Mocha fullTitle选6排19、55个execute callback keepName闭包0、23段rawJS syntax0、7文件lint0warnings/errors。它只执行注册stub与静态解析，未执行UI/hooks/Host/Provider/build/task/history。sourceSelectedCounts分别1/2/1/2。

| 源 | 最终SHA256 | 上一run原SHA256 |
| --- | --- | --- |
| RFC | `7061de5b67f14420edacec94a2a0f18ac01a991b8265819eff0c1bbed11b7a1b` | `e5066f5ccf1fe6686ad4c69903fb53d654ebe4c2c00ccdfec9adef7a4461d50e` |
| HIST | `774f4c92c6f915b465c95d66cde65a5653bb9f4a6f6fc27bbec955f32ad2fd29` | `44857be6e3dbfe5e9c9afc4372dd67ceb43046bc496ce4d94e5d7ab89037ba8c` |
| RLM | `acf14bbe6cd5e59618603798371bf5ae70c25a2badbaf734ff36777a5df4ff81` | `eaebe0c7aaf09d13946e99827db1960a1808ac1dacfbca496dcf71c75100c152`（完整原SHA见上一批preflight，表内历史值以其为准） |
| FLG | `edac99520b453037354c81f065dd1987a6dab2a55c8e1660c99bb25455d1f5bb` | `673cb61cee52884b4028003aac2daadfd30198393c0b9a97dd1e16ec4f46b933` |

HIST另实际执行[当前生成器与累计投影](logs/feature-inventory-historical-cumulative-current.json)：80条当前主请求经现4个pure UI函数投影marker[1,42]，初始JSONL小于1MiB，不写历史。原文件缺失与旧捕获SHA重构归因仍留在旧probe，不冒称当前已读原现场文件。[当前公开codec](logs/feature-inventory-historical-codec-14504-1793995563778.json)502bytes encode/decode、三rows与selectedIDs一致、artifact空，exit0。setup的RFC/FLG独立静态见[copy owner](logs/e2e-preflight-runtime-copy-owner-static.json)、[menu owner](logs/e2e-preflight-final-menu-owner-static.json)，源与合并记录一致。

有限三fixture hash保持common `60f4898eb393afc84f86d9d492af910928658a954b1a777d7d5d5cb537033210`、chatfind `923ba7e0bd67592b79ee3b5c2eca589f81ba6fa578d6c3598ab9cd01b417e50b`、title `742c1eb7c965f428eb95709ec7ec8e3619bc2dc37b2be5b00ea6390c62c75631`；参数只采用这些文件。shared QA helper仍为上一reviewed冻结SHA，详见合并记录。

[可审参数JSON](logs/feature-inventory-local-final-targeted-parameters.json)供root唯一执行，RunId必须新建；无任何其他开关：

```powershell
pwsh -NoProfile -File docs/testing/qa-2026-11-06/run-menu-tests.ps1 `
  -RunId 'qa-menu-20261106-local-final-targeted' `
  -Specs '../../docs/testing/qa-2026-11-06/manual-review/pending/qa-runtime-copy-find-20261106.test.ts,../../docs/testing/qa-2026-11-06/manual-review/pending/qa-historical-trajectory-20261106.test.ts,../../docs/testing/qa-2026-11-06/manual-review/pending/qa-residual-local-menus-20261106.test.ts,../../docs/testing/qa-2026-11-06/manual-review/pending/qa-final-local-gaps-20261106.test.ts' `
  -Grep '(?:^| )(?:RFC01:|HIST0[12]:|RLM-05:|FLG0[45]:)' `
  -ReplayFixtures 'test/e2e/fixtures/upstream/common.json,test/e2e/fixtures/upstream/conversation-session/conversation-session-chat-find-refocus.json,../../docs/testing/qa-2026-11-06/fixtures/qa-runtime-copy-find-title.json' `
  -Bootstrap
```

静态不增加产品确定性133项或UI通过数；后续只按新run NDJSON/summary/JSON/PNG更新组内partial及失败归因，不将6计划条数当已执行。
