# HIST最终执行归因与验收边界

最后run `qa-menu-20261106-copy-history-final` 已完整结束：summary `2026-11-06T20:31:06.809Z`、exit1，3actual=2PASS/1FAIL。RFC01 PASS20:29:11.538Z；HIST01 PASS20:30:24.447Z；HIST02 FAIL20:30:57.333Z。源持续冻结：HIST SHA256 `c1d9a330906001f8ae36d42b1556878d857a16cae30dea7eaffd341990de061b`，未改产品或超时。

实际[NDJSON](../runtime/qa-menu-20261106-copy-history-final/evidence/test-results.ndjson)、[summary](../runtime/qa-menu-20261106-copy-history-final/evidence/summary.json)、[失败JSON](../runtime/qa-menu-20261106-copy-history-final/evidence/qa-historical-trajectory-0-1-29036-1793996997692/007-HIST02.json)与[PNG](../runtime/qa-menu-20261106-copy-history-final/evidence/qa-historical-trajectory-0-1-29036-1793996997692/007-HIST02.png)均已只读核对；没有运行UI或恢复reset后的历史文件。

| 阶段 | 保存的真实状态 | 可认定范围 |
| --- | --- | --- |
| HIST01首条capture20:30:20.889Z | scrollTop0，indices0–3，system/user/tool-result/reasoning/assistant/tool-call六角色，requests0 | 累计夹具保留六role，真实首条滚动/挂载成功 |
| HIST01完成20:30:23.809Z | scrollTop0，indices0–4；仅tool-result/reasoning展开，clips1，requests0 | 完整system复制、单条收起展开、全部收起与自定义role通过 |
| HIST02开始20:30:39.426Z | scrollTop0，indices0–4，用户role为closed，search关闭 | HIST02沿用HIST01自定义展开状态，未重新展开所有user |
| HIST02失败20:30:57.271Z | scrollTop69.33333587646484，indices0–5；counter=null，registered=false，activeMatches0；仅tool-result/reasoning展开 | Escape后目标index42未在当前虚拟窗口；未进行user手动override或虚拟重挂 |

HIST02 errorStack明确停在owned spec `expandedOverrideSurvives:499`：先`search(MARKER)`、Enter、等待counter为2/2，随后Escape，再等待`[data-index="42"] [data-trajectory-expandable-role="user"]`存在。因此前面的**逻辑双marker计数2/2已经通过**；它不是旧第二marker缺失失败。该时刻没有独占中间capture记录index42是否在Escape前已挂载/可见，也未在按Escape前等待其正文高亮/文本级定位完成。

当前源码明确：`ModelTrajectorySearchBar.tsx:46–48` Escape调用onClose；`ModelTrajectoryPane.tsx:130–134`清searchOpen/query/active并清highlight，`312–315`随activeMatch将searchRevealKey置null。`ModelTrajectoryExpandableMessage.tsx:77–87`展开由user命令/override或searchRevealed决定；HIST01自定义将user关闭，Escape去掉临时reveal后user会收起。`ModelTrajectoryTimeline.tsx:40`无搜索时允许virtualizer测高调整滚动，`69–94`文本级定位还有两帧异步与cleanup。

**归属保留为QA同步/虚拟窗口候选，未确认产品Bug。** 逻辑counter更新不能证明DOM定位完成，QA紧接Escape后才查目标且没有重新滚动/定位前置。现有证据无法区分“定位尚未完成即关闭”与“关闭搜索/收起后测高改变窗口”；也不证明产品承诺关闭搜索后index42持续挂载。没有证据证明手动override丢失，不能登记该产品缺陷。

已达：公开导入、真实Host只读历史viewer、80条/foreign过滤、首条六role、完整system copy/折叠/自定义role、marker查询与Enter后logical2/2。**未达**：index42手动user override、主动卸载/重挂与override保持、后续独立1/2↔2/2 Enter/Shift+Enter循环、no-match0/0、Escape highlight清理断言、long55自动展开与33MiB尾读/刷新。失败末state确实highlight已清，但后段该断言未执行，不推广通过。

本轮不再修改QA源或扩测；后续如需复核，应先等待并capture真实index42文本定位完成，明确关闭搜索后的预期窗口/重新定位，再独立验证用户override与尾读。任何新复验仍限本树owned synthetic数据与现有strict guard，不恢复自动writer。
