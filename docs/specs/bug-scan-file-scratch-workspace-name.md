# 缺陷扫描：scratch workspace 名称的点段逃逸

## 范围与基线

- 目标目录 `packages/services/src/file`（第 1 轮扫描，除 `workspaceFileSearch.ts` 的干净源文件）。
- 保留所有既有未提交改动；不修改 `workspaceFileSearch.ts` 与 `shared/workspaceFileSearch.ts`，不提交、不推送、不构建。
- Node 固定为项目内 24.14.0（`.run-logs/project-only-validation/main-toolchain-6g2BTX/node-v24.14.0-win-x64/node.exe`），测试经 `scripts/ci/source-test-runner.mjs` 的 `runSourceTests` + `createProjectTestSandbox` 执行，HOME/USERPROFILE/TEMP 全部重定向到 `.run-logs/project-only-validation/source-tests-*` 并以 `--permission --allow-fs-write=<sandbox>` 限制写入，不触及真实用户目录。

## 缺陷与复现

`createScratchWorkspace`（`fileService.ts`）用 `validateScratchWorkspaceName` 校验名称，只拒绝空名与含 `/`、`\` 的名称，然后 `join(homedir(), "ZCodeProject", name)`。名称 `..` 与 `.` 不含分隔符、全部通过校验，但 `path.join` 会做路径规范化：

- `name = ".."`：`join(<home>, "ZCodeProject", "..")` 规范化为 `<home>` 本身。`mkdir(recursive)` 对已存在目录幂等成功、`stat` 确认是目录，方法把**用户主目录**当作新建的 scratch workspace 返回。
- `name = "."`：规范化为 `ZCodeProject` 根，返回的是**全部 scratch 项目的父目录**而非空工作区。

调用链：空态菜单 → `useRootWorkspaceActions.handleCreateScratchWorkspace`（`packages/ui/src/root/useRootWorkspaceActions.ts`）把对话框输入原样 `createScratchWorkspace({ name })` 透传，服务层是唯一守卫；桌面与 Web 共用该 `IFileService` 实现。用户（或远程渲染端的畸形请求）输入 `..` 即可让"从空项目开始"直接打开整个主目录。

复现（沙箱子进程内）：`createFileService().createScratchWorkspace({ name: ".." })` 返回 `homedir()`，不抛错；`{ name: "." }` 返回 `ZCodeProject` 根。修复后两者必须以参数错误拒绝。

## 契约与修复

- 唯一所有者不变：`FileService` 仍是 scratch workspace 目录创建的唯一生产者；不新增状态、缓存或第二条创建路径。
- 名称契约收紧一处：合法名称必须是单个真实目录名——非空、无路径分隔符、且不等于 `.` / `..`。其余输入（大小写、点前缀、空格等）行为逐位不变；`createDefaultWorkspace` / `ensureConversationWorkspace` 不消费该名称，不受影响。
- 修复位置：`validateScratchWorkspaceName` 追加点段拒绝分支，抛同类参数错误。不做保留设备名（`NUL`、`CON` 等 Windows 名称）过滤——那属于平台名称策略的重新设计，本轮只报告不改。

## 验收

- 回归测试 `packages/services/test/bugScanFileScratchWorkspaceName.test.ts`（node:test，4 用例）：`..` 拒绝、`.` 拒绝、分隔符拒绝（既有守卫回归位）、合法名在沙箱 HOME 下创建 `<home>/ZCodeProject/<name>` 且返回路径仍在 scratch 根内。
- 旧实现必须先失败（`..`、`.` 两用例），修复后 4/4 通过；CI 入口 `scripts/ci/bug-scan-file-scratch-workspace-name.test.mjs` 以确切计数断言。
- `corepack pnpm architecture:check --changed` 无新增违规；根 typecheck / lint 由父代理统一执行。

## 扫描中已核对但不成立的候选（证据）

- `ignore@5.3.2` 规则解析对 CRLF、首行 BOM 后的规则行均正常生效；其模式正则带 `i` 标志（`node_modules/ignore/index.js` `new RegExp(source, 'i')`），默认模板的小写 `pods/`、`cmakefiles/` 等仍能剪枝 `Pods`、`CMakeFiles`、`DerivedData` 混合大小写目录，"与旧默认一致"的注释承诺未被破坏。
- `readTextFile`/`readFileRange` 的 NaN offset 会落到 `Buffer.allocUnsafe(NaN)`，但当前 UI 调用方全部传有限整数（`PreviewPane.tsx` 固定 0 / 累加整数），无真实触达证据，不改。
- `loadWorkspaceFileSearchIgnoreRules` 的降级链（读取失败→.gitignore→内置模板）实测覆盖 ENOENT/EACCES；`transformWorkspaceFileSearchIgnore` 把读取错误吞成 `null` 再重建属于设计取舍，报告不改动。

## 复现与修复结果

- 旧实现回归 **2 失败 / 2 通过**：`..` 与 `.` 用例实测 `Missing expected rejection`（`createScratchWorkspace` 直接返回逃逸路径，不抛错）；分隔符守卫与合法名对照通过。逃逸写入发生在沙箱子进程内（HOME 被重定向且 `--permission --allow-fs-write=<sandbox>` 下 mkdir 成功），反证真实主目录未被触碰。
- 修复后回归 **4/4 通过**：`..` / `.` 以 `Workspace name cannot be a relative path segment.` 拒绝；`a/b`、`a\b`、空白名维持原错误；合法名仍在 `<sandbox-home>/ZCodeProject/demo-scratch` 创建并返回。
- 生产文件仅 `packages/services/src/file/fileService.ts`，**新增 5 行**（校验函数一个拒绝分支 + 中文注释），无接口、状态所有者、依赖方向或持久化变更。
- `corepack pnpm architecture:check --changed`：violations / baseline / new = **0 / 0 / 0**；`services` 模块 `managed: false`，无契约文件可读，`IFileService`（`file.ts`）即公开边界，本次未改动。
- 根 typecheck / lint 由父代理统一执行，本 worker 未跑全仓检查。

可重跑命令（仓库根目录，项目内 Node 24.14.0）：

```powershell
.run-logs/project-only-validation/main-toolchain-6g2BTX/node-v24.14.0-win-x64/node.exe --test scripts/ci/bug-scan-file-scratch-workspace-name.test.mjs
corepack pnpm architecture:check --changed
```
