# 当前本地剩余动作与轨迹重跑框架

本页只准备root串行执行的下一批，不启动UI/build，不修改产品、canonical或shared guard。当前supplement的实际结果仍按NDJSON写矩阵；本页的候选不计已执行。对应CMD-03/CHAT-05/EXTRA-03与SET-07/SET-08/SET-18/BOT-01/GIT-02。18设置页导航不替代controls、保存、取消、真实owner或文件I/O。

## 已到达与仍缺的9个本地范围

| 组       | 已有本轮实际partial                                              | 未到达动作与最小前置                                                                                                                     |
| -------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| CMD-03   | public readonly正文有marker，未进入有效runtime Find索引          | RFC受控loopback运行时消息/Find计数与导航；不能用readonly投影冒充。RFC当前beforeAll第二请求500须查明并精确补fixture                       |
| CHAT-05  | LC选区引用、child复用/多开/关闭/active路由                       | Terminal focus后选区失败仍待归因；runtime assistant copy由RFC/RMC补，不能读取真实剪贴板                                                  |
| GIT-02   | Review路由、内容/空态与关闭只属GIT-01/PANE；diff动作无针对执行   | 新FLG仅本树git init/add/modify的index基线，无任何commit；真实diff card右键路径/定位/评论草稿。若实现硬依HEAD则保留限制，不造英文commit   |
| BROW-03  | BTC01首关及同tab重复IPC关通过                                    | 原residency需新run通过相同reparse guard，无需新schema；仍不冒称Agent视图/录制全部覆盖                                                    |
| EXTRA-03 | 旧TRJ自动writer前置失败；HIST首次公开编码失败                    | 修正public ID后HIST01→02；wx合成JSONL/有界尾读，仅本树；不恢复writer                                                                     |
| SET-07   | 未执行目标controls；父页进入不是controls证据                     | FLG两it逐项读取原值、真实改值/保存/回显、恢复；queue/guide、autoanswer、reasoning/todo与3toolgroup。无需模型请求；下一轮行为语义另留缺口 |
| SET-08   | V-L引导偏好/损坏恢复合同；supplement SLM06两真实入口进入退出PASS | FLG只补当前数据目录browse取消及原值不变，不迁移数据；不重复SLM06、不点击破坏性确认                                                       |
| SET-18   | QLA07开关保存恢复、enabled空catalog已实际partial，整case pending | FLG本树自己创建saved-memory catalog，scope/refresh/只读内容；无scope的空catalog不能替代。摘要模型/失败恢复另留缺口                       |
| BOT-01   | V-L桥接合同；实际隔离config已有AstrBot1项，旧注册前置SKIP        | FLG现有AstrBot管理/编辑取消、配置不变；不清空已有数组、不注册渠道/绑定或发送。无需新Bot fixture                                          |

外部8组仍独立：NAV-12/SET-15 mac与系统权限；SET-12/SET-13/REM-01/REM-02/REM-03/BOT-02需Source/设备/自建relay/远端/渠道。它们的本地表单或拒绝路径不替代真实环境验收。

## 最终5spec/15it静态准入

状态：**READY（仅静态，UI待root新run）**。2026-11-06T19:41:05.440Z合并准入实际执行noEmit与Mocha describe栈注册，5spec共40个fullTitle中选15、排除25、diagnostics 0、accepted=true。表中只写编号文字，避免正则中的竖线破坏GFM列。[完整静态证据](logs/feature-inventory-local-panel-retry-preflight.json)与[可审参数JSON](logs/feature-inventory-local-panel-retry-parameters.json)均已落盘。

| spec | 精确选取 | 当前状态 |
| --- | --- | --- |
| `qa-historical-trajectory-20261106.test.ts` | HIST01、HIST02，顺序2it | SHA `44857be6e3dbfe5e9c9afc4372dd67ceb43046bc496ce4d94e5d7ab89037ba8c`；[真实codec roundtrip](logs/feature-inventory-historical-codec-31596-1793991760745.json)502bytes/rows与ID一致exit0；[静态](logs/feature-inventory-historical-static.json)noEmit0/15rawparse0/lint0/fullTitle2。viewer待重跑 |
| `qa-runtime-copy-find-20261106.test.ts` | RFC01、RFC02、RMC03，顺序3it | 最终SHA `e5066f5ccf1fe6686ad4c69903fb53d654ebe4c2c00ccdfec9adef7a4461d50e`；strict finite exact3静态READY，第二请求仍需本次runtime真实request summary验证，未知请求继续拒绝 |
| `qa-final-local-gaps-20261106.test.ts` | FLG01–07，7it | 最终SHA `673cb61cee52884b4028003aac2daadfd30198393c0b9a97dd1e16ec4f46b933`；setup拥有[计划](test-plan-final-local-gaps.md)，公开最多51项目分页已root授权 |
| `qa-residual-local-menus-20261106.test.ts` | RLM05、RLM06，2it | 最终SHA `eaebe0c7aaf09d13946e99827db1960a1808ac1dacfbca496dcf71c75100c152`；仅近期任务和合成文件正文；排除BUG008的04/07及已PASS的08–13 |
| `qa-short-local-menus-20261106.test.ts` | 仅SLM15，1it | 最终SHA `5cff511dc4b82153fb71ff9d6e2bac8c229ec18cef4b171bac5bcb39174ad4af`；只修preview DOM owner误读，实际owner为@pierre/diffs open shadowRoot，不称Monaco |

最终5spec按完整fullTitle与各source实际数量核验为RFC3/HIST2/RLM2/FLG7/SLM1。组合grep：

```text
(?:^| )(?:HIST0[12]:|RFC0[12]:|RMC03:|FLG0[1-7]:|RLM-0[56]:|SLM15:)
```

禁止只filter it.title或起始编号锚造成0选。静态证据保留旧编号锚在it.title上选15、在真实fullTitle上选0的对照；当前修正表达式真实选15。该历史静态准入误差属于QA，不计产品/UI失败。HIST02保留HIST01，RFC三条保留runtime before；grep仍执行suite hooks。RLM05/06仍运行公开import before，不将其它旧结果重复计为新执行。

spec从`packages/desktop`解析为`../../docs/testing/qa-2026-11-06/manual-review/pending/<name>`。root新run `qa-menu-20261106-local-supplement-retry`，`-Bootstrap -SafeGit`、无OpenSidePane；没有Terminal输入时不加SafeTerminal。自有[静态脚本](logs/feature-inventory-local-supplement-preflight.cjs)已实际执行`--panel-retry --final-local-count=7 --short-preview-reviewed --title-fixture=docs/testing/qa-2026-11-06/fixtures/qa-runtime-copy-find-title.json`并通过。源已冻结，root独占串行执行以下命令：

```powershell
pwsh -NoProfile -File docs/testing/qa-2026-11-06/run-menu-tests.ps1 `
  -RunId 'qa-menu-20261106-local-supplement-retry' `
  -Specs '../../docs/testing/qa-2026-11-06/manual-review/pending/qa-runtime-copy-find-20261106.test.ts,../../docs/testing/qa-2026-11-06/manual-review/pending/qa-historical-trajectory-20261106.test.ts,../../docs/testing/qa-2026-11-06/manual-review/pending/qa-residual-local-menus-20261106.test.ts,../../docs/testing/qa-2026-11-06/manual-review/pending/qa-final-local-gaps-20261106.test.ts,../../docs/testing/qa-2026-11-06/manual-review/pending/qa-short-local-menus-20261106.test.ts' `
  -Grep '(?:^| )(?:HIST0[12]:|RFC0[12]:|RMC03:|FLG0[1-7]:|RLM-0[56]:|SLM15:)' `
  -ReplayFixtures 'test/e2e/fixtures/upstream/common.json,test/e2e/fixtures/upstream/conversation-session/conversation-session-chat-find-refocus.json,../../docs/testing/qa-2026-11-06/fixtures/qa-runtime-copy-find-title.json' `
  -Bootstrap -SafeGit
```

## 有限fixture与I/O准入

现有common SHA `60f4898eb393afc84f86d9d492af910928658a954b1a777d7d5d5cb537033210`，chatfind SHA `923ba7e0bd67592b79ee3b5c2eca589f81ba6fa578d6c3598ab9cd01b417e50b`。新增唯一titleJSON绝对路径`C:\vibecoding\zcodium\docs\testing\qa-2026-11-06\fixtures\qa-runtime-copy-find-title.json`，SHA `742c1eb7c965f428eb95709ec7ec8e3619bc2dc37b2be5b00ea6390c62c75631`，fixture ID `qa-runtime-copy-find-setup-title`，kind title。[RFC title专属静态](logs/e2e-preflight-runtime-copy-find-title-static.json)与合并静态均READY。上一run第二loopback请求500的requestJson未保留，不能从新fixture反证原始请求已确定为title；本次需真实request summary核main/title各一次、200/loopback/exact fixtureId，未知继续拒绝。不能泛化匹配/扩legacy池，不加入archive-management或QAR fixture；ReplayFixtures精确三条显式覆盖pending默认common-only，不把静态或runtime首响应当完整前置通过。

所有写入只在新独占`runtime/<runId>`；HOME/USERPROFILE/data/cache/temp/截图及Git fixture均本树，审祖先/子项重解析点和子进程环境。HIST只wx自己历史、exactPath/SHA后稀疏尾读；FLG memory只自己catalog、修改配置读取原值恢复；Git禁止global/system hooks、模板与签名agent外部继承，init/add/modify无commit/push/外连；若无法证明边界则排除该场景。clipboard仅mock write/writeText恢复，不读真实clipboard；原生fileinput/Dialog仅取消或选择适配，不验OS picker。

FLG07另补SET-25实际controls：最多51个本run独占空虚拟项目，串行公开`saveProject({hostId:'local',name:ownedName,roots:[]})`；返回ID/hostId核验，owned prefix搜索限定51行，真实50→showmore→51、all/unused、三sort与选择恢复。项目刚建处于7天宽限，unused当刻空态，不改createdAt/DB/store或remove/restore/purge。ProjectManagement复用窗口目录owner，断言按自己的ID+hostId，不扩到其它本地或远端行。

冻结helper：`qa-menu-dom.ts` SHA `dba3eca2867cccac260b285dd7e82463ce021df7d879c32dc692852d7b74c493`；`qa-preview-dom.ts` SHA `3646eaec8b75953d7944c864fde82d65770bef502b3cb049a1e366183a99d01d`；`qa-local-rpc-probe.ts` SHA `d75cfa0bd781b866ffd3d19ae3152995c1b724a7f6944817df2257dc7a53416a`。setup [最终领域静态](logs/e2e-preflight-final-local-gaps-static.json)于19:38:25实际noEmit0/lint0、35fullTitles中选10、62callback闭包0与8rawJS parse0；合并准入另核最终5spec/15与三fixture SHA。它们只调用注册stub、TypeScript与解析器，未执行UI/hooks/Host/Provider或测试任务/history写入。静态READY不计UI通过。root串行后按NDJSON/summary/PNG/状态JSON回填87组，既有失败源与原始日志保留；QAR/residency/GRP实际结果仍按独立run证据。
