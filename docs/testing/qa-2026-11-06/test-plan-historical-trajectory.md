# 历史只读轨迹专项计划

对应EXTRA-03与TSK-03，补当前fork保留的历史viewer；不恢复自动recorder，不改产品/原canonical。TRJ本轮失败已归因于旧自动writer前置，见[归因](logs/feature-inventory-local-canonical-attribution.md)。root已授权实现[外置pending spec](manual-review/pending/qa-historical-trajectory-20261106.test.ts)。旧静态准入之后的supplement实际HIST01编码前置失败、HIST02依赖失败，尚未打开viewer；后续最小QA修正与重跑范围见本页末节，不能沿用旧READY当作编码或UI通过。

## 前置与安全数据

复用本轮外置suite已有的公开`.zcodium`导入路线，不直接改store或创建真实模型请求。使用`prepareV4ConversationE2E({skipProvider:true})`；仅适配HTML文件input选择（不验原生picker），让真实Host导入事务建立task，等待公开合成正文与实际sessionId，随后主动点击实际task item并核对pane sessionId。不得import原TRJ spec或RLM test module，因为会注册原it/执行module-level前置；仅复用公开codec与独立QA helper。

本次实现取最小3行header/user/assistant合成archive；内容不需要longtext，长正文只在自己创建的历史JSONL中。通过公开package export解析codec、encode后真实UI导入，等待只读正文及非draft真实sessionId，再点击实际task item确认。没有数据库写入或store写入；没有注册旧测试。codec公开getDataBaseDir必须等于本run HOME，HOME/USERPROFILE/默认workspace亦显式核对。

TaskListItem.tsx:944总是提供onViewModelTrajectory，TaskActionMenuContent.tsx:244–254显示此项；无需Provider或首次prompt。UI通过useModelTrajectory→ZCodeTaskService.getModelTrajectory→adapter:2910→readModelTrajectory只读历史文件，按当前taskId匹配；不要求文件来自当次模型请求。

实际run目录由root生成。`H=docs/testing/qa-2026-11-06/runtime/<runId>/.e2e-home-<runId>`，合成文件仅`H/.zcodium/cli/debug/model-io-<safeTaskId>.jsonl`；先核HOME/USERPROFILE/getDataBaseDir两root及路径祖先/子项无reparse/redirect，拒绝身份不明或既有同名文件。`safeTaskId=taskId.replace(/[^a-zA-Z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80)`，空值按reader规则no-session但本套件实际taskId必须非空。文件使用独占wx创建，后续append/r+只用自己刚创建的已审查路径。不能覆盖已有model-io或遍历真实历史；afterSession按本run退出屏障收尾，不新增全目录删除。不要为了unreadable candidate创建目录冒充文件，此额外错误分支可后续独立测。

最小有效JSONL记录shape，所有字符串均合成：

```json
{
  "type": "model_io",
  "sessionId": "<实际导入taskId>",
  "requestId": "qa-hist-000",
  "querySource": "main_turn",
  "attempt": 1,
  "startedAt": "2026-11-06T00:00:00.000Z",
  "completedAt": "2026-11-06T00:00:00.250Z",
  "durationMs": 250,
  "model": {
    "modelId": "qa-historical-model",
    "providerId": "qa-historical-provider"
  },
  "request": {
    "messages": [
      { "role": "system", "content": "QA_HIST_SYSTEM\nsecond line" },
      { "role": "user", "content": "QA_HIST_USER" },
      {
        "role": "tool",
        "content": "QA_HIST_TOOL_RESULT",
        "toolCallId": "qa-hist-call",
        "toolName": "qa_synthetic_tool"
      }
    ],
    "toolNames": ["qa_synthetic_tool"]
  },
  "response": {
    "reasoningText": "QA_HIST_REASONING",
    "text": "QA_HIST_ASSISTANT",
    "finishReason": "tool-calls",
    "usage": { "inputTokens": 10, "outputTokens": 2 },
    "toolCalls": [
      {
        "toolCallId": "qa-hist-call",
        "toolName": "qa_synthetic_tool",
        "input": { "value": "QA_HIST_INPUT" }
      }
    ]
  }
}
```

reader要求`type===model_io && sessionId===taskId`；shape不是公开写入API。仅显式合成历史文件由QA写入，Host仍是真实读取/投影。80条生成规则可参考原canonical `createRecord`319–418，包括full→delta、tool-result isError、finishReason和reasoning；原helper私有，不跨包import实现，不自动copy原assertion全部。若选80条，requestId唯一，两个明确SEARCH marker放索引1/42，唯一长正文marker放55；另一个foreign sessionId记录可验证精确过滤。

## 两个accepted场景

| ID     | 动作与实际验收                                                                                                                                                                                                                                                                                         | 限制                                                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HIST01 | 用当前task右键菜单精确`查看调用轨迹`/`View model trajectory`打开；真实Host读取合成JSONL；六role/system-user-reasoning-assistant-tool-call-tool-result、合成模型名/耗时/finishReason可见；默认展开→整行收起/展开，copy仅展开态出现并通过mock记录完整换行；全部收起与自定义reasoning/tool-result两类展开 | clipboard只mock writeText并保留descriptor恢复，不读/clear/write真实剪贴板；不宣称模型自动录制、工具执行或真实Provider结果                                      |
| HIST02 | 同一fixture80条虚拟列表：挂载数少于80，索引42override跨卸载保留；search两个match用Enter/Shift+Enter更新1/2↔2/2，无匹配0/0、Escape清highlight；索引55虚拟窗外折叠长正文命中自动展开；最后本树独占文件稀疏扩到33MiB、append唯一recent完整record，刷新后recent可见且truncated提示为1                      | HIST02依赖HIST01创建task/文件/打开viewer，必须保留顺序；33MiB仅本树稀疏合成历史，reader最多32MiB，不验真实用户大历史或多host。窄760px几何可单列，避免scope膨胀 |

初始若80条复杂delta投影失败，应保留HIST01前已完成的断言；不把整个viewer判未执行，也不改writer。可先只保留少量有效history完成HIST01，HIST02另批补虚拟/尾读。

## 当前locator与可复用原后半段

- task必须找实际taskbutton/data-task-id，右键其真实可见节点；避免原helper仅按任意testid endsWith(taskId)误点group。菜单role=menuitem、精确当前中英文标签。
- viewer根`[data-trajectory-timeline=""]`、虚拟行`[data-trajectory-virtual-row=""]`、调用`[data-trajectory-call=""]`。
- role行`[data-trajectory-expandable-role="system"]`；触发`[data-trajectory-message-trigger=""]`、正文`[data-trajectory-message-expanded=""][data-state="open"]`、copy`[data-trajectory-message-copy=""]`、长文`[data-trajectory-overflow-toggle=""]`。
- 全部开关`[data-trajectory-toggle-all=""]`，自定义`[data-trajectory-custom-expansion=""]`、kind`[data-trajectory-expansion-kind="reasoning"]`等。
- search触发`[data-trajectory-search-trigger=""]`；bar`[data-trajectory-search-bar=""]`下input，match counter和highlight以当前DOM字段确认，不只看标题；refresh精确可见aria-label刷新/Refresh。
- 原canonical531–645提供viewer等待/复制/search，646–675提供33MiB tail，676–789提供只读snapshot；拷贝到独立QA helper时将页面adapter改rawJS防tsx keepNames闭包，普通真实WDIO click/key保留，不能import原spec或为绿改timeout。

根runner有限replay显式common即可（skipProvider/noPrompt）；common含合成Read响应但本套件不请求。root统一串行运行，执行前重新审查spec/helper、有限JSON、子进程环境、reparse及唯一run数据owner。PNG/状态JSON/NDJSON、原错误与录屏仅写R/evidence；静态READY与候选不计UI通过。外部远端history、设备或真实模型内容一律不作为本计划数据。

## 实际实现与静态准入

两个顺序标题为`HIST01: public imported synthetic history renders six roles, collapse, expansion and captured copy`及`HIST02: historical virtual matches navigate, retain expansion and bounded tail refresh`。执行grep为`(?:^| )HIST0[12]:`：Mocha匹配describe栈与it的fullTitle，旧`^HIST`仅按it.title的静态过滤不能作为准入。HIST02仅在HIST01全部完成并且fixture存在后运行，不自动修复前置。额外foreign session合成记录只用于reader过滤；本轮未纳入复杂full→delta/error payload或760px几何，仍留后续。80行历史首条含完整六role，复制捕获完整system换行；HIST02覆盖用户override跨虚拟卸载及两命中/无命中/唯一长正文/刷新尾读。扩到33MiB前以独占path和初始SHA双核拥有权，拒绝大小超过1MiB或内容改变的文件；不删除清理已有历史。

每case/关键步骤独占PNG+状态JSON，失败保留timestamped PNG sequence；环境没有标准视频编码器时明确只有帧序列，不伪称录屏已编码。无模型请求前后count必须不变，clipboard只拦writeText且after恢复，fileinput adapter只拦`.zcodium`选择并恢复；不读系统clipboard，不执行tool metadata。

[静态preflight](logs/feature-inventory-historical-static.json)已实际exit0：外置QA全noEmit无诊断、精确2个it真实注册、15个rawJS脚本parse无错误、0个远端TS闭包/0个keepNames错误、target+现有DOM helper lint0warnings0errors；实际module import不调用browser/hooks、不生成task/history、不build。源SHA见JSON。后续可与RFC两spec合并由root串行，有限common+chatfind JSON；RFC需匹配自己的fixture，本套件不发prompt也不消费chatfind。UI结果仍pending，不把static准入当功能通过。

## 首次执行的QA前置失败与最小修正

supplement实际HIST01在`2026-11-06T18:56:20.797Z`失败于`encodeConversationArchive`，`validateArchiveManifest:82`拒绝`invalid_archive`；HIST02在18:56:37.612Z因HIST01未成功而退出。两个真实FAIL均未抵达viewer、80条历史或33MiB尾读，不登记产品history bug。旧源SHA为`aa474c825ed0ae27c0af0e4b168aaba193282185a7dcdd7aad4c01c156335c1d`，见[实际NDJSON](runtime/qa-menu-20261106-local-supplement/evidence/test-results.ndjson)。worker0-2在18:56:40.126Z完成DELETE/FAILED收尾，后续worker0-3已启动；不改运行中的已加载QA源。

原因是合成archive直接使用`hist-turn`/`hist-product-turn`/`hist-header`等ID。codec会重新构造公开投影，映射到`share-turn-1`/`share-product-turn-1`/`share-entity-N`；rows哈希不一致按当前fail-closed合同拒绝。类型可通过不等于公开ID白名单成立。旧静态检查只noEmit、注册、rawJS解析和lint，未实际执行encode，因此遗漏真实manifest约束，这是本轮QA准入欠账。

修正仅将三个row的ID与selectedProductTurnIds改成公开ID，并在写文件/点击UI前用同一个公开codec执行encode→decode，断言三row与选择ID无损、artifact为空。不改schema/validator、writer、产品UI或历史reader。首次独立[实际codec probe](logs/feature-inventory-historical-codec-12576-1793991684603.json)exit0：读取旧源真实input，原input确实拒绝`invalid_archive`；只改公开ID的input编码502bytes、解码rows/选择ID相等。它没有UI/Host/模型/历史写入。probe首次误扫整个runtime父树30秒超时发生于任何mkdir/编码之前；改为新独占static目标及完整祖先/该目标子项审核，不改变共享guard或扫描既有运行目录。

修正后再次执行真实当前source input的codec roundtrip及原noEmit/lint/rawJS/完整Mocha fullTitle注册，记录新源SHA。下一独立或合并补测必须保留HIST01→HIST02两项顺序；执行grep`(?:^| )HIST0[12]:`，Bootstrap无OpenSidePane/noPrompt，有限common+chatfind仅用于可能合并的RFC，不能加入archive第三fixture。后续viewer结果继续pending，只有实际NDJSON及步骤证据用于覆盖矩阵。

## 第二次执行与累计消息合同修正（先计划，源待整批退出）

local-supplement-retry实际HIST01于2026-11-06T19:53:35.569Z通过：公开导入和真实Host历史读取、六角色、完整system复制、展开/收起、全部收起/自定义reasoning与tool-result均抵达。HIST02于19:54:08.313Z失败在`expandedOverrideSurvives`的首个两结果计数等待，第473行`second result did not mount`。实际[006-HIST02 JSON](runtime/qa-menu-20261106-local-supplement-retry/evidence/qa-historical-trajectory-0-1-13508-1793994788354/006-HIST02.json)为counter1/1、activeMatches1；不能按该错误文案认虚拟定位产品Bug。override卸载重挂、后续Enter/Shift+Enter、无命中、55长正文和33MiB尾读均未抵达。

当前`ModelTrajectoryTimeline.tsx`对main/subagent完整累计request.messages作增量投影：首条全量，后续按前条消息数截取；同长度时无新input。QA `record(index)`给每条独立1个user，0例外含3条；1的长度下降而显示marker1，2–79持续长度1等于前条，42的第二marker被当前规则省略。合成80记录与两个raw marker不代表UI应索引两个独立单条input。[独立当前源码/捕获SHA重构probe](logs/feature-inventory-historical-message-contract.json)抽取实际4个纯函数验证：原合成主请求投影marker[1]，改为完整累计messages后投影[1,42]。原历史文件在随后worker reset后已不存在，首次只读尝试ENOENT，不恢复或追查历史；probe使用冻结source的真实record函数与seed已记taskId重构，必须SHA与seed捕获的`6025502d…`完全一致，明确originalFileRead=false，不冒称读到原文件。它不调用UI/Host/Provider或写历史。

root已允许整批退出后仅修改本人owned HIST合成记录：每个主请求使用基础system/user0/tool与用户1…当前index的累计完整messages，不改requestId/80条数/双marker1与42/长正文55/foreign记录、产品delta、assertion或timeout。完整HIST01→02顺序、虚拟override/两命中/无命中/长正文/33MiB尾读验收保留。修正后真实执行source generator通过当前纯投影函数，另跑公开codec roundtrip、noEmit/lint/rawJS闭包/实际fullTitle2，给新SHA与root可审执行参数；当前运行source冻结不修改，静态或拟修正不作为后段UI通过。

## 第三次执行的首条虚拟窗口前置修正（计划先行）

local-final-targeted已于2026-11-06T20:15:28.484Z完整结束，exit1、6actual=3PASS/3FAIL；HIST01于20:12:26.928Z失败在六角色断言，HIST02只因HIST01未成功而失败。旧run HIST01的六角色/copy/折叠PASS保留，不把最新FAIL改写成未曾通过。当前累计messages夹具没有丢角色：[只读纯投影与当前现场证据](logs/feature-inventory-historical-initial-viewport.json)验证record0仍含system/user/tool-result/reasoning/assistant/tool-call六角色，marker仍投影[1,42]。失败JSON的8个挂载call只包含record1–8的32个展开角色，PNG可见顶部call05；首条独有的system/tool-result不在挂载窗口。JSON未采scrollTop或原始indices，初始滚动原因仍未证明。

原QA仅等`expanded>=6`后扫描任意挂载DOM，不能确保第一call可见。root已授权在整批退出后保留累计fixture、全部数量/断言/超时，仅在`openViewer`后对真实timeline父滚动owner执行`scrollTo({top:0})`，等待`data-index=0`的system与tool-result实际挂载/展开，再执行原六角色断言。snapshot新增实际owner scrollTop与虚拟row indices，关键步骤独占PNG/JSON；不改布局、virtualizer或delta。后续双marker、虚拟override/导航、long55与33MiB尾读完整保留，不放宽预期。

修正后重新执行当前生成器/四纯UI函数、公开codec roundtrip、外置QA noEmit/lint/rawJS/fullTitle，记录新SHA与先前冻结774f4c92源。下一批仅RFC01加HIST01/02两spec3it，Bootstrap、无OpenSidePane/SafeTerminal/SafeGit，finite common/chatfind/title三条；RFC最窄assistant-row copy owner由setup独立修正。静态准入仍不代表新UI通过。

## 本轮最终实际结果与剩余验收

最后copy-history-final已于2026-11-06T20:31:06.809Z完整结束、exit1：两spec3actual=2PASS/1FAIL。HIST01于20:30:24.447Z PASS，HIST02于20:30:57.333Z FAIL；源SHA `c1d9a330906001f8ae36d42b1556878d857a16cae30dea7eaffd341990de061b`冻结，不再修改或扩测。真实[首条capture](runtime/qa-menu-20261106-copy-history-final/evidence/qa-historical-trajectory-0-1-29036-1793996997692/003-HIST01-first-call-mounted.json)为scrollTop0/indices0–3/六role；[HIST01完成](runtime/qa-menu-20261106-copy-history-final/evidence/qa-historical-trajectory-0-1-29036-1793996997692/005-HIST01.json)完整system复制1次、折叠/自定义reasoning/tool-result通过，requests0。

HIST02已跨过marker查询/Enter后logical counter2/2，随后Escape，再在`expandedOverrideSurvives:499`等待index42用户行挂载15秒失败。[最终失败JSON/PNG及源码归因](logs/feature-inventory-historical-final-attribution.md)为scrollTop69.3333、indices0–5，搜索关闭、highlight已清，user随HIST01自定义状态收起。QA只等counter，未确认Escape前目标正文/两帧文本定位完成；关闭后目标留在虚拟窗并无已证明合同。归为QA同步/窗口候选，不认product定位或override丢失Bug。

最终验收范围：真实公开导入/Host历史读取/80条与foreign过滤、首条六角色、完整copy、单条/全部/自定义展开，以及logical双marker2/2已达。index42用户手动override、主动卸载重挂、后续Enter/Shift+Enter循环、无命中断言、long55和33MiB尾读未达，仍作为后续缺口；失败末highlight清理状态不替代未执行的独立断言。旧HIST01PASS与前次QA失败证据全部保留。后续只按报告交接，不恢复writer、不删/恢复历史。
