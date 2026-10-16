# Workflow Holes P3b：UI 与展示契约

## 范围与所有者

接续现有半成品，不覆盖 P3a、bootstrap/runtime 或 dynamic-workflow-holes.md；跨层收尾仅涉及 CLI contracts、core 的 create-workflow display 投影及对应测试。Runtime/CommandInbox 是留白状态、补全 admission、owner/lease 与有效脚本的唯一所有者；v4 reducer 是只读投影；UI 不接受/排队补全、不拼接脚本、不推算插入偏移、不新增 approval 路径。

```text
FillWorkflowHole → 既有 permission/admission → runtime 编译/持久化有效脚本
  → hole-filled / phases 更新 → v4 reducer (phaseNames/phaseHoles/phaseAlongside/holes)
  → UI 派生时间线、通知与工具输出
backend hole-reached → workflow manifest(kind: hole) → backgroundResult turn
  → 通知点击(siteId) → 既有 onOpenWorkflowRun → focusPhaseId → 展开/滚动到站
Desktop continuous ─┐
Web replayable ────┴→ 同一 owner/sequence 与只读投影（UI 不补业务状态）
```

## 产品规则 / 只读来源

- 一个留白就是一个阶段；`siteId` 是稳定定位键，阶段 id 与它相同。开放 `phaseHoles` / display.holes 画内空虚线灯；等待 warning，但不呼吸/shimmer；filled 不画虚线。未知 run 的通知中性，不假报已补。
- 活投影 `run.phaseHoles` 优先于创建时旧 display.holes；名称只用于 phaseNames 下标到 display 阶段的映射，id 匹配优先。仅源码图时可读 display.holes；不将普通阶段误判成已补留白。
- `run.phaseAlongside` 是插入后下标表，UI 只以 `phaseNames` 映射阶段 id；空数组明确清除旧 display 的 alongside。缺少整个投影表才退回 display。补全的 >h 偏移由 reducer 负责。
- hole notification(kind: hole) 的状态联查已存在的 run 摘要 `run.holes`，不新增 Zustand 状态/缓存。定位意图必须带 parentSessionId、原发起 toolCallId、runId、siteId→phaseId。关联不足时不提供定位按钮，保留中性通知，不用 toast 冒充定位。既有侧栏落站机制存在；若图缺失侧栏会明确显示图不可用，不能声称一定定位成功。
- FillWorkflowHole 归入 workflow identity，兼容规范名和 snake_case wire 名。复用 CreateWorkflow 的 create_workflow display 安全解析、编译诊断和图，使用补全文案与 fill 名称，失败不显示为新 run 已启动。
- 审批由现有 WorkflowPermissionBlock/PermissionDialog 承载。后端归一化 raw.hole 提供留白事实与 `effective_script`（完整拼接脚本）；raw.script 仍是函数体。确认图来自现有 request.display(create_workflow)。UI 优先展示 effective_script，不自行拼接，缺预览明确标注只展示函数体。不改变 Deny/Refine/Run 命令或 owner 规则。
- strict 展示 schema 接受 step.kind='hole'、fill、holes、notification.kind='hole'，CLI contracts 与 shared 手工同步；类型原文是编译契约，通知可用文字说明返回类型，不把它当阶段状态。

## Backend 生产接口 / 顺序

- `WorkflowNotificationMeta` hole 分支供生产者生成 manifest：siteId/ordinal/name/type 必填；prompt/draftPath/line/before/after/reachedAt 可选。挂在 workflow backgroundResult 的 originMeta.workflowNotification 上；workId 为 runId。backend 必须从 hole-reached 生成该 manifest（仅加类型不能产生通知）。
- 归一化 FillWorkflowHoleInput.hole：name/type/owned_by_this_session，可选 draft_path/line/effective_script。effective_script 必须是审批将编译的完整拼接结果；生产者还应以同一份脚本铸 approval display，避免图/代码不一致。
- 成功/拒绝均发送 create_workflow display + fill{siteId,name,draftPath?,line?}；成功图必须是有效脚本最新图，包含 kind:'hole'、holes、phase/step fill。现有图联接表仍按原发起 toolCallId 查找；从成功 FillWorkflowHole 行 input.run_id 联查 run.toolCallId，以同 run 成功补全的最大 `display.fill.commitSequence` 对应图覆盖该表的旧创建图。失败/待审批补全不覆盖，UI 不新增持久化图状态。会话、run 侧栏和脚本侧栏必须消费同一张派生表。
- producer 接口：`CreateWorkflowOutputSchema.fill` → `createCreateWorkflowDisplay` → `completedToolPartMetadataSchema.display` → shared `toolCallCreateWorkflowDisplaySchema`。`fill` 为可选 strict 对象，必填 `siteId`（1–64 字符）、`name`（1–128 字符），可选 `draftPath`（1–1024 字符）、`line`（正整数）、`commitSequence`（非负整数，与 contracts 同界）。输出与 display 复用同一 contracts schema；成功与拒绝都保留，不带 fill 的旧 CreateWorkflow/AmendWorkflow 不增添字段。未知 display/fill 字段仍拒收，不通过 passthrough 放宽或清洗 fill 掩盖契约缺失。
- session metadata 的通知校验以 shared `backgroundResultOriginMetaSchema.workflowNotification` / `workflowNotificationMetaSchema` 为运行时边界（不是仅 TS 接口）。hole 分支字段与 `WorkflowNotificationMeta` 一致；`siteId` 1–64、name/type 1–128、ordinal 非负整数、prompt ≤4000、draftPath ≤1024、line 正整数、before/after ≤128、reachedAt 数值。通知的可选字符串允许为空，与 display.fill 的非空定位字段不同，不错误收紧历史通知。
- 单一状态所有者仍为 runtime/CommandInbox；executor 仅投影，metadata/schema 仅校验，不新增通知、缓存、admission 或补全状态。成功/拒绝 output → display → live/persisted metadata → Desktop continuous / Web snapshot+replay；既有幂等、stale-run/owner/lease 守卫不变，UI 不按超时猜测补全。

## 验收（自动）

1. open/waiting 虚线灯，filled/普通站不虚线；活 phaseHoles 空表覆盖旧图开放态。
2. 插入 k 个阶段后 alongside 使用归约新下标；空表不会恢复创建图旧索引；输入不被修改。
3. workflow backgroundResult 的 hole manifest 可路由；定位 request 带 siteId 对应 phaseId 和原始发起行，缺关联不可定位；waiting→filled→投影淘汰中性。
4. FillWorkflowHole 规范/wire identity 与 renderer 识别一致；成功/拒绝 display 安全解析（包括 kind:'hole' manifest）；非法载荷回退文本。
5. 审批优先拼接预览，不误把函数体说成完整工作流；缺预览明确展示函数体，并沿用原 approval 组件。
6. CLI 的 node:test 覆盖成功/拒绝 output 经 executor 生产 metadata 后，producer strict schema、持久化 parse 入口和 shared display schema 均保留 fill 与 hole 图；不只验证工具 output。验证 fill 边界值/越界/未知键，不带 fill 的旧结果兼容。
7. 完整 typed hole manifest 经 shared session backgroundResult metadata runtime schema 解析后字段不丢失；缺少必填字段及越界值拒收。CLI 包级新测试只使用 node:test + node:assert/strict；CI 的 Vitest 定向入口不包含 CLI `test/*.test.ts`，不扩 include。

## 接线核查（当前树）

- backend 已有 `notifyHoleReached` → workflow manifest(kind: hole) 生产路径；`boundCausalityGraph` 已保留 kind:'hole'、graph.holes、phase/step fill。
- 并行 backend 工作已改为归一化 `hole.effective_script`，approval 图读取同一字段，UI 直接复用既有权限块。
- 本次跨层收尾补齐 producer strict display 的 fill 与 executor 透传；transcript 的 input 不包含 resolveInput 回填的 hole，工具行不得靠 UI 猜名字。通知 runtime schema 已具备 hole 分支，使用同一 typed manifest 的真实 metadata 解析测试锁住，不另造 schema。
- UI 确实接到既有 focusPhaseId 落站机制；纯逻辑测试验证 request/路由，新增 SSR 回归验证零 step 的审批、工具卡、run digest 时间线和侧栏原始 siteId 站节点。SSR 不执行落站 effect，未做真机 DOM 滚动验证，不能报告真机已定位。

## 最终 correctness：提交顺序与纯留白图

- durable journal 是顺序唯一所有者：`StoredEvent.sequence → FillResult.commitSequence → output/display.fill.commitSequence → UI 只读 max`。Desktop continuous 与 Web snapshot/replay 读取同一序号；不使用工具行输入顺序、时间戳或到达顺序猜提交先后，不新增 UI 状态或 fallback 序号。
- 同一 run 只考虑工具行 status=success、display.ok=true、有效非空图的 FillWorkflowHole；最大 commitSequence 胜出，failed/pending 不覆盖，run_id 经现有 run.toolCallId 联接，run 间不借补全图。同序号是同一次 durable 提交的重放，载荷应相同；旧序号在完整可见行窗口的 snapshot/replay 重算中不能覆盖较大序号。窗口若移除最新行，仍遵循既有有界历史缺图语义，不创建跨窗口缓存。
- 迁移保守规则：存在任何带序号的成功候选时只使用带序号候选；仅有一条不同 toolCallId 的无序号成功 fill 时兼容该图（同 toolCallId 重放视为同一条）。多个无序号成功 fill 无法证明提交顺序，保留发起图；不任取某次 legacy fill 为最新，也不根据时间猜测。缺发起图时保持无图。
- 统一有效图判定：steps、phases 或 holes 任一非空即为有图；纯 `return await hole<string>('decide')` 的 steps=[]、phases/holes 非空必须可联接、审批展示、时间线展示与通知定位。三者均空仍无图。保持原始 siteId 定位与既有 renderer 虚线灯。
- 新增 Vitest：工具输入 A/B 与提交 B/A 相反、failed/pending、不同 run、旧序号 replay、legacy 单条/歧义/混合；纯 hole 工具行/直接启动行联接、审批/工具卡/run digest/侧栏同源时间线与 siteId 定位意图，以及 truly empty。

## 留白完整依赖分析的展示边界

本次用户授权吸收完整留白依赖分析与 `model_bindings` 校验；补全生长动画和 Rust 引擎仍不在范围内。
分析器拥有 `holeData` 与完整因果图，工具输出只经既有有界 display 发布
steps / lanes / participants / handoffs / phases / holes / sink；UI 不新增一份依赖事实或运行态。

```text
脚本 + 模型绑定 → CLI 校验与依赖分析 → 有界工具 display
                                           ↓
                          同一时间线模型 → 审批 / 聊天卡 / 侧栏
durable commitSequence → 原有最新成功补全图选择（桌面 continuous / 手机 replayable）
```

- 开放留白以 `kind: hole` 的站点、`main` 合成车道进入依赖图；它代表主代理等待补全，不能画成未命名子代理或分配子代理会话/头像。
- `main` 不参与匿名子代理编号；留白 step 不计入 ask/read 数量。真实匿名子代理的编号、名称与点击行为保持原有规则。
- phase、handoff、sink 继续消费分析器提供的依赖结果，保留原始 siteId；UI 不猜测或复制 `holeData`。
- 已补全留白仍按原子提交序号选最新图；旧 snapshot/replay、失败补全或其他 run 的图不得覆盖新图。
- 模型绑定错误使用现有结构化诊断和脚本行定位，不新增权限或官方模型服务入口。
- 回归覆盖 main+匿名子代理、纯留白、留白到后续参与者的依赖和三处真实 SSR renderer；浏览器交互检查不得替代 CLI 的绑定准入测试。

## UI 留白测试入口与 CI 门禁

- 根目录 Vitest 默认没有 UI 的 `@` alias；这两个套件依赖真实 UI 纯函数与 SSR renderer，import 失败属于套件失败，不能以其他入口或临时配置的成功代替 CI 结果。
- 唯一受控入口是根目录执行 `pnpm vitest run --config packages/ui/vitest.holes.config.ts`。配置将 `@` 映射到 `packages/ui/src`，使用自动 JSX 转换和 node SSR 环境；include 仅 `packages/ui/test/workflowHoles.test.ts` 与 `packages/ui/test/workflowHoleOnlySurfaces.test.ts`，不扫描混用 node:test 的其他 UI 测试，不引入依赖或 mock 被测图联接、留白状态、时间线及 renderer 核心。
- Desktop CI 的 `Vitest suites` 使用多行 run：第一条保留原 shared / mobile / desktop / adapters / UI webRemoteControlTarget 定向入口，只移除上述两个 UI 套件；第二条紧接执行受控 UI 命令。任一命令非零则步骤失败，不设置 continue-on-error，不吞退出码。配置只归属测试入口，不改变 runtime/投影/UI 的状态所有者或生产导入。
- 验收必须从仓库根目录执行与 CI 完全一致的两条命令，并将真实 tests/files/exit 记录到 `/tmp/final-ci-vitest-fixed.log`；同时执行 fmt/typecheck/lint/architecture，区分基线失败与本次引入的失败。SSR 仍不等于真机落站 effect/E2E 验证。

## E2E 场景（真机执行按用户要求暂缓）

- Desktop：运行含开放留白的脚本，主线/站头/侧栏三个虚线灯一致；到达后 warning 虚线、通知等待时长且无 shimmer。键盘展开并点击 Locate，既有 run tab 打开，目标站展开且滚入视口；再次点击同站重新落点。
- 补全插入两个阶段：验证并行带右移且无旧下标残留；成功输出补全名称/图，原通知变已补；失败显示既有诊断与文件行号，run 不变成新 run。
- 非 owner：现有权限窗展示完整拼接代码/同源图、留白名/草稿定位；拒绝/Refine 不执行补全，批准沿用原路径。缺 effective_script 时明确显示函数体而非伪预览。
- Web 手机：相同 notification 可点击打开同一 run/站；断线 snapshot+replay 后 waiting/filled 与并行带一致，无重复 approval/Agent/Host。图不可用时显示既有提示而不伪报定位。
- Zai Light/Dark、中英文、窄屏/键盘：文本不溢出、定位控件可聚焦、状态不只靠颜色；未知/淘汰 run 无伪定位或伪已补。
