# 2026-11-06 E2E 环境与运行边界

本文件记录本轮菜单专项测试的环境审查；实际 UI 用例结果以主测试报告和各 run 的 `summary.json` 为准。这里的「可运行」只表示已完成启动入口、文件目标和网络 fixture 审查，不表示用例已通过。

## 已确认环境

- 基线新鲜度检查 `node scripts/check-workspace-freshness.mjs --no-fetch` 通过：当前 `main` 与 `origin/main` 同步，ahead/behind 均为 0；远端刷新由主测试进程负责。
- 工作树 Node 为 `24.18.0`，满足 `package.json` 的 `>=24`，但不是 `mise.toml` 的 `24.14.0`。本轮结果必须记录这一差异。
- `corepack pnpm --version` 为 `10.33.2`，与仓库配置一致。
- Electron `44.7.0` 位于根 hoisted `node_modules/electron`；`path.txt` 指向 `dist/electron.exe`。`packages/desktop/node_modules/electron` 缺失不等于 Electron 缺失，WDIO helper 会再检查根目录。
- `node_modules/@wdio/cli` 为 `9.32.0`、`wdio-electron-service` 为 `9.2.1`、`@puppeteer/browsers` 为 `2.13.0`、`tsx` 为 `4.21.0`，`.bin/wdio.CMD` 可用。`require.resolve('@wdio/cli/package.json')` 被包的 exports 拒绝；这是探针使用错误，不是依赖缺失，应直接读取包目录的 `package.json`。
- 不使用 `mise dev`：其默认数据目录在项目外的用户 HOME。`mise` 和 `agent-browser` 不在当前 PATH；本轮使用仓库 WDIO/Electron 入口。

## 安全启动入口

仅在当前获准工作树运行。测试启动前，验证所有待写入、待删除目录的绝对路径与祖先，拒绝重解析点。若已有目录内包含链接，也应在任何递归清理前拒绝该目标。下列命令在新的 PowerShell 子进程执行，避免将隔离变量带入用户日常 shell。

```powershell
$qaRepo = 'C:\vibecoding\zcodium'
$qaRun = 'qa-menu-20261106'
$qaRoot = Join-Path $qaRepo 'docs/testing/qa-2026-11-06/runtime/menu-batch'
Set-Location -LiteralPath $qaRepo
function Assert-QaPath([string] $qaTarget) {
  $qaFull = [IO.Path]::GetFullPath($qaTarget)
  if (-not $qaFull.StartsWith($qaRepo + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Test target is outside the authorized worktree'
  }
  $qaCursor = $qaFull
  while ($qaCursor) {
    if (Test-Path -LiteralPath $qaCursor) {
      $qaItem = Get-Item -LiteralPath $qaCursor -Force
      if ($qaItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point in test target' }
    }
    $qaCursor = Split-Path -Path $qaCursor -Parent
  }
  if (Test-Path -LiteralPath $qaFull) {
    $qaQueue = [Collections.Generic.Queue[string]]::new()
    $qaQueue.Enqueue($qaFull)
    while ($qaQueue.Count) {
      foreach ($qaChild in Get-ChildItem -LiteralPath $qaQueue.Dequeue() -Force) {
        if ($qaChild.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point below test target' }
        if ($qaChild.PSIsContainer) { $qaQueue.Enqueue($qaChild.FullName) }
      }
    }
  }
}
$qaDirs = @('tool-home', '.e2e-home-qa-menu', 'tmp', 'appdata', 'localappdata', 'corepack', 'pnpm-home', 'npm-cache', 'cache', 'evidence', 'network', 'bin')
Assert-QaPath $qaRoot
foreach ($qaDir in $qaDirs) {
  $qaPath = Join-Path $qaRoot $qaDir
  Assert-QaPath $qaPath
  New-Item -ItemType Directory -Path $qaPath -Force | Out-Null
}
foreach ($qaRelative in @('packages/desktop/out', 'packages/desktop/.e2e-cache', 'packages/desktop/.e2e-artifacts', 'packages/desktop/bundled-agents', 'apps/zcode-cli/packages')) {
  Assert-QaPath (Join-Path $qaRepo $qaRelative)
}
$env:HOME = Join-Path $qaRoot 'tool-home'
$env:USERPROFILE = $env:HOME
$env:TEMP = Join-Path $qaRoot 'tmp'
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
$env:APPDATA = Join-Path $qaRoot 'appdata'
$env:LOCALAPPDATA = Join-Path $qaRoot 'localappdata'
$env:COREPACK_HOME = Join-Path $qaRoot 'corepack'
$env:PNPM_HOME = Join-Path $qaRoot 'pnpm-home'
$env:npm_config_cache = Join-Path $qaRoot 'npm-cache'
$env:XDG_CACHE_HOME = Join-Path $qaRoot 'cache'
$env:XDG_CONFIG_HOME = Join-Path $qaRoot 'tool-home'
$env:XDG_DATA_HOME = Join-Path $qaRoot 'tool-home'
$env:COREPACK_DEFAULT_TO_LATEST = '0'
$env:COREPACK_ENABLE_AUTO_PIN = '0'
$env:PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN = 'false'
$env:ZCODE_E2E_HOME_DIR = Join-Path $qaRoot '.e2e-home-qa-menu'
$env:ZCODE_DATA_BASE_DIR = $env:ZCODE_E2E_HOME_DIR
$env:ZCODE_DESKTOP_HOME_DIR = $env:ZCODE_E2E_HOME_DIR
$env:ZCODE_E2E_ARTIFACT_DIR = Join-Path $qaRoot 'evidence'
$env:ZCODE_E2E_NETWORK_CAPTURE_DIR = Join-Path $qaRoot 'network'
$env:ZCODE_E2E_CERT_CACHE_DIR = Join-Path $qaRoot 'cache'
$env:ZCODE_E2E_RUN_ID = $qaRun
$env:ZCODE_E2E_KEEP_HOME_ON_FAIL = '1'
$env:ZCODE_E2E_MAX_INSTANCES = '1'
$env:E2E_PROVIDER_HTTP_MODE = 'replay'
$env:ZCODE_ENV = 'production'
$env:ZCODE_E2E_HELP_MENU_FLAVOR = 'production'
Remove-Item Env:ZCODE_E2E_SKIP_BUILD, Env:ZCODE_E2E_SKIP_AGENT_BUILD, Env:ZCODE_E2E_MANUAL_REVIEW, Env:ZCODE_E2E_PACKAGED_APP_PATH, Env:ZCODE_PREVIEW_IDENTITY, Env:ZCODE_E2E_MOCHA_GREP -ErrorAction SilentlyContinue
$qaCorepack = (Get-Command corepack.cmd).Source
$qaShim = '@"' + $qaCorepack + '" pnpm %*' + [Environment]::NewLine
Set-Content -LiteralPath (Join-Path $qaRoot 'bin/pnpm.cmd') -Value $qaShim -Encoding Ascii
$env:PATH = (Join-Path $qaRoot 'bin') + [IO.Path]::PathSeparator + $env:PATH
corepack pnpm --filter @zcode/desktop test:e2e --shards=1 --spec './test/e2e/smoke.test.ts'
```

`COREPACK_HOME` 第一次使用会将已指定的 pnpm 版本缓存到工作树内；测试程序的 `pnpm` 子调用通过 shim 进入 `corepack pnpm`。不能让新的缓存默认落到真实用户目录。若需固定完全离线运行，应先在同一工作树准备工具缓存，再禁用 Corepack 网络；不能只设置离线并假定缓存存在。

WDIO 在加载配置后将 `HOME`/`USERPROFILE` 改为应用 HOME；构建子进程使用加载配置前的工具 HOME。TEMP、TMP、TMPDIR、APPDATA、LOCALAPPDATA 必须在启动 launcher 前设置，因为 Electron 二进制预检早于应用 HOME 覆盖，Chromedriver 在非容器模式使用 `tmpdir()` 缓存。不会运行 Linux 容器或 Linux 资源准备。

每个新 run 使用不同 run ID、应用 HOME、artifact 目录。失败时保留本轮现场，仅由当前 run 的进程 owner 回收其进程；不能按应用名清理用户已打开的桌面应用。

## 构建与旧产物

本轮实际运行以 [run-menu-tests.ps1](run-menu-tests.ps1) 的完整隔离环境为准，它还明确隔离 Node/tsx 与 npm userconfig/store cache、离线复用本树 Corepack/driver、清空 inherited NODE_OPTIONS。需要项目的菜单批次追加 `-Bootstrap`，见 [外置项目前置](test-plan-bootstrap.md)。pnpm 后不要插入单独 `--`：安装的 WDIO parser 会将其后 mochaOpts 当作位置参数，导致 require hook 未装载；[纯 parser 证据](logs/e2e-preflight-cli-options.json)。

`test:e2e --shards=1` 会先构建当前源码的桌面与 Agent JS bundle，不生成 installer。桌面构建仍会清理工作树内共享 `packages/desktop/out/{main,host,preload,renderer,scheduler,plugin-sandbox}` 与 ready markers，随后复制到 `packages/desktop/.e2e-cache/<runId>/app`。这份副本使用写时复制或普通复制，不能硬链接，以免类型检查改写共享 `out` 时破坏运行中测试。

2026-11-06 现存 `out` 包含不同时间产生的 bundle，不能设置 `ZCODE_E2E_SKIP_BUILD=1` 据此宣称当前源码已测试。正常 `pre-dev` 也会递归删除共享 `out`；已有运行中的 dev/E2E 不应并行使用共享输出。Agent build 会写当前工作树各包 `dist` 与 `bundled-agents`。子进程 HOME、缓存和临时根仍须隔离。

## 已审查的菜单专项 spec

以下路径均相对 `packages/desktop/`，通过 `--spec` 显式选择，避免默认全量误收 fork 已移除的云功能或远端环境用例。

| Spec | 可执行边界与限制 |
| --- | --- |
| `test/e2e/smoke.test.ts` | 本地默认工作区与 Composer；清理仅隔离 `.zcodium/v2`。 |
| `test/e2e/settings/settings-personalization.test.ts` | 本地个性化读写、保存/取消、大小限制与锁故障；实际文件从 `getE2EAppDataPaths().storageRoot` 派生，注释中的 `.zcode` 已过期。 |
| `test/e2e/settings/shortcut-settings-key-search.test.ts` | 本地组合键搜索、清除、空态与 Escape；无模型发送。 |
| `test/e2e/settings/shortcut-settings-rebind.test.ts` | 本地快捷键编辑与持久化；从 `appDataDir/setting.json` 读取。 |
| `test/e2e/settings/settings-window-size-persistence.test.ts` | 原生窗口 resize 触发当前 settings 写入；无模型发送。 |
| `test/e2e/ui-shell/command-center-focus.test.ts` | 本地 command center / project 对话框焦点和主题/窗口尺寸检查；artifact 在显式目录。 |
| `test/e2e/ui-shell/general-coding-mode.test.ts` | 本地模式菜单与终端；执行 `printf` 合成回执，依赖当前 PTY shell 支持此命令。 |
| `test/e2e/ui-shell/side-pane-tabs-responsive-interactions.test.ts` | 本地 tab、响应式和终端；启动带唯一 marker 的 Node 长进程，清理限定其 PID。 |
| `test/e2e/ui-shell/side-pane-full-view.test.ts` | 本地完整视图、拖拽、最小化和 Composer 草稿；`skipProvider: true`，不发送模型请求。 |
| `test/e2e/workspace-file-tree-refresh.test.ts` | 文件创建、改名、刷新、watcher 和关闭卸载；fixture 从 `DEFAULT_WORKSPACE` 派生。 |
| `test/e2e/task-list-archive-confirmation.test.ts` | 真实 runtime 任务创建与归档二次确认；强制 Provider replay。 |
| `test/e2e/automations-create-manage.test.ts` | 本地表单创建、编辑、暂停、恢复和删除；不主动发送 prompt。仍初始化 Provider 模型候选，必须使用 replay；本轮应在完成后检查无残留自动化。 |
| `test/e2e/plugins/plugin-management-ui-market.test.ts` | 隔离 HOME 内 directory marketplace、本地 stdio MCP/UI 沙箱；会发送准备 prompt，因此先 fixture audit 并强制 replay。 |
| `test/e2e/git/git-commit-dialog-ui-flow.test.ts` | `DEFAULT_WORKSPACE` 内合成 Git repo 的 init/config/add/commit/branch 与弹窗键盘流；不 push；准备任务需要 replay。 |
| `test/e2e/browser-empty-state-deferred-guest.test.ts` | Browser 空态到单 guest；只导航本例 `127.0.0.1` HTTP fixture。 |
| `test/e2e/resource-manager-storage.test.ts` | 隔离 `.zcodium` 下合成 cli/debug、backup、v2/logs；产品清理动作只作用于本轮夹具，不能以真实用户数据运行。 |

## 已确认的测试合同漂移

| Spec / 位置 | 证据与报告方式 |
| --- | --- |
| `ui-shell/command-center-selection.test.ts:41` | 直写 `HOME/.zcode/v2/tasks-index.sqlite`；当前产品数据根为 `.zcodium`。另要求 HOME basename 以 `.e2e-home-` 或 `zcode-command-center-` 开头。现状前置失败不能证明重名任务 UI 有 bug。 |
| `settings/settings-language-system-default.test.ts:24,116` | 读写 `homedir()/.zcode/v2/setting.json`，产品实际读取 `.zcodium/v2`。英文准备与最终 settings 断言观察了错误文件，标为 fixture drift。 |
| `settings/settings-subagent-create-edit-persistence.test.ts:88` | 用户 root 已使用正确 helper，但 workspace profile 断言读 `.zcode/agents`。当前 `packages/services/src/subagents/subagentStorage.ts` 与 CLI 主写 `.zcodium/agents`；workspace 子场景不能作为有效通过/失败证据。 |
| `help-menu-about.test.ts:95-116,183-199` | 默认预期 Preview、旧 `About ZCode` 菜单、旧 `zcode-logs-*.zip`。当前 fork 为 ZCodium，安全导出实际为 `.zcodium/export-log/zcodium-diagnostics-*/diagnostics.zip`。生产测试虽可设置 flavor，菜单/归档断言仍过期。 |
| `conversation-session/conversation-session-task-groups.test.ts:500` | 仅 `GRP10` 千行子场景直写 `HOME/.zcode/v2/tasks-index.sqlite`。普通分组菜单通过当前 Host RPC owner 保存；千行子场景须列为 fixture drift，不能归入有效列表性能覆盖。 |
| `conversation-session/conversation-session-v4-composer-toolbar.test.ts:57` | 自定义 slash fixture 写 `HOME/.zcode/commands`；当前公开 command 主来源为 `.zcodium/commands`。模型/思考/模式菜单子场景不依赖该自定义命令；自定义目录水合场景存在漂移，应独立报告。 |

这些是源码审查确认的测试基础设施欠账，未经真实 UI 重现不能写为已确认产品缺陷。保留现有测试原断言与运行证据，不修改生产代码或通过测试绕过 fork 审计边界。

## 后续 15 个菜单与功能代表 spec

以下均沿用前文完整隔离环境，必须设置 `E2E_PROVIDER_HTTP_MODE=replay` 和 `ZCODE_E2E_MAX_INSTANCES=1`；没有标注特殊 grep 的批次须先清除 `ZCODE_E2E_MOCHA_GREP`。`replay` 只连接本例 loopback Provider，不使用真实 API Key。正式目录显式选 spec；不设置 `ZCODE_E2E_MANUAL_REVIEW`，不运行 SSH/Docker/WSL/远端安装。

所有路径相对 `packages/desktop/`，适用于 `corepack pnpm --filter @zcode/desktop test:e2e --shards=1 --spec '<path>'`。不同 grep 过滤器应分别运行，避免其它 spec 被错误地全部 skipped。

| 精确 spec 路径 | 功能代表、初始化写入和必要限制 |
| --- | --- |
| `./test/e2e/conversation-session/conversation-session-plus-menu.test.ts` | `+`、Goal、Workflow、Plugin mention、Escape、宽窄视口。只修改草稿；本地内置插件 catalog 与空 Provider 请求证据，不发送 prompt。 |
| `./test/e2e/conversation-session/conversation-session-project-composer.test.ts` | 虚拟项目新增、目录搜索、选择、改名同步与删除。仅通过 UI 写隔离项目索引/settings；不需要模型发送。 |
| `./test/e2e/conversation-session/conversation-session-task-groups.test.ts` | 分组/时间线菜单、创建、改名、改色、置顶、归档、恢复、拖拽。普通场景复用本地 Window Host RPC；组内首发需要 replay。使用 `ZCODE_E2E_MOCHA_GREP=^(?!.*GRP10).*$` 排除已确认旧 `.zcode` 数据库夹具；明确记录千行覆盖未执行。 |
| `./test/e2e/conversation-session/conversation-session-v4-composer-toolbar.test.ts` | 模型、思考深度、模式菜单、互斥弹层、模型管理导航、完成态 picker。使用 `ZCODE_E2E_MOCHA_GREP=模型选择器/思考深度/模式切换\|合并模型/思考弹层\|模型管理入口\|completed task 的 picker`；这里竖线为正则 alternation，实际环境变量不加反斜线。before 只在隔离 HOME 创建 slash 文件，所选场景不依赖自定义 slash 水合。建立 completed task 走本例 replay。 |
| `./test/e2e/conversation-session/conversation-session-first-send.test.ts` | 首发、Composer 清空、session 建立、完成态和同 session 第二轮。在 `DEFAULT_WORKSPACE` 创建只读工具文本夹具；真实 runtime 工具读取这份合成文件，模型请求走 replay。 |
| `./test/e2e/conversation-session/conversation-session-v4-stop-queue.test.ts` | running 入队、stop 保留队列、暂停提示、发送确认、keep/clear、FIFO 恢复。case-local `controlled-stream` 必须保留，不能改成快速响应；只写隔离 session/queue 持久化。 |
| `./test/e2e/conversation-session/conversation-session-v4-queue.test.ts` | 队列删除、撤回编辑、图片恢复、重新发送与排序。case-local `controlled-stream`；图片由合成 paste 经本地 attachment RPC 保存，afterEach stop 回收运行态。 |
| `./test/e2e/conversation-session/conversation-session-v4-attachment.test.ts` | 仅附件首发、图片预览、编辑删除附件、active branch 与请求一致。合成 PNG 通过本地 begin/chunk/commit 写隔离 CLI artifacts；图片预览从本地 artifact 生成 Blob URL。 |
| `./test/e2e/conversation-session/conversation-session-v4-attachment-layout.test.ts` | Composer/sent/edit 附件布局、文件名省略、context、移除、主题与窄窗口。合成文件走本地 attachment RPC；`https://e2e.example.test/page` 只是 context 文本，不执行导航。 |
| `./test/e2e/conversation-session/conversation-session-v4-edit.test.ts` | 首发、compact 后编辑、同 session branch cut、旧分支退出。所有会话、compact 结果与新模型回复均使用隔离持久化和本例 replay。 |
| `./test/e2e/conversation-session/conversation-session-v4-rename.test.ts` | 侧栏右键重命名和标题投影。建立合成任务后仅修改隔离 session 元数据；模型发送使用 replay。 |
| `./test/e2e/conversation-session/conversation-session-v4-fork.test.ts` | 完成态 assistant Fork、child session、父历史、模型与思考档位继承。创建本例 Personal GLM-5.2 Provider，其 endpoint 来自已启动 replay；冷重启保留隔离 profile。 |
| `./test/e2e/conversation-session/conversation-session-workspace-file-search-filter.test.ts` | `@` 文件搜索：隐藏目录可搜、build 可搜、node_modules/.env 排除。只在 `DEFAULT_WORKSPACE` 创建 `.github/workflows`、`build`、合成 `node_modules` 与 `.env.*`，按本例 `createdPaths` 删除自己的文件；不发送 prompt。 |
| `./test/e2e/conversation-session/conversation-session-preview-image-actions.test.ts` | 图片右键另存为、取消、字节一致性和添加文件引用。源/目标均在 `DEFAULT_WORKSPACE/.zcode-e2e/image-actions`；`showSaveDialog` mock 固定同目录 `saved-*`，不使用真实下载目录。显式设置 `E2E_IMAGE_ACTION_SCREENSHOTS=<当前 run artifact>/images` 并验证该路径，防止继承其它输出目录。 |
| `./test/e2e/browser-tab-close-idempotent.test.ts` | 空 Browser tab 打开、关闭、重复关闭 IPC 成功。只创建本地逻辑 tab，`skipProvider: true`，不导航外站。 |

可替代的纯本地预览检查为 `./test/e2e/preview-pane-image-copy.test.ts`：显式设置 `E2E_IMAGE_COPY_SCREENSHOTS` 到本 run artifact，生成合成 SVG/PNG，验证原生剪贴板中的图片尺寸。该例会清空并改写当前 OS 剪贴板，必须在根测试进程选择适当时机执行，结果不能替代 Browser 导航验证。

未列入安全本地批次的两个 fixture checker 通过 spec：

- `conversation-session-settings-connection-completion.test.ts` 的 309 行后读取 `readSSHRuntimeConfig` 与 `ZCODE_E2E_SSH_CONTAINER`，418/428 行实际拨号，后续执行真实 SSH/Docker 连接与代理。空模型 fixture 通过不代表该网络场景可在本轮环境运行，保留环境受限。
- `conversation-session-model-provider-settings-transition.test.ts` 依赖已退休的官方 BigModel OAuth/Team Plan 设置与合成账号 credential。当前 fork 菜单回归不恢复这些产品入口；先作为合同漂移候选审查，不把该 spec 的静态 replay 合同视为可安全覆盖官方账号功能。

## 确认缺陷：macOS 默认开发入口引用未定义变量

`scripts/dev-desktop-env.mjs:23` 定义 `hasComputerUseHelperProducer`，26 行用其选择 Helper 环境；105 行却使用 `hasComputerUseProducer`。全文件该错误标识符只出现一次，没有声明或导入。macOS 平台条件为真后读取未定义变量，触发 `ReferenceError`；随后外层 catch 打印错误并退出 1，因此在执行 `pre-dev`、Agent 构建与应用启动前失败。Windows 条件短路，不会暴露此错误。

将源文件 105 行的精确条件放入 Node VM，只提供 `process.platform` 与实际声明名 `hasComputerUseHelperProducer`，得到以下结果：

| 分支求值 | 实际结果 |
| --- | --- |
| synthetic platform = `darwin` | `ReferenceError: hasComputerUseProducer is not defined` |
| synthetic platform = `win32` | `false` |

这证明了当前源代码的分支缺陷，不是假定已在 macOS 真机测试。没有运行 mac 构建、安装、打包或产品代码修改。源码出现位置证据为 `logs/e2e-preflight-macos-dev-source.txt`，精确条件与 VM 结果为 `logs/e2e-preflight-macos-dev-branch.json`。

修复后验收：统一探针引用；在 Helper producer 已安装与未安装两个状态验证 mac 分支求值和调度，不恢复本 fork 已拒绝的 Helper/Linux 依赖；随后在 macOS 获准工作树隔离 HOME/临时根，运行 `corepack pnpm dev:desktop:test`，确认通过 pre-dev、当前源码 Agent 构建与 Electron 主窗口就绪。Windows 默认入口也应回归。真机启动仍为待验证项。

## 证据与验证范围

环境与 fixture 审查证据保存在本目录 `logs/e2e-preflight-*`。Fixture checker 只读取正式或 pending conversation-session/plugin spec、manifest 和 JSON response；不启动 Electron、不构建、不调用真实 Provider，也不会写产品数据。Fixture audit 通过仅证明静态 replay 合同一致，不等于 runtime 回放通过。

本次实际执行了 6 个 fixture check，均 exit 0：`plugin-management-ui-market`、`conversation-session-plus-menu`、`conversation-session-v4-composer-toolbar`、`conversation-session-task-groups`、`conversation-session-model-provider-settings-transition`、`conversation-session-settings-connection-completion`。其中插件标题旁路和部分不发送模型请求的 UI marker 存在 checker warning，原始输出已保留；没有把 warning 写成无警告通过。

后续候选又实际执行 11 个 fixture check，均 exit 0：`project-composer`、`first-send`、`v4-stop-queue`、`v4-queue`、`v4-attachment`、`v4-attachment-layout`、`v4-edit`、`v4-rename`、`v4-fork`、`workspace-file-search-filter`、`preview-image-actions`（名称均有 `conversation-session-` 前缀）。累计 17 个静态合同检查；所有输出保存在 `logs/e2e-preflight-fixture-*.txt`。没有执行 UI，不能因此将任何新增候选写为已覆盖。

本审查没有执行 UI 测试、安装、打包、Git 提交或推送；实际 UI 运行由主测试进程执行。Mac、SSH、Docker、WSL、手机 shared-host、真实模型 API、普通 MCP OAuth 和外部平台登录需要各自获准环境与专项证据，本轮不能由 Windows 本地菜单回放推断覆盖。
