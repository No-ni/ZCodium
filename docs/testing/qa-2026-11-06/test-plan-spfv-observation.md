# SPFV-E2E-002 浮窗布局现场观察计划

本计划仅扩展外置 QA 证据，不修改产品或既有用例。运行 `ui-shell/side-pane-full-view.test.ts` 的 SPFV-E2E-001、002，保留 001 建立的完整视图及面板 tab 前置。002 在对话 tab 的 stacked 布局与面板 tab 的 inline 浮窗之间真实点击切换。

待核实问题是 inline 浮窗内控件是否挤占输入区、发生第二行，以及 toolbar fit 数据是否落在实际 `.group/toolbar` 容器。当前源码 `ChatPromptEditor.tsx` 的外壳与内层 toolbar 共用 ref，仅属原因假设；64px 阈值失败本身不足以登记产品缺陷。

只针对精确文件和 `SPFV-E2E-002 ` 标题新增 afterEach observer。无点击、焦点移动、滚动、样式或 dataset 写入，不延长用例断言。观察该用例结束后的 host/dock/editor/action/send/model 几何、activeElement、DPR、视口与缩放、全部 `[data-composer-layout]` 和 `.group/toolbar` 的 class/dataset/font/padding/line-height/flex 属性，并保存唯一 PNG/JSON。JSON 同时记录 state、原断言错误及 QA observer 源 SHA，禁止据截图外推真机/DPI全量验收。

目标只使用已审查的 `ZCODE_E2E_ARTIFACT_DIR`，调用既有 bootstrap 路径/重解析点 guard 后写入。文件名包含 worker、计数、PID、时间戳；独占创建，不覆盖旧证据。观察失败独立写 error 元数据并抛出，不能把采集失败当作布局通过。

验收：TypeScript noEmit 和本地 loader 导入通过；非 002 case 不调用 browser 或写入。root 串行运行后，以真正失败帧的节点尺寸、换行和文字显示确认是否存在功能/布局缺陷，再决定严重程度。仅保留帧截图的证据不能称标准 WebM/MP4 录屏。

## filtered观察器失败后的增量复验

filtered已实际执行001通过、002在单行高度阈值失败。[原观察元数据](runtime/qa-menu-20261106-filtered/evidence/qa-spfv-observe-0-5-001-16900-1793986022678.json)只记录`javascript error: __name2 is not defined`，没有成功DOM/rect或PNG，属于QA回调经TSX序列化后遗留命名helper的采集失败，不能据此确认BUG005。源码双ref仍是待证假设，不能用修观察器改变产品布局或旧case断言。

root仅修外置observer的`browser.execute`为无TSX命名helper依赖的原始JS字符串。新独立run仍同时精确选001和002，**不单跑002**，因为001建立完整视图/面板tab前置；仍用工作树隔离HOME、真实UI切换、独立计数文件。下一证据需包含外壳与inner `.group/toolbar`各自dataset、label/icon/thought的computed display、输入/plus/send/control的rect与DPR。若仅64px失败而控件仍同一行，归合同阈值；若真实两行且fit状态与CSS owner不一致，再结合当前规范给产品原因与验收。

menu-final此次SPFV worker0-3在root `OpenSidePane` bootstrap等Browser launcher失败，001/002均0case；没有新DOM证据。此spec的001自身展开面板并建立Terminal tab后进入完整视图，它不要求Browser launcher可见，不能把无关全局OpenSidePane作为所有spec必需条件。下一轮保留`-Bootstrap`但省略`-OpenSidePane`，精确选001与002，由canonical自己的真实toggle/terminal前置进入；若此自身前置仍失败，保持QA前置阻塞，不改业务断言、单跑002或宣称布局失败已确认。
