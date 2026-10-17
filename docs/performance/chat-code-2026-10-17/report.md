# 聊天代码片段：展示职责调整与隔离验证

本次把 Markdown 围栏从完整文件查看器中分离：`MessageResponse` 显式选择 `CodeSnippet`，以稳定原文节点负责布局、选择和查找；按视口启动语法高亮视觉层，离屏释放 token DOM。同一 document 共用一个 IntersectionObserver。标题、复制、折行和 Mermaid 分支继续由 CodeBlock 负责；带行号、诊断、评论和行定位的其他入口仍使用 CodeViewer。

这是展示职责与工作预算的调整。没有增加源码缓存、定时重试或 RPC 分支，没有改变 live-tail、静态 Markdown 或会话状态边界。设计和事件顺序见 `docs/specs/performance-chat-code-display.md`。

## 前后对照

原始数据为同目录 `evidence.json`。Node 24.14.0、Corepack pnpm 10.33.2、Windows 本机无头 Edge（具体版本见 JSON），视口 1280×900。测试使用真实 MessageResponse、CodeBlock、完整 UI CSS 和合成的 34,122 字符 / 240 个 TypeScript 围栏。修改前后各建独立临时 Vite 缓存和浏览器 context，均运行 3 次新页面。

“修改前”通过 Vite load 插件读取本轮开工保存的 `code-block.tsx` / `message.tsx`；其余依赖保持同一脏工作区。没有覆盖工作区文件或安装应用。对照脚本为 `scripts/ci/measure-chat-code-rendering.mjs`，参数为两份修改前源码所在目录及输出 JSON 路径；本轮两个文件此前与 HEAD 一致，可用该版本的这两个文件重建输入。源码快照不长期保留。

| 指标                          |             修改前 |  修改后 |
| ----------------------------- | -----------------: | ------: |
| 冷挂载提交中位数              |            909.3ms | 784.1ms |
| streaming→static 提交中位数   |            502.4ms | 481.3ms |
| 模拟历史重挂提交中位数        |            532.2ms | 317.8ms |
| 历史重挂到后续两帧中位数      |            732.2ms | 694.6ms |
| 消息内元素数（含 Shadow DOM） |             14,885 |   5,173 |
| Shadow Root 数                |                240 |       0 |
| 完成态首屏高亮层数            | 文件查看器内部管理 |       8 |

提交时间来自夹具更新发起到父组件 useLayoutEffect，包含调度和 React render/commit，不能等同于所有异步渲染完成。后续两帧时间另行观测；DOM 诊断遍历在计时区间外。三次样本很少，Vite 开发态还有观测开销，没有把资源数量减少换算成整机内存或速度比例。

终态提交范围为修改前 492.3～541.7ms、修改后 465.0～550.9ms，明显重叠；历史重挂仍观察到 600～684ms 长任务。因此本次确认减少了完整查看器和常驻 DOM，并降低重挂的 React 提交成本，**没有证明长回复终态卡顿已经根除**。Markdown 解析、控制组件批量构建和终态重挂仍需进一步按 profile 分解；本次没有据此继续扩大缓存、改动虚拟列表或删除既有 React 稳定性防护。

## 验证与隔离

新增可见性生命周期单测覆盖 240 个目标共用 observer、目标路由、迟到 entry、最后订阅清理、跨 document 和能力缺失。浏览器回归使用真实 Markdown / Shiki 与完整样式，核对手机和桌面宽度下的复制、折行、横滚、明暗主题、原生/会话查找、异步高亮和离屏后原文节点及 Range 稳定，以及流式完成和模拟历史重挂。

浏览器回归还覆盖 20px 字号、中文、制表符、空行和 emoji，逐字符 Range 几何探针确认折行后的原文与视觉层偏差不超过 1px；超字符预算、纯文本、未知语言和缺少 IntersectionObserver 均保留完整原文。另一个页面仅替换高亮入口的回调，验证过时输入、超 token 预算及卸载后通知不会产生视觉层。

最终验证：

- 根级 `corepack pnpm typecheck` 通过。
- 根级 `corepack pnpm lint` 通过，0 warnings / 0 errors。
- `corepack pnpm architecture:check --changed` 通过，baseline 0 / new 0；`ui` 是既有非托管模块，本轮没有跨模块新依赖或业务状态所有权变化。
- 6 个相关 Vitest 文件的 35 项测试通过：`codeSnippetVisibility`、`performanceFrontendHighlight`、`performanceRound3Find`、`performanceRound11FindSnippet`、`messageFileLinkTarget`、`messageMarkdownFilePipeline`。
- `node --test scripts/ci/performance-chat-code-browser.test.mjs` 通过，覆盖上述真实样式与交互场景，pageerror 0，外网请求 0。
- 既有 `performance-find-browser.test.mjs` 与 `performance-round11-find-browser.test.mjs` 通过，共 4 个 TAP 测试项（含父测试）；目标文件格式检查及 `git diff --check` 通过。

生产代码净增 186 行：两个现有入口共增加 14 行，新增只读展示组件 132 行、共享可见性订阅 40 行。其余是 spec、合成夹具、回归测试与测量脚本。工作区原有的其他改动保留。

浏览器网络只允许测试服务同源、data 和 blob；clipboard 使用测试页内 mock，不写系统剪贴板。没有启动 Electron、真实 Agent、外部模型或业务服务端，没有读取业务配置和用户数据，没有打包、安装、提交、推送或触发 Actions。正常测试运行的 Vite 缓存和临时浏览器 profile 自动回收，最终没有存活的本轮测试进程。

测量时源码快照目录及一次中断遗留的 Vite 缓存尚未清理；此处省略具体本机临时路径。仓库 freshness 的联网 fetch 被连接重置中断，`--no-fetch` 对已有 origin/main 的比对为 ahead 0 / behind 0。
