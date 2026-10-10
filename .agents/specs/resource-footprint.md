# 资源足迹评估与优化排序

## 范围与产品规则

本 spec 记录 ZCodium 桌面应用**实测**的资源足迹、对外部重写方案（Tauri / Native UI / GPUI）的评估结论，以及据此得出的优化排序。它是决策记录，不引入实现。

所有数字必须是本仓库实测；引用第三方数据必须标明来源与口径，不得把别人的实测当作我们的结论。

## 实测基线

测量环境：x86_64 Ubuntu 22.04，本机裸构建（`ZCODE_ENV` 未设 → 解析为 Preview 身份，产物名 `ZCodium Rust`）。

### CLI 单进程（`zcode.cjs app-server`，x64 Electron Node + `ELECTRON_RUN_AS_NODE=1`，即生产运行时条件）

|                       | VmRSS         | PSS       | 线程 |
| --------------------- | ------------- | --------- | ---- |
| app-server 空闲       | **276.6 MiB** | 230.2 MiB | 12   |
| 裸 Electron Node 地板 | 41.3 MiB      | 18.1 MiB  | 7    |
| 自身净开销            | **235.3 MiB** | 212.1 MiB | —    |

32 秒采样 RSS 完全平坦，空闲态无明显泄漏（该窗口内）。

三条泳道常驻合计 **约 830 MiB**；换 Rust CLI 后可收回约 **776 MiB**（按 MBearo 对 ZCode-rs 的实测 17.8 MiB/进程折算，非我们实测）。

### 桌面应用启动过程（窗口未出现时）

| 角色                        | 进程数 | RSS           | PSS       |
| --------------------------- | ------ | ------------- | --------- |
| `main`                      | 1      | 245.3 MiB     | 148.1 MiB |
| zygote ×3 + network utility | 4      | 404.8 MiB     | 140.5 MiB |
| **合计**                    | 5      | **650.9 MiB** | 288.9 MiB |

**一个像素都未绘制即 650.9 MiB。** 主进程 0.3% CPU、停在 `do_poll`、16 个 socket，是在等待后端握手/首启登录，未崩溃。

zygote 预热的 RSS 口径为 291 MiB，PSS 口径仅约 100 MiB（大量共享页）——引用时必须说明口径。

### app.asar 构成（286.2 MB，28641 个文件）

| 部分                     | 解包后体积 | 占比 |
| ------------------------ | ---------- | ---- |
| `node_modules/`          | 292 MB     | 80%  |
| `out/`（编译后应用本体） | 73 MB      | 20%  |

`node_modules` 内最大者为 echarts 26 MB、mermaid 22 MB、pdfjs-dist 17 MB、@extend-ai 16 MB、lucide-react 14 MB、@shikijs 13 MB、playwright-core 10 MB、highlight.js 10 MB、@larksuiteoapi 10 MB、es-toolkit 9 MB、world-atlas 7.9 MB。

**`src/` 源码目录合计仅 20.1 MB（102 个目录，占 asar 的 7%）**，不是主要矛盾。

## 评估结论：Tauri / Native UI / GPUI

### 已排除：Tauri

除"Host 需先变 Rust"外，WebView2 是独立否决项：

- agent browser 共 **12,051 行**，引用 `webContents` **372 处**、`CDP` **236 处**、`BrowserView` **215 处**；
- `BrowserView` 是 Electron 独有 API，WebView2 无对应物；`webContents` 同样；
- WebView2 运行时在老旧 Windows / LTSC 上需安装或引导下载，且其 Chromium 版本流与 Electron 内置不一致，会使测试口径失效。

结论：迁移 Tauri 需重写这 12k 行，不是"保留一个 webview"。

### 已排除：整体 Native UI 重写

- `packages/ui` 为 **285,365 行** React（另有 12,455 行 i18n），75 个依赖；
- 其中高度专业化的依赖无 Rust 对等物：xterm、shiki（TextMate 语法）、streamdown（含 cjk/code/math/mermaid）、pdfjs-dist、docx-preview、react-pdf、@extend-ai/react-docx、@extend-ai/react-xlsx、@aiden0z/pptx-renderer、@lexical/react、@pierre/diffs、@xyflow/react、recharts、@dnd-kit/\*、radix-ui；
- 前端一项即大于 CLI runtime（102k 行）与 Host（124.7k 行）之和；
- 本仓库的立身之本是跟进上游 TS/React，i18n 键差集对账依赖可比产物，重写会使其失效。

### 已排除：GPUI

GPUI（Zed 自维护，Rust + GPU 直渲，无 DOM/CSS/HTML）解决的是**文本编辑器**的性能问题。本应用是带浏览器自动化与 Office 预览的文档工作台：上表所列依赖在 GPUI 下均无对应物，且 GPUI 生态与 Zed 强耦合。属于"用最大的工程量省不是最大的那块"。

## 优化排序

按"每 MiB 的代价"排序，而非按技术吸引力：

1. **CLI 泳道（约 830 MiB）** —— Rust CLI 可收回约 776 MiB；其中 plugin 泳道的 277 MiB 已由空闲回收拿回（见 `.agents/specs/cli-lane-idle-reclaim.md`）。
2. **Electron 固定成本（main 245 MiB + zygote 291 MiB RSS）** —— 只有 Native 重写能省，前提是第 1 项完成。
3. **renderer** —— 未测（需登录交互才能建窗口），但按趋势不会超过前两项之和。
4. **app.asar 体积** —— 可砍上限约 28 MB（`src/` 20.1 MB + world-atlas 7.9 MB，后者待确认是否 react-xlsx 必需），占 286 MB 的 10%。收益有限而打包过滤规则误伤风险高，不作为优先项。

## 审计方法论教训

本次审计出现两次假阳性，根因都是扫描不完整，记录以免复发：

- **判死依赖必须同时匹配静态 `from "x"` 与动态 `import("x")`**：`@larksuiteoapi/node-sdk` 经 `await import(...)` 被 Feishu bot provider 使用，初版 grep 只匹配 `from "..."` 而误判为死依赖。
- **扫描范围必须覆盖全部 workspace**：`vis-timeline` / `web-tree-sitter` 是 `apps/zcode-cli/packages/*` 的依赖，初版只扫了 `packages/ui/src` 与 `packages/desktop/src` 而误判。
- **asar 内容统计必须用 `@electron/asar` 解包后 `du`**，不得手写头部解析：手写解析在本次三次把 64KB 原始头部 JSON 打进 stdout。

## 验收场景

1. 引用资源数字时必须标明测量环境、口径（RSS/PSS）与是否为实测。
2. 任何"某依赖已死"的结论必须同时覆盖静态与动态 import、且覆盖全部 workspace 包。
3. 调整优化优先级时，必须说明相较本 spec 排序的理由与新的实测依据。
