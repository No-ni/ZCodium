# 本地菜单当前合同与归档补测计划

本计划在 `menu-final` 前置失败后串行补测，不修改产品、canonical 断言或超时。原批次只有浏览器权限查询 1 个实际失败；其余三菜单 suite 和 SPFV 是 hook 阻塞，不能记为 42 个功能失败。菜单脚本已按当前合同修正 Radix 元素生命周期与本地导入标题前缀，并通过独立静态检查；详见各原计划与 `logs/e2e-preflight-{local-menu,residual,short}-static.json`。

新 run 为 `qa-menu-20261106-menu-reviewed`，5 specs / 47 个计划 it：QLA12、RLM13、SLM15、SPFV001/002 两项及归档管理 ARM 五项。root 是唯一 UI 执行者，须等待 `local-canonical` 完成后启动。

本批不设置 `OpenSidePane`。SPFV001 自行点击当前侧栏 toggle、创建 terminal tab；002 依赖001。菜单脚本自行进入目标页面。归档管理有五项顺序依赖，完整保留，独立 worker 在正式退出屏障后只向本 run 的 `.zcodium` 双库写入合成 ARM fixture，确认删除只针对该合成任务。

全批采用 `Bootstrap` 与 `SafeTerminal`，保留既有 renderer preflight 和只读 reload/SPFV 观察器。有限 replay 列表仅为现有 `common.json` 与 `conversation-session-archive-management.json`；所选用例不发送 prompt，也不会触发 common 中的合成只读响应。所有 HOME、profile、TEMP、缓存、数据库、fixture、证据与文件保存只在当前工作树，启动时拒绝重解析点、未知路径与环境。

SLM05/14 使用只读导入历史时无法验证 runtime 回复复制和查找；若没有对应 runtime 控件/索引，保存边界证据并标 BLOCKED，不计通过。QLA07/09 也按实际 LIMITED/BLOCKED 与 Mocha skip 单列。系统剪贴板、文件选择、外部链接和危险确认使用各原计划的精确出口适配；取消只覆盖取消路径。

```powershell
$qaSpecs = @(
  '../../docs/testing/qa-2026-11-06/manual-review/pending/qa-local-menu-actions-20261106.test.ts',
  '../../docs/testing/qa-2026-11-06/manual-review/pending/qa-residual-local-menus-20261106.test.ts',
  '../../docs/testing/qa-2026-11-06/manual-review/pending/qa-short-local-menus-20261106.test.ts',
  './test/e2e/ui-shell/side-pane-full-view.test.ts',
  './test/e2e/conversation-session/conversation-session-archive-management.test.ts'
)
& .\docs\testing\qa-2026-11-06\run-menu-tests.ps1 -RunId qa-menu-20261106-menu-reviewed -Bootstrap -SafeTerminal -Specs ($qaSpecs -join ',') -Grep '(?:(?:QLA|RLM-?|SLM)\d{2}:|SPFV-E2E-00[12]|ARM(?:08|07|01/05/06|02|03)：)' -ReplayFixtures './test/e2e/fixtures/upstream/common.json,./test/e2e/fixtures/upstream/conversation-session/conversation-session-archive-management.json'
```

实际数量、结果和后续未抵达动作以 NDJSON、hook、截图和独占 JSON 为准，不以47项计划数代替验收。SPFV 新观察器必须实际输出 DOM/几何；缺证据不登记布局 bug。归档冷重启发生 suite beforeAll，早于 beforeEach 观察器装载；只保留正式 helper 退出屏障，没有独立 PID JSON 时不声称已完成独立进程观察，也不绕过屏障。
