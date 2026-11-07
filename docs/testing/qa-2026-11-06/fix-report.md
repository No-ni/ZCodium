# 已确认 Bug 修复与回归报告

日期：2026-11-07（Asia/Shanghai）；版本：3.17.1；当前获准工作树：`C:\vibecoding\zcodium`。本报告记录本轮可执行测试阶段收尾后的本地修复。原 [测试报告](test-report.md)、[Bug 修前证据](bug-report.md)、[历史截点](test-execution-history.md) 保留，不将旧失败改写为通过。没有提交、推送、打包、发布或读取真实用户数据。

## 当前修复状态

本轮 8 项确认问题已完成本地修复与定向回归。确定性检查按重复启动守卫去重后为 57 个唯一用例，最终全部通过；真实 Windows Electron 定向回归为 7 个唯一用例，最新全部通过。完整尝试、原始失败与门禁结果见 [独立最终统计](logs/fix-20261107/validation-fix-results.json)。这不代表原 87 个功能组或跨平台全量验收完成。

| 编号 | 修复内容 | 已执行验证 | 状态 |
| --- | --- | --- | --- |
| BUG-001 | macOS 开发分支使用已有 Helper producer 探针；保持缺 producer 时跳过 | 9个实际脚本调度回归，覆盖平台/producer/调度失败；相邻构建与审计门禁 | 定向通过；macOS 真机未验 |
| BUG-002 | 删除旧 mobile 引导 fixture 的废弃遥测空方法，扫描规则不变 | 原遥测审计 2 个实际用例通过 | 定向通过；mobile 引导 UI 未验 |
| BUG-003 | 补齐四种工作流快照的 offeredMode 期待，保留旧 RPC 拒绝与官方 IO 禁止 | 原审计 3 个实际用例通过 | 定向通过 |
| BUG-004 | Storage Worker 等待本 Host 设置后，将 settings 经原 startup options 传入原 TaskIndexRepo | 真实源 Worker 修前 2/3、修后 3/3；Electron 首次启动/冷重开 2/2，exit0 | 回归通过；历史坏账不自动恢复 |
| BUG-005 | Main 在窗口创建前等待权限策略/bridge/store 装配；所有窗口入口共享完成门禁；回执绑定实际宿主，日志脱敏；补齐既有 renderer/preload 六接口 | adapter 与启动守卫合跑 9/9；真实设置允许/重置、通知气泡拒绝后再请求 2/2，exit0 | 定向桌面回归通过 |
| BUG-006 | 测量副本保留纯工具栏完整 leading/content/trailing 布局骨架 | UIF01 真实 240px 收缩/恢复通过，菜单、焦点和模型节点保持 | 定向桌面回归通过 |
| BUG-007 | toolbar ref 仅绑定内部 group/toolbar，使紧凑属性和 CSS 同 owner | UIF02 真实 560px 浮窗单行几何与返回对话通过，草稿/编辑器保持 | 定向桌面回归通过 |
| BUG-008 | cmdk 选择值改为唯一 command ID，搜索和命令回调复用原逻辑 | UIF03 中英文两个同名 ID 的 hover、唯一选中、上下键及 Enter 打开设置完整通过；独占复验 1/1，exit0 | 定向桌面回归通过 |

## 定向证据

- BUG-001/002/003：[spec 与完整红绿过程](../../specs/qa-menu-gate-fixes.md)。最终 [14/14](logs/validation-tests-bug001-003-green2-20261107.json)；相邻 [31/31](logs/validation-tests-bug001-003-adjacent-20261107.json)。第一次新 VM 夹具 green 的跨 realm Error 问题保留，之后仅修夹具构造器绑定。
- BUG-004：[独立验证和恢复边界](bug004-fix-validation.md)、[真实 Worker 修后详细证据](logs/validation-bug004-worker-after-fix.json)、[桌面回归计划](test-plan-bug004-desktop-migration.md)、[桌面 2/2](runtime/qa-fix-bug004-desktop-legacy-project/evidence/test-results.ndjson)、[完成摘要](runtime/qa-fix-bug004-desktop-legacy-project/evidence/summary.json)。不传 bootstrap，真实首次启动生成项目/primary root；正常退出后 Main PID 更换，同 profile 重开，项目 ID、roots、顺序和账本逐值不变。没有修改冻结 SQL/checksum，不重放已登记 0005。
- BUG-005：[治理 spec](../../browser-use/2026-10-08-embedded-browser-permission-governance-spec.md)、[启动守卫修前失败](logs/validation-tests-browser-startup-red-20261107.json)、[修后门禁](logs/fix-20261107/validation-tests-browser-startup-gated.json)。站点设置使用现有 canonical；新增 pending 只发通知权限请求并在产品气泡拒绝，不请求位置、摄像头、设备或共享屏幕。
  Browser 修后首轮 [2 条原始失败](runtime/qa-fix-20261107-browser/evidence/test-results.ndjson)、[完成摘要](runtime/qa-fix-20261107-browser/evidence/summary.json) 均停在旧 helper 的 macOS-only 侧栏快捷键，未达权限查询；首轮未启用已有的 `-OpenSidePane` 前置。复跑使用该选项经真实侧栏按钮展开空面板，产品代码及 query/请求断言不变，不将前置失败记作新产品 Bug。
  [第二轮](runtime/qa-fix-20261107-browser-retry/evidence/test-results.ndjson) 通过初始 denied 与设置页标题，但缺权限控件/通知气泡；[调查与补线](browser-permission-adapter-gap.md) 确认 renderer adapter/preload 漏掉已声明的六接口，属于 BUG-005 同一链路。只补既有接口委托与事件订阅，保留 Main 唯一授权状态源及旧 preload 能力缺失。实际源码 AST 回归和已有启动守卫合跑 [修前 2 PASS / 7 FAIL](logs/fix-20261107/validation-tests-browser-permission-adapter-red-20261107.json) → [修后 9/9 PASS](logs/fix-20261107/validation-tests-browser-permission-adapter-green-20261107.json)；其中启动守卫重复，不增加唯一用例数。
  补线后的 [实际桌面 NDJSON](runtime/qa-fix-20261107-browser-adapter/evidence/test-results.ndjson) 与 [完成摘要](runtime/qa-fix-20261107-browser-adapter/evidence/summary.json) 均为 2/2 PASS、exit0。canonical 逐项允许使真实 guest query 变 granted，重置恢复 denied；BPF01 两次通知申请均出现真实产品气泡，点击拒绝后网页结果和 query 为 denied。未调用 `new Notification` 或任何设备/位置请求。
- BUG-006/007/008：[UI 回归计划](test-plan-ui-bugfix-20261107.md)、[初次静态准入](logs/feature-inventory-ui-bugfix-preflight-final.json)、[最新几何准入](logs/feature-inventory-ui-bugfix-preflight-geometry-final.json)。修正新测试误留的旧 64px 高度阈值；单行由真实控件中心/次序和输入至少半宽验证，高度只记录。静态检查不计 UI 通过；保留用户原有 placeholderContent 等修改。
  首轮 [实际桌面 NDJSON](runtime/qa-ui-20261107-bugfix/evidence/test-results.ndjson) 和 [完成摘要](runtime/qa-ui-20261107-bugfix/evidence/summary.json) 为 2 PASS / 1 FAIL、exit1：UIF01 的 240px 收缩/恢复保持菜单、焦点与模型节点；UIF02 的 560px 浮窗通过单行几何、草稿及编辑器保持。UIF03 当时完成英文两个 ID 的唯一选择及打开设置，旧 portal 即时不存在断言遇到退出动画；仅补 QA 卸载等待，原断言与全部中英文动作保持，[静态准入](logs/feature-inventory-ui-bugfix-preflight-command-retry.json) 通过。随后 [独占复验 NDJSON](runtime/qa-ui-20261107-command-retry/evidence/test-results.ndjson) 与 [完成摘要](runtime/qa-ui-20261107-command-retry/evidence/summary.json) 实际为 1/1 PASS、exit0，中英文四组 ID 操作完整抵达；不重跑已通过 UIF01/02，不覆盖旧 FAIL。长 placeholder 的换行/截断仅记录观察，UIF02 不代表提示词排版完整验收。

## 代码门禁与环境边界

- 六接口补线后的最终门禁：[全仓类型](logs/fix-20261107/validation-typecheck-browser-adapter-final.json)、[Desktop E2E 类型](logs/fix-20261107/validation-desktop-e2e-typecheck-browser-adapter-final.json)、[外置 QA noEmit](logs/fix-20261107/validation-qa-typecheck-browser-adapter-final.json)、[架构](logs/fix-20261107/validation-architecture-browser-adapter-final.json) 均实际 exit0，架构 baseline/new/总 violations=0。E2E 前以 [独占重建](logs/fix-20261107/validation-fix-rebuild-scheduler-browser-adapter-final.json) 补齐 scheduler 声明，之后桌面回归重新构建副本。
- 最终 [原始全仓 Lint](logs/fix-20261107/validation-lint-browser-adapter-final.json) 实际 exit1：17502 文件、43695 warnings、88 errors。完整日志独立归因：88 errors 全在保留的 QA runtime 插件副本，均为 `max-lines`；runtime 外 error=0。最终 [排除 QA runtime 的补充 Lint](logs/fix-20261107/validation-lint-source-browser-adapter-final.json) 实际 exit0：5743 文件、3 个既有警告、0 errors。两种结果分开保留，不将补充检查写作原始检查通过。以下为此前门禁与修复过程。
- [类型检查首次失败](logs/fix-20261107/validation-typecheck-final.json)：上一轮 E2E 构建替换 scheduler 输出，增量缓存仍认为声明存在，产生 4 个 TS6305。[重建声明](logs/fix-20261107/validation-fix-rebuild-scheduler.json) 后 [全仓类型检查通过](logs/fix-20261107/validation-typecheck-after-scheduler.json)。Desktop [E2E 类型检查](logs/fix-20261107/validation-desktop-e2e-typecheck-final-pinned.json) 和 [外置 QA noEmit](logs/fix-20261107/validation-qa-typecheck-final.json) 通过。
- [原始 Lint](logs/fix-20261107/validation-lint-final.json) 仍失败：16063 文件、38388 warnings、76 errors；76 errors 来自保留的 QA runtime 插件副本。[仅排除 runtime 的补充 Lint](logs/fix-20261107/validation-lint-final-source.json) 通过：5739 文件、3 个既有警告、0 errors。没有删除证据或修改扫描守卫掩盖失败。
- [架构最终通过](logs/fix-20261107/validation-architecture-types-final.json)：baseline/new/总 violations 均为 0。先将现有权限 bridge/manager/store 纳入受管模块，再拆出纯接口叶子解除旧 type-only 循环，保持同一 owner 和写入路径。两次中间失败 [登记前](logs/fix-20261107/validation-architecture-final.json)、[类型抽取前](logs/fix-20261107/validation-architecture-after-adoption.json) 保留。[类型抽取后全仓 typecheck](logs/fix-20261107/validation-typecheck-types-final.json) 与 [最终补充 Lint](logs/fix-20261107/validation-lint-source-types-final.json) 通过；后者为 5741 文件、3 个既有警告、0 errors。
- 所有 HOME、TEMP、缓存、合成 `.zcodium`、测试页面、预览文件和日志写入当前工作树；使用已有工具缓存，不安装依赖/下载工具。Node 实际 24.18.0，与 mise 固定 24.14.0 有偏差。

## 仍需独立验收的范围

macOS 真机、真实手机/远端/Provider/Bot、自建服务、安装包、系统设备和屏幕权限未验。Browser 多宿主回执、设备/屏幕 chooser 的窗口归属以及重启授权持久化不由此次安全拒绝测试替代。历史轨迹 HIST02 的未达后续断言继续作为 QA 同步候选，不修改产品来满足未确认候选。

首次迁移接线修复不能自动恢复已登记 0005 但项目为空的历史 profile：无法安全区分遗漏与用户主动移除。恢复须由用户明确选择项目 roots/任务，再经既有公开项目新增/移动接口处理；本次未迁移、重建或恢复任何真实用户数据。
