# local-supplement独立结果与归因

实际完成于2026-11-06 19:05:28.964 UTC（北京时间11月7日03:05:28），exit1；计划5spec/22it，实际 **19条：11PASS、7原始FAIL、1真实SKIP**。数据源为[summary](../runtime/qa-menu-20261106-local-supplement/evidence/summary.json)、[NDJSON](../runtime/qa-menu-20261106-local-supplement/evidence/test-results.ndjson)和[CLI日志](e2e-qa-menu-20261106-local-supplement.log)。没有产品修改；后续QA源码修正不反写成本次输入。

| case | 真实结果与停止点 | 归因与未抵达范围 |
| --- | --- | --- |
| QLA05、QLA08 | PASS | 实际帮助有限mock链接与General自动归档行为；不称真实外部发布配置或安装包验收 |
| RLM08–13 | 6PASS | 实际导入/设置菜单中的本地MCP、Commands、Skills等相应保存点，边界以各步骤JSON与矩阵为准 |
| SLM06、08、09 | 3PASS | 实际帮助/引导/file相关动作；clipboard/native退出使用受控adapter |
| RLM04、07 | FAIL | 同一命令中心两行Settings真实可见并共享cmdk选择值；对应[BUG008](../bug-report.md#bug-008)。pointer后选中长度断言停止，Arrow与Enter未执行；不认重复执行 |
| RLM05、06 | 2FAIL | 近期任务搜索、命令预览各自等待超时。后续[已审QA源证据](qa-local-supplement-attribution.md)确认RLM05全局draft切换了workspace查询范围，RLM06旧body.innerText没有进入File open shadowRoot；旧后续断言未验，修后待新UI，不认新产品Bug |
| HIST01、02 | 2FAIL | 第一项公共归档codec拒绝旧hist-* ID输入；第二项依赖fixture未建立。见[旧codec证据](feature-inventory-historical-codec-12576-1793991684603.json)；[修后静态codec](feature-inventory-historical-codec-31596-1793991760745.json)没有新UI结果。80条viewer/33MiB bounded-tail未验 |
| SLM13 | SKIP | [19:04:27步骤JSON](../runtime/qa-menu-20261106-local-supplement/evidence/qa-short-local-menus-0-4-31192-1793991767933/019-SLM13.json)明确blocked、`PowerShell profile probe returned unknown keys`；NDJSON false空error与summary skipped1及CLI Pending联核。严格NoProfile对象防护在PTY前停止，不能把它算FAIL或Terminal/echo/office存活PASS |
| SLM15 | FAIL | [19:05:17步骤JSON](../runtime/qa-menu-20261106-local-supplement/evidence/qa-short-local-menus-0-4-31192-1793991767933/022-SLM15.json)与[PNG](../runtime/qa-menu-20261106-local-supplement/evidence/qa-short-local-menus-0-4-31192-1793991767933/022-SLM15.png)独立查看：preview displayed已跨过，旧light-DOM `textContent.includes`首行精确断言30秒超时，但PNG看见正确@pierre/diffs File正文第1–39行。旧run没有保存原始preview DOM文本，不能只据超时判断空白文件；后scroll、局部Find边界和CtrlF未抵达。当前QA已改正文读取，需要新run单独验收 |
| RFC/RMC | 0case | beforeAll的finite replay请求完整性guard未通过：assistant marker已经抵达，但第二auto-title请求500未匹配fixture。该hook失败不构成copy/Find test body结果，也不能忽略未知请求或扩大fixture池；当前plan为3it |

失败录制只保留PNG与时间序列；没有标准WebM编码结果，不称视频录屏验收。SLM证据里的passed仅代表保存点完成，不覆盖整case的最终失败。全轮unique按file/fullTitle去重，supplement复验只增加尝试，原始FAIL不等于bug数。

后续[QA归因与当前source SHA](qa-local-supplement-attribution.md)已确认RLM06/SLM15的File open shadowRoot读取owner；旧现场无shadow快照，不追认U+00A0或其它原始字符。最小修后版本仅静态READY，实际结果由新run另计。
