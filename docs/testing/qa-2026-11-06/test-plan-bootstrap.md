# 外置项目前置与后续菜单专项测试

本轮首次菜单批次中，目录 `DEFAULT_WORKSPACE/ZCodeProject` 与旧 `lastWorkspaceSession` 存在，项目 SQLite 行却为空，导致依赖固定项目行的正式用例在 before 阶段被阻塞。保留原始批次的 BLOCKED 结果；后续使用外置 QA root hook，通过真实 UI 创建合成项目，再执行原正式 spec 与各自 replay。该准备动作不修复产品迁移，也不代表 BUG-004 已解决。

## 已确认原因与证据

当前 `wdio.conf.ts:1949` 的 `seedE2EStartupState` 写入本轮 `.zcodium/v2/setting.json`，默认分支 `lastWorkspaceSession` 明确包含 `{kind: "local", workspacePurpose: "project", workspacePath: <本轮HOME>/ZCodeProject}`。这是现有项目迁移接受的旧数据契约；`packages/services/src/project-storage/migrate-projects.ts:106` 仍只从 `settings?.lastWorkspaceSession` 建立本机初始项目。

桌面实际启动链路 `database-startup/hostDatabaseStartup.ts` → `storagePreparationProcesses.ts:40` 的 workerData 只传 path，`contract.ts:8` 严格 schema 也只接受 path，`tasksStorageWorker.ts:13` 没有迁移 settings。`packages/services/src/project-storage/startup.ts:110` 因而创建 `new TaskIndexRepo(undefined, undefined, path, ...)`；`session/taskIndexRepo.ts:406` 将空 `migrationSettings` 传入项目迁移。`project-storage/index.ts:44` 的 `0005_projects` 是一次性迁移，随后业务 Repo 不会再补建这些旧入口。精确源码出现位置保存在 [源链证据](logs/e2e-preflight-project-migration-source.txt)。

[只读合成 DB 快照](logs/e2e-preflight-project-migration-snapshot.json) 记录正确旧 settings、空 projects/project_roots、已经登记的 `0005_projects` 至 `0009_session_creation_commands` 和 local host。缺陷范围是已有旧工作区清单的首次项目迁移可见性；新用户无旧清单时空项目表符合预期。未读取真实用户数据，未认定用户文件或会话被删除，未进行 macOS 真机迁移验收。

## 启动方式

沿用 `run-menu-tests.ps1` 的完整路径、子进程、驱动与离线工具缓存隔离，在其 WDIO CLI 参数中追加：

```powershell
--mochaOpts.require=../../docs/testing/qa-2026-11-06/qa-project-bootstrap.cjs
```

WDIO 子进程 cwd/rootDir 为 `packages/desktop`。也可使用经过路径审查的绝对 `.cjs` 路径。不要把 canonical replay fixture 替换为 common，不开启 manual-review，不启动外部 SSH/Docker/WSL/模型 API。

pnpm 调用不能插入单独 `--`。本轮实际安装的 WDIO CLI/yargs parser 确认：其后 `--mochaOpts.require` 被当作位置参数，root hook 不会装载；去掉该分隔符后 require 为正确数组。[纯 parser 证据](logs/e2e-preflight-cli-options.json)。完整入口应为 `corepack pnpm --filter @zcode/desktop test:e2e --shards=1 --spec <spec> --mochaOpts.require=../../docs/testing/qa-2026-11-06/qa-project-bootstrap.cjs`，并沿用 runner 的全部隔离环境。

实际安装的 WDIO 9.32.0 / Mocha adapter 支持 require 的 root-hook plugin，但会用 `Object.assign(mochaOpts, plugins)` 覆盖现有 rootHooks。外置 [qa-project-bootstrap.cjs](qa-project-bootstrap.cjs) 的 `mochaHooks` factory 从框架初始化前 browser stub 的 `options.mochaOpts.rootHooks` 保存原函数，先运行原 renderer bridge preflight，再运行 bootstrap；缺少原 preflight 时立即拒绝。所有规范 spec 的 suite before 和 it 仍按原样执行。

## Bootstrap 的实际动作与写入边界

1. 验证 HOME、USERPROFILE、TEMP/TMP/TMPDIR、APPDATA、LOCALAPPDATA、Corepack/pnpm/npm/XDG 缓存、应用 HOME 和 artifact 全为当前工作树绝对路径。检查祖先链接、真实路径重定向；Windows 用只读 PowerShell 检查所有重解析点与目录后代。

   启动 wrapper 清空 inherited NODE_OPTIONS。WDIO 自己会注入工作树 `tsx/dist/loader.mjs` 的确切 file URL，local-runner 合并时可能重复两次；hook 只允许这同一 loader 1–2 次及至多一个 `--enable-source-maps`，核对 loader 祖先真实路径/reparse。任意其他选项、其他 importer、第三次注入均拒绝。该安全兼容通过 8 项纯分支求值测试，[证据](logs/e2e-preflight-bootstrap-node-options.json)；没有放开任意预加载。
2. 在已选择的 renderer 保存 `qa-project-bootstrap-onload.png`；通过现有职业引导 helper 跳过流程，并等待 `waitForWorkspaceApp(DEFAULT_WORKSPACE)`。保存 before 截图与只读 SQLite/settings/UI 摘要。
3. 若项目行缺失，真实 hover `project-section`，点击 `virtual-project-add`，输入 `virtual-project-name=ZCodeProject`。复用 `selectNativeProjectDirectories([DEFAULT_WORKSPACE])`，只 mock 原生 `dialog.showOpenDialog` 的用户选择；保留 renderer → preload → main 与项目 owner 的真实路径。
4. 点击 `virtual-project-save`；核对 `project-folder-trust-path` 只有本轮 DEFAULT_WORKSPACE，再点击 `project-folder-trust-confirm`。等待项目行出现及编辑器退出。
5. 只读核对新 owner 的 local project 与唯一指定 primary root，复用 `startDraftFromProject` 返回固定 cwd；保存 after JSON/截图。已有正确项目行可复用，发现其 root 与隔离目录不同则拒绝继续。

Hook 不安装依赖、不写原正式 test、不编辑产品、不直写项目表、不修改真实系统目录、不执行模型 prompt。UI 产生的项目/settings/session 工作区准备只在本轮应用 HOME 下发生。文件证据写入 `ZCODE_E2E_ARTIFACT_DIR/qa-project-bootstrap-<WDIO_WORKER_ID>-<invocation>-<pid>-<timestamp>-*`，每次 invocation 独立且独占创建；before JSON 同时记录对应 suite 名称和文件，before/after 都记录本模块装载时 QA source SHA256。

## Browser 独立的 Windows 测试合同问题

`browser-empty-state-deferred-guest.test.ts` 调用旧 `prepareConversationE2E`，其就绪检查看活动 cwd/pane，不要求项目行；因此它可进入 `openFirstBrowserTab`。后者 `browser-side-pane.ts:54` 固定派发 Alt+Meta+B，而默认命令 `packages/shared/src/shortcutCommands.ts:74` 为 CmdOrCtrl+Alt+B。`packages/ui/src/shortcuts/bindings.ts:152` 在 Windows 要求 Ctrl 且没有 Meta，这个合成事件必然不匹配。该错误不能直接合并为项目迁移缺陷。

Browser 专项在调用隔离 runner 前设置 `QA_BOOTSTRAP_OPEN_SIDE_PANE=1`。Hook 通过 `side-pane-toggle` 实际按钮展开空 launcher，并等待 `data-side-pane-open-tab-item="browser"` 或 add trigger。正式案例随后仍通过原 helper 打开空 logical tab，断言无 guest、地址草稿无 guest、回车导航本地 HTTP fixture 后唯一 guest。其它侧栏/面板测试默认不设置此变量，避免改变它们的初始状态。

## 建议下一批精确路径

以下路径相对 `packages/desktop`，单 shard，使用原正式 replay；同一批不设置特殊 Mocha grep：

```text
./test/e2e/conversation-session/conversation-session-plus-menu.test.ts
./test/e2e/conversation-session/conversation-session-project-composer.test.ts
./test/e2e/settings/settings-personalization.test.ts
./test/e2e/ui-shell/general-coding-mode.test.ts
./test/e2e/ui-shell/side-pane-tabs-responsive-interactions.test.ts
./test/e2e/ui-shell/side-pane-full-view.test.ts
./test/e2e/workspace-file-tree-refresh.test.ts
./test/e2e/task-list-archive-confirmation.test.ts
./test/e2e/git/git-commit-dialog-ui-flow.test.ts
./test/e2e/automations-create-manage.test.ts
```

Browser 单独一轮设置上述 side pane 初始展开变量，选择 `./test/e2e/browser-empty-state-deferred-guest.test.ts` 和 `./test/e2e/browser-tab-close-idempotent.test.ts`。含终端的用例仍需区分 PTY shell 命令能力；自动化用例完成后确认本轮定义被删除/暂停，不能由 bootstrap 代替验证。

`plugins/plugin-management-ui-market.test.ts` 未加入本轮：它第一步仍要求自动公有市场卡，再添加生命周期本地源，和当前 fork 无自动公有源的边界冲突。商店本地入口/风险确认/新增取消由外置本地菜单专项验证，不为测试恢复官方市场。

## 已执行的 bootstrap 验证

- `node --check docs/testing/qa-2026-11-06/qa-project-bootstrap.cjs`：exit 0。
- 实际 Mocha `handleRequires` 装载插件：beforeAll 数量为 2，首项保持原 preflight 函数，第二项为 bootstrap；未执行任何 hook/UI。[证据](logs/e2e-preflight-project-bootstrap-loader.json)。
- 使用本地 `tsx/esm/api.tsImport` 导入三个原 helper，隔离 HOME/缓存/临时根，exit 0；DEFAULT_WORKSPACE 指向本轮合成目录。[证据](logs/e2e-preflight-project-bootstrap-import.json)。

主测试进程的 `qa-menu-20261106-core-retry` 已实际通过原 renderer preflight、loader guard、真实项目菜单、native picker mock 与 trust 路径，plus-menu 开始进入案例；运行日志见 [core-retry](logs/e2e-qa-menu-20261106-core-retry.log)，后续正式案例结果由主报告汇总。Bootstrap 仅恢复合成测试前置，不修复项目迁移。

运行中发现 Mocha 在同一个 worker 多次调用 root hook，旧 worker-only stem 覆盖了首次 before。当前旧 [0-0 before](runtime/qa-menu-20261106-core-retry/evidence/qa-project-bootstrap-0-0-before.json) 已含一个项目、after.createdByBootstrap=false，不能拿它证明初始 empty。BUG-004 仍以此前独立只读空表快照与源码为依据。2026-11-06 15:53:22 UTC 只修正外置 QA 证据 metadata，增加 invocation/PID/timestamp、独占创建与装载源码 hash；已装载 worker 继续原模块，后续 worker 读取新命名方案。UI 动作和 guard 均未改变。[metadata 变更记录](logs/e2e-preflight-bootstrap-metadata-change.json)。
