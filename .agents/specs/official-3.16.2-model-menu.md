# 官方 3.16.2 统一模型 / 思考菜单

## 目标与吸收边界

本项只修改 `C:\vibecoding\zcodium-adopt-3.16.2` 的模型/思考入口及其回归。官方只读参考固定为 `C:\vibecoding\zcodium-upstream-3.16.2-review`，SHA `3c5b227649371507ddc4eb46ac5133afe6db1cab`。原工作区不修改；不提交、推送、打包，不读写真实用户配置。

先检查实际组件，再择叶适配，不覆盖本仓模型目录、Provider 配置、提交同步或旧审计成果。当前实际入口是：

- `packages/ui/src/ModelConfigSelect.tsx`：通用模型选择器；工作流、自动化、子代理等非 Composer 消费者仍保持原交互。
- `packages/ui/src/v4/composer/V4ComposerToolbar.tsx`：Composer 的模型和思考展示、快捷键与事件转换。
- `packages/ui/src/v4/composer/useDraftConfigControl.ts`：当前 workspace/session scope 的正文、模式与结构化 `modelSelection` 草稿 owner。
- `packages/ui/src/v4/SessionPane.tsx`：将菜单事件交给上述 owner，提交时调用既有冻结函数。
- `packages/ui/src/hooks/useModelSelectionView.ts`：目标 Host 目录与有效选择读取 owner。

官方新增 `ComposerModelMenu`、`ComposerProviderMenu` 的统一入口、离散调档、桌面子菜单和窄屏同层供应商导航是本项参考。官方账号/购买/套餐/连接切换 owner、Highspeed、额度查询、遥测、`useMotion` 与额外动画依赖不引入。API Key、用户自带 Key 额度及 Provider gate 逻辑不改。现有 Radix 菜单、Button、Tooltip、ScrollFadeViewport、快捷键徽标和原生 range 可复用，不新增依赖。

## 产品规则

1. Composer 只显示一个模型/思考入口：触发器显示模型及已绑定的思考档位；紧凑布局保留模型入口与档位指示，不另外渲染独立思考选择按钮。
2. 打开后同一菜单包含供应商导航、该供应商的模型列表及当前模型的思考档位。选模型后菜单保持打开，便于继续调档；选当前模型也不关闭菜单。
3. 供应商导航是局部展示页，不是第二份模型选择状态。选择其他供应商时，经现有模型回调选择第一个可选模型；没有可选模型时只浏览目录，保留原选择，不把原模型档位显示成该供应商的能力。
4. 多档位使用离散 range，顺序与真实 `optionSpecs.reasoningLevel.values` 一致；不按标签排序、不转换二值模型为另一套 switch 值。单档位只显示只读值，不显示滑杆或可调快捷键。无档位能力不显示调档区域。
5. 无选择或失效档位不得被显示层补成第一档、最高档或默认档。主动选模型仍由原 `completeNewModelSelection` 完成，保留本仓最高档的既有规则；恢复缺失值保持未绑定状态。
6. 空目录仍保留管理模型入口；首读失败复用已有显式重试，目标远端未就绪不回退到本机目录。
7. 默认 Ctrl+M 打开统一菜单，Ctrl+T 按既有命令表循环档位；改绑和取消绑定文案仍读取现有快捷键 hooks，不硬编码新的键位。
8. 管理模型仍打开本仓设置入口，不附带登录、购买、充值、连接模式写入或外部请求。

## 状态、接口与唯一所有者

| 状态/事实                                  | 唯一 owner                                                              | 菜单权限                                |
| ------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------- |
| 用户下一次提交的模型/档位/模式/正文        | `useDraftConfigControl` + 既有 `composerDraftStore`                     | 读 props，发送现有选择事件              |
| Host 模型能力、目录 revision、有效选择解析 | `useModelSelectionServiceView` / 目标 `IModelSelectionService`          | 只消费该目标的目录，不另建目录缓存      |
| 统一弹层排他开关                           | 既有 `activeConfigPicker`                                               | 统一使用 `model` picker，保留快捷键循环 |
| 供应商子菜单或窄屏浏览页                   | `ComposerProviderMenu` 局部展示状态                                     | 只拥有 open/浏览页，不保存模型或档位    |
| 最终执行选择                               | `createComposerSubmissionConfig` 冻结后经现有 Submission / CommandInbox | 菜单不写 Session/队列/运行中请求        |
| API Key 与额度                             | 原 Provider/Usage 服务和 hooks                                          | 本项不读写、不恢复官方控制面            |

`onSelectThought(thought, { provider, model })` 必须把用户操作时的模型上下文传到原草稿 owner；`SessionPane` 不得丢弃它。owner 同步校验该上下文是否仍等于当前结构化选择，且档位仍在该目标目录中。旧模型回调、空值、失效档位、旧 scope 回调零写入。有效同模型调档仅修改 `modelSelection.options.reasoningLevel`，不构造平行 thought store。无结构化选择时不借平铺 `provider/model` 合成选择；同值事件保留对象身份，不触发草稿持久化。旧 scope 防护沿用 `updateComposerDraft` 的唯一写入边界。

菜单快捷键展示复用现有 `components/ui/kbd.tsx`，不引用不存在的快捷键徽标。禁用目录重读交互不等于卸载 trigger/range：保留同 Host 目录的弹层可打开和关闭，模型项与档位回调分别检查当前 readiness；无目录首读仍等待 ready。Ctrl+T 仅在 ready 且当前模型有多档位时生效。紧凑指示沿用 toolbar 的 `data-composer-model-icon` 投影，不新增另一份布局状态。

目录在同一个 Host、enabled 与 unavailableReason 下因选择输入改变而重读时，现有读取 owner 可保留 `{ revision, providers }` 的目录投影。不得保留旧 `effectiveSelection` 作为新输入的答案；切 Host/远端 attachment 或变为 unavailable/error 时不暴露旧目录。菜单在重读期间保持挂载及 slider 焦点，使用 `aria-disabled` 和事件门禁阻止未就绪调档；执行仍必须等待 ready View，不以保留目录绕过 Submission 校验。该适配不新增 refresh API 或 Provider 同步链。

```text
模型点击 -> ModelConfigSelect -> V4ComposerToolbar.onSelectModel
        -> SessionPane -> useDraftConfigControl（同 scope 写完整 modelSelection）
档位操作 -> 原模型上下文 + 档位 -> SessionPane（仅透传）
        -> 同一草稿 owner（同模型 + 当前能力校验）
        -> draftConfigRef 同步更新 -> 原 ModelSelectionView 重读
提交动作 -> createComposerSubmissionConfig（此刻冻结模型 + 档位）
        -> 既有 Submission / CommandInbox
之后菜单修改 -> 仅下一次提交；不改已冻结请求
```

本项不改 owner/lease、commandId、stale run、Desktop continuous 或手机 replayable transport。两种入口共享同一选择/提交契约，GUI fixture 不伪称真实远控链已验收。

## 响应式、焦点与无障碍

- 桌面宽屏用 Radix 供应商子菜单；窄屏（639px 及以下）用同一弹层内的供应商页和“返回”，避免二级菜单撑出手机视口。
- 外层宽度和高度服从 Radix 当前可用空间；只让模型/供应商列表收缩滚动，标题、档位和管理入口不随模型列表滚出。遵守 `DESIGN.md` 的菜单表面、圆角、间距、`text-ui-*` 与明暗主题。
- range 有本地化名称与 `aria-valuetext`；方向键/Home/End/PageUp/PageDown 只调档，Escape 仍交给外层菜单关闭。缺失当前档位时，明确 Home/点击首格可以接纳第一档，不提前写入展示位置。
- 窄屏打开供应商页时焦点移到该页选项；返回/选供应商后焦点回到供应商触发项。宽窄切换不会丢失选中事实。
- 菜单打开期间关闭被动 Tooltip，Escape 不会只关闭提示而遗留菜单锁。
- 关闭时桌面焦点恢复到触发器所属 `.chat-composer-region` 内的输入，不抢另一 pane 的编辑器；找不到目标保留 Radix 触发器恢复行为。手机粗指针设备不聚焦 contenteditable、不自动弹软键盘，保留可访问触发器焦点。禁止用定时器掩盖焦点同步。

## 国际化

本项不修改 locales。优先复用：

- `settings.modelProvider.catalogProviderSelect`（供应商入口）
- `settings.modelProvider.models`（模型列表）
- `chat.toolbar.model.label` / `chat.toolbar.model.manageModels`
- `chat.toolbar.thoughtLevel.label` / `.placeholder` / 既有 `.value.*`
- `common.back` / `common.loading`

若实现需要新增 key，必须提供独立 handoff JSON 或最终完整 key/value 给主代理，不能在组件中静默硬编码英文。

## 先失败后实现的回归与隔离 fixture

新增 `packages/ui/test/adoption-model-menu.test.tsx` 和 `scripts/ci/adoption-model-menu.test.mjs`，先在旧实现上确认真实断言失败，再实施。Vitest 使用真实组件的 props/回调及既有提交冻结函数；源码回归运行实际 owner 回调，避免复制选择算法。

可执行 GUI fixture 允许位于 `packages/ui/test/adoption-model-menu.*` 和 `scripts/ci/adoption-model-menu*.mjs`。fixture 必须渲染真实 `V4ComposerModelControls`、真实菜单 primitives、真实 `useDraftConfigControl` / ModelSelectionView hook 和冻结函数，只在服务边界注入合成目录/可控响应；不启动 Agent、不写用户配置。独立 loopback 随机端口，不能占用已运行的 collapsible fixture；Vite/cache、HOME/USERPROFILE/数据根与输出置于 OS temp，结束清理。构建 fixture 不等于产品打包，不依赖桌面 dist 或外网字体。

验收矩阵：

1. 同菜单模型 A -> 模型 B -> B 档位 -> 提交；完整元组在冻结瞬间一致，之后改为 A 不污染已冻结 B。
2. 延迟旧 A 档位回调在 B 已选后到达；B 完全不变。空值/不支持档位零写入。
3. 同 Host 目录延迟重读时菜单和 range DOM/focus 保留；未 ready 不允许发起提交。切 Host/unavailable 不泄漏旧目录。
4. 未绑定旧模型、单档位、无档位、零模型、锁定模型，展示和选择无伪默认/官方 gate。
5. 桌面 Enter/Ctrl+M/方向键/Escape，窄屏供应商页/返回/选择，以及手机触控不重弹输入焦点。
6. 两个 composer 同页，从第二个打开/关闭只恢复第二个输入；legacy 非 Composer 模型选择仍选中即关闭。
7. EN/ZH、Zai Light/Dark，宽屏/390px/320px/受限高度、长供应商/模型名；菜单不横向越界，列表滚动与档位可见。
8. GUI 与单位/源码回归分别记录；未跑 GUI、实体手机、桌面 Electron、真实 Provider/远控链不得写成通过。

## 验证记录

- 实施前 freshness 通过（HEAD 无 tracking 分支因此跳过 behind-remote，相对 origin/main ahead 31 / behind 0）。
- 实施前 `corepack pnpm architecture:check --changed`：0 violations / baseline 0 / new 0。
- `corepack pnpm architecture:context ui`：现有 UI 是 unmanaged legacy module，无 module.ts/专用 contract；仅沿现有公开服务/hook 边界改动，不调整 architecture-policy。
- 实施前根 `corepack pnpm typecheck` 与 `corepack pnpm lint` 实际通过（Lint 0 warnings / 0 errors）。
- 本机 Node 实际为 24.18.0，mise 指定 24.14.0；pnpm 为 10.33.2。未为本项下载工具链或改 mise。
- 失败回归、实现后回归与 GUI 状态在完成时补记；网络/TLS 失败不代表代码或测试通过。
