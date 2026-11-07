# 下一批 canonical 本地/replay 验证

2026-11-06 16:05 UTC 只读预检已完成。`logs/e2e-preflight-next-batches.json` 用 TypeScript AST 核对标题筛选：基础 5 specs/17 it，扩展 10 specs/23 it，Browser 5 specs/5 it。6 个 conversation fixture checker 均 exit 0。检查仅证明文件、fixture 合同和路径准备可用，不是 UI 测试通过。

root 是唯一桌面测试执行者。前一批退出并确认本批身份无残留进程后串行运行，禁止并行构建/启动。沿用 `run-menu-tests.ps1` 的当前树内 HOME/TEMP/APPDATA/缓存、固定驱动、offline Corepack、fresh E2E 编译、replay、maxInstances=1 和 bootstrap。不要加 pnpm 独立 `--`，不要覆盖 canonical `E2E_PROVIDER_REPLAY_FIXTURE_PATH` 为 common。

## 精确命令

从 `C:\vibecoding\zcodium` 的 PowerShell 执行扩展批：

```powershell
$qaSelection = Get-Content -LiteralPath 'docs/testing/qa-2026-11-06/logs/e2e-preflight-next-batches.json' -Raw | ConvertFrom-Json
$qaFilteredSpecs = ($qaSelection.extended.spec -join ',')
& .\docs\testing\qa-2026-11-06\run-menu-tests.ps1 -RunId qa-menu-20261106-filtered -Bootstrap -OpenSidePane -Specs $qaFilteredSpecs -Grep $qaSelection.fullGrep
```

仅基础 5 specs/17 it：把 Specs 改为 `($qaSelection.base.spec -join ',')`，Grep 改为 `$qaSelection.baseGrep`，使用独立的新 RunId。

扩展文件依次为：

1. `./test/e2e/conversation-session/conversation-session-task-groups.test.ts`
2. `./test/e2e/conversation-session/conversation-session-v4-composer-toolbar.test.ts`
3. `./test/e2e/settings/settings-subagent-create-edit-persistence.test.ts`
4. `./test/e2e/ui-shell/general-coding-mode.test.ts`
5. `./test/e2e/settings/shortcut-settings-key-search.test.ts`
6. `./test/e2e/ui-shell/side-pane-full-view.test.ts`
7. `./test/e2e/conversation-session/conversation-session-ask-user-question-custom-enter-single-question.test.ts`
8. `./test/e2e/conversation-session/conversation-session-ask-user-question-keyboard-navigation.test.ts`
9. `./test/e2e/conversation-session/conversation-session-tool-detail-toggle-stability.test.ts`
10. `./test/e2e/conversation-session/conversation-session-tool-actions.test.ts`

Browser 批串行另起：

```powershell
$qaSelection = Get-Content -LiteralPath 'docs/testing/qa-2026-11-06/logs/e2e-preflight-next-batches.json' -Raw | ConvertFrom-Json
$qaBrowserSpecs = ($qaSelection.browser.spec -join ',')
& .\docs\testing\qa-2026-11-06\run-menu-tests.ps1 -RunId qa-menu-20261106-browser -Bootstrap -OpenSidePane -Specs $qaBrowserSpecs
```

Browser 文件：`./test/e2e/browser-empty-state-deferred-guest.test.ts`、`./test/e2e/browser-tab-close-idempotent.test.ts`、`./test/e2e/browser-permission/browser-permission-site-settings.test.ts`、`./test/e2e/browser-human-viewport-preference.test.ts`、`./test/e2e/browser-tab-residency.test.ts`。

## 写入与运行边界

19 个目标（15 spec、新 run runtime、desktop `.e2e-artifacts`、logs）已经只读审查所有现存祖先/子项无 reparse point。runtime 尚未启动；执行时 wrapper 与 bootstrap 再审查。缺失目录按当前树内目标创建，不能删除旧 runtime、用户数据或既有截图。SC-13 直接写 `packages/desktop/.e2e-artifacts/shortcut-settings-${theme}-${width}.png`，root 必须在再审查后创建 `.e2e-artifacts`；这些既有 spec 的固定截图名可能覆盖同名 QA 截图，应先记录已有文件或为本次证据建立只读引用，不能把它们算独占命名。

过滤排除 GRP10 旧 `.zcode` SQLite、workspace subagent SE01、官方插件 SE04、MODE02/03 PTY。toolbar 的 before 仍向隔离 HOME 下 `.zcode/commands` 写一个合成 markdown，after 只删除该文件；已排除依赖它的旧 slash 合同。当前测试只读/写合成 `.zcodium/agents`、settings、localStorage、会话和分组目录。GRP 用部分 IPC 读取/置顶/归档，是对应层级证据，不全称为菜单鼠标验收。

Ask 两项无独立文件 I/O，真实键盘问答只请求本地 replay。Tool action/detail 两项把 1/2 个合成 txt 写到 `HOME/ZCodeProject/.zcode-e2e/<case>`；replay 发 Read 工具，没有 Bash/外网命令。清理仅 case 根。其递归删除依赖启动前完整路径/reparse 审查，不能复用未知旧 HOME。SPFV001 创建本地 Terminal tab，但不向终端发送命令；启动 cwd/用户目录必须继承隔离配置。

Browser HTTP fixtures 仅 bind `127.0.0.1` 随机端口，静态 HTML 无外部资源。权限页只改合成 origin 的 geolocation allow/reset 并执行 `permissions.query`，不获取真实位置；camera/getUserMedia spec 不纳入。residency 验证 33 logical tab 与 1 reusable guest，经真实 Main IPC 注册/脱离，不能称 32 真 guest 压测。

Browser viewport 和 residency 均使用保留 profile 的真正 Electron 冷重启及现有进程退出屏障。当前 core 的 SC90 冷重启曾退出屏障失败，原因仍由 validation 审查；这两项可能 BLOCKED，不能绕过屏障或把新 profile 当恢复通过。`-OpenSidePane` 仅准备首次启动；重启后仍需实际等待原 helper 的入口恢复，旧 Windows 热键风险仍要区分测试前置与产品。

## SPFV002 现场证据接入

`test-plan-spfv-observation.md` 先于实现写入。2026-11-06 16:07 UTC 添加外置 `qa-spfv-observer.ts`，bootstrap 仅追加受限 afterEach，不修改既有 before/UI/guard。只匹配精确 canonical 文件和 SPFV-E2E-002，写独占命名 DOM JSON/PNG，不操作 UI。

`logs/e2e-preflight-spfv-observer.json`：TypeScript noEmit 0 diagnostics，本地 tsx import、原 beforeAll 保留、afterEach 注册、两种非目标 guard 0 UI 调用；`node --check qa-project-bootstrap.cjs` exit 0。尚未执行目标现场 observer。源 SHA：observer `b1ef292c325f92b8ae1fd4e69309afecb68f455053426fe05330fe99d0306c59`；bootstrap `5b8787ba3da7c0ddfb169e755ce932aed91afb748bcdb7b89dbec3c1abc0f562`。运行中已加载旧 hook 的 worker 不受影响；以后 worker 读取新版本，应以每份证据记录的 SHA 为准。

## 当前 replay 日志结论

`logs/e2e-qa-menu-20261106-core-retry.log`：first-send line 61467 PASS，stop-queue line 86501 PASS，queue line 98957 PASS。line 86499 的 destroyed-stream warning 在 stop-queue 结束时出现，不能归因为模型合同漂移。`upstream-replay-server.ts:1016` 继续写定时 chunk，`:1115` 的 response.write 在连接已销毁时 reject；这是取消连接后仍写入的 replay harness 诊断线索，尚未逐请求证明该 warning 对应哪个 chunk。

最小配置方案就是保留 wrapper replay 与各 canonical case-local fixture；不用真实 API、不改 common、不修改产品。只有后续请求记录出现 matcher miss/未覆盖请求/错误 token 时再按具体 request 与 case manifest 诊断。首次发送与停止队列现在无需修正测试配置。
