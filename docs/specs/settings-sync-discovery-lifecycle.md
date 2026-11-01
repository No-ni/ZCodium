# 首启 discovery 生命周期：切换/卸载后旧回包不得提交

## 规则、所有者与边界

`useSettingsSync`（`packages/ui/src/hooks/useSettingsSync.ts`）是首启引导（OnboardingDialog，挂载于 `packages/ui/src/Root.tsx:878`，跨 workspace 切换常驻）的唯一 discovery 状态所有者：`open / loading / step / discovery / selectedKeys / tasks / result / error` 由该 hook 的 `useState` 单份持有，`settingsSyncService.detect` 是唯一数据来源，`markFirstRunPromptHandled` 是 app 级（无 scope 参数）的首启提示持久化标记。

- 本 spec 只约束 discovery 读取链路的陈旧回包边界，不改变：手动 reopen（设置页「引导」）语义、import 流程、服务接口、持久化所有权、UI 布局、依赖集合。
- 取消边界必须贯穿 `loadDiscovery` 的全部 await 之后：detect 在途时发生 workspace 切换（`workspacePath` 或 `workspaceIdentity` 变化）或卸载，旧 scope 的回包不得提交任何状态，也不得触发 app 级 mark。
- `markFirstRunPromptHandled` 是已发出即生效的持久化写：只在回包属于当前 scope 时允许发起；发起后返回前再发生切换，不重置新 scope 的状态（不试图倒退已发出的写）。
- 无竞态的正常路径行为完全保持：首启非空结果打开弹窗、空结果标记 handled 并回到初始态、handled 已处理时不调用 detect、manual 空结果仍保持欢迎页打开。

## 已确认问题

effect（236-287 行）只对第一个 await（`getFirstRunPromptState`）做 `cancelled` 检查；随后 `await loadDiscovery()`（264 行）把取消边界关在了函数外。`loadDiscovery`（155-234 行）在 `await settingsSyncService.detect`（168 行）之后有 4 处无陈旧防护的 `setState`（177、196、203、225 行）与 1 次无防护的 `markFirstRunPromptHandled()`（195 行）。

触发场景与后果（旧回包按内容三分支，且无顺序保护，旧回包可覆盖新回包）：

1. 旧 scope 非空：用上一个 workspace 的 agents 打开引导弹窗（`open: true` + 旧 `discovery`），覆盖新 scope 的 discovery。
2. 旧 scope 空：调用 app 级 `markFirstRunPromptHandled()` 并 `setState(createInitialState())`，把新 workspace 的首启提示静默标记为已处理——新 workspace 不再弹出引导。
3. 旧 scope 失败：`setState({ open: true, error })`，用旧 scope 的错误打开弹窗。

卸载场景：hook 卸载后旧 detect 回包仍可发起 mark 与 setState。

## 修复方案（唯一所有者不变）

给 `loadDiscovery` 增加可选陈旧闸门参数 `isStale?: () => boolean`（不新增状态、不新增 pending 队列、不引入第二条事实来源），在五个检查点复查：

1. `loadDiscovery` 入口（早于 `setState(loading)`）；
2. `detect` await 成功后、使用结果前；
3. 空结果分支 `markFirstRunPromptHandled()` 调用之前；
4. `mark` await 返回之后、`setState(createInitialState())` 之前；
5. `catch` 记录日志与 `setState` 之前。

首启 effect 把自己的 `cancelled` 作为闸门传入（含 `FORCE_SHOW_ONBOARDING_ON_EVERY_REFRESH` 分支，保持该 flag 现有语义）；`reopen` 的 manual 路径不传闸门，用户主动触发的欢迎页/空 discovery 手动逻辑不变。

`FORCE_SHOW_ONBOARDING_ON_EVERY_REFRESH` 是 `const false` 的调试开关：该分支在当前构建中不会实际执行，九项回归全部运行在 flag=false 的真实路径上，force 激活本身没有测试覆盖。但该分支一旦被手工打开，此前 `return;` 不注册 cleanup，`cancelled` 永远为 false，传入的 `() => cancelled` 闸门永久失效——切换/卸载后旧 detect 回包仍可提交。因此该分支必须与主路径一样返回 `() => { cancelled = true; }` cleanup（最小修复，不新增 flag/导出/接口）。

## 验收

1. 回归 `packages/ui/src/hooks/useSettingsSync.test.ts`：真实 React（react-reconciler 内存渲染器 + 仓库既有 Node 24.14.0 工具链）驱动真实 hook，覆盖：旧非空/旧空/旧 reject 均不覆盖新 scope 状态且不标 handled；identity-only 同 path 切换同样受保护；卸载后无 late mark；正常首启、handled 路径、manual reopen 空结果仍 open；无竞态时 detect 入参字段保持；mark 在途期间切换 workspace 时已发出的有效 app-global mark 恰好一次、旧 await 后的 reset 不覆盖新 scope 的 dialog/agents。修复前旧回包用例红灯、修复后全绿。
2. 最小实现只改 `useSettingsSync.ts`：闸门参数 + 五个检查点 + effect 传 `cancelled`，中文注释说明原因与修复依据。
3. 不触碰 Root.tsx、ErrorBoundary.tsx、服务接口、持久化与依赖。

## 验证边界

- 回归经 `scripts/ci/settings-sync-discovery-lifecycle-regression.test.mjs` 在 `project-test-sandbox` 内以仓库固定 Node 24.14.0 运行真实 vitest；HOME/TEMP/APPDATA/数据目录/日志全部限制在 `.run-logs/project-only-validation/` 内。
- 渲染器是纯内存实现（无 DOM、无网络、无文件 IO）：react 与 react-reconciler 均经 `createRequire` 从仓库 `node_modules` 装载同一实例；`react-reconciler` 是仓库现有传递依赖（0.33.0，peer react ^19.2.0，与已装 react 19.2.7 匹配），本修复不新增、不改动任何 package.json 依赖。
- 未执行浏览器 E2E（本修复不改变交互与组件结构，竞态由内存渲染器确定性地复现）。
