# menu-reviewed RLM标记未读后的协议超时归因

记录日期2026-11-07（Asia/Shanghai）；原始时刻保留UTC。只读读取既有日志、NDJSON和当前已加载测试源码，没有UI操作、kill、timeout/helper修改或live CPU采样。

`qa-menu-20261106-menu-reviewed` 的RLM worker `0-1`，WebDriver session `97a30b838237de08fc16e9f1a55963c4`在RLM03菜单动作后失去Renderer协议响应。当前证据只确认同session连续超时，原因未确认，不能据此把后续各功能登记为独立产品bug。

## 最后成功动作与第一失败

1. 18:23:35.956 UTC，真实pane snapshot返回导入会话`share-import-b75a81b3-cf03-48d3-962f-7a2ddf089a66`，正文含两个合成marker及Imported conversation；此前RLM01路径/ID复制通过，RLM02第一次Markdown复制无新增clip失败。
2. 18:23:36.152 UTC，可见菜单查询返回index4 `Mark as unread`，元素尾号155。对应动作是RLM03第356行，而不是置顶。
3. 18:23:36.266–.321 UTC，WebDriver真实elementClick该菜单项返回null。当前suite第357行随后等待SQLite `unread_at`为number；日志下一条Renderer请求已经到第358行任务row查询，说明该await没有阻塞。但没有该时刻独立SQLite字段快照，不补造数值或完整未读UI通过。
4. 18:23:36.934 UTC，`findElement`查询同任务row；18:24:06.939 UTC首次30s POST element超时。查询没有返回not-found，不能归因为selector不存在。
5. 18:24:12.614 UTC，失败诊断snapshot execute/sync发出；18:24:42.621 UTC超时，未得到有效截图/DOM。
6. 18:24:42.622 UTC，finally重置QA clipboard拒绝开关的execute/sync也超时；18:25:12.632 UTC该错误覆盖test最终栈，NDJSON保存RLM03失败。必须同时保留最初element超时，不能把最终栈定位第308行解释成clipboard配置产品bug。
7. afterEach的纯可见menu查询于18:25:12.635 UTC发出，18:25:42.647 UTC继续超时；18:25:43.777 UTC下一查询同样无即时响应。后续同worker hook阻塞不构成未抵达case，也不能伪计skip。

## 结论与边界

- 分类：运行候选/协议INFRA链，未确认产品根因；RLM03完整标未读→清除→返回不反弹没有完成。
- 类似filtered GRP置顶后整session超时，但本次触发是Mark as unread，不能强归同因。两个动作共同依赖任务列表membership/焦点更新，仅可作为后续排查方向。
- 只读分析没有挂起期间CPU/workingSet或PID创建时间现场采样；已有事后进程图不能补称资源死循环。root将先按既有计划进行独立GRP精确复验及固定单run采样。
- RLM02复制零新增clip是更早的独立失败，仍由suite所有者归因；当前不能称exactly-once断言过严，也不把它与RLM03协议超时合并。

## 退出后的采样边界

主任务随后授权 [两次CIM观察](../test-plan-menu-hung-observation.md)。隔离runner于18:31:00.430 UTC启动，读取worker0-1既有perf的mainPid25980，以完整run/home/staged app与创建时间限定目标；18:31:01.392及18:31:04.313 UTC两次CIM均无满足全部marker的main，拒绝资源选取、exit1。原始 [两点记录](validation-menu-hung-cim-1793989860430.json)只有拒绝原因和空processes，没有挂起现场CPU/内存。

既有 [生命周期](../runtime/qa-menu-20261106-menu-reviewed/evidence/lifecycle-events.ndjson)已在18:26:33.821 UTC保存RLM after完成、18:27:07.090 UTC保存worker0-1 exited with code1，后续启动SLM worker0-2。CIM发生在该worker退出后，不能把它称为挂起现场采样，也不凭完整marker未匹配推断所有同PID进程不存在。本轮没有用SLM新Main或其它session数据补造RLM资源；原GRP固定新run sampler未改变，独立复验必须在启动前准备采样。

证据：[实际NDJSON](../runtime/qa-menu-20261106-menu-reviewed/evidence/test-results.ndjson)、[运行日志](e2e-qa-menu-20261106-menu-reviewed.log)约第99051–99505行、[loaded suite](../manual-review/pending/qa-residual-local-menus-20261106.test.ts)第349–363行。Loaded source指纹以该run manifest/独占证据为准，后续QA修改不反写本批事实。
