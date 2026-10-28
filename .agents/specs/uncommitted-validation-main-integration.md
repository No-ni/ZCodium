# 未提交成果验证与主线整合（2026-10-28）

## 本轮授权与范围

用户明确要求：核验原性能工作树和 `zcodium-adopt-3.16.2` 的未提交成果，修复检查中发现的明确问题，提交并将性能分支合入 `main`。允许子代理协助，任一时刻最多三个；主代理负责最终验收与 Git 操作。本轮授权取代旧交接中「不提交、不派子代理、原工作树只读」的阶段限制，但不授权推送、发行、打包、安装系统服务或操作真实用户数据。

两工作树初始 HEAD 相同，均为 `18cc72cef7bec53eaa543b515e0c9332bc9cd05b`；`main` / `origin/main` 为 `62f10852`，没有分叉。盘点确认吸收树包含原树全部有效改动，原树另有两个不属于项目的 shell 残留文件，不提交、不擅自删除。整合不覆盖未知文件、不使用强制 checkout/reset、不修改官方快照。

## 状态所有者与整合顺序

- Git 的唯一操作 owner 为主代理。子代理仅在分配的源码/spec/test 分区内审查与修复，不 stage、commit、merge 或 push。
- 验证目录、home/temp/data/cache 的唯一 owner 为 `scripts/ci/project-test-sandbox.mjs`，只创建项目内 fresh 目录，保留日志与合成 fixture，不递归清理运行根。
- UI 验证只启动 loopback Vite 和使用现有浏览器或既有 Electron executable 的独立项目内 profile。Vite 禁止自动依赖发现，仅预编译 fixture 所需的固定依赖，不连接用户桌面 Agent 或真实服务。保留 Vite 8 CSS runtime 需要的一条同源 idle WebSocket，`hmr:false`/`watch:null`不做热更新；请求守卫规范化ws/wss为http/https后仍严格校验同一host/port，不允许外域WebSocket。合成外壳的数值尺寸显式设置，不能依赖产品 Tailwind 仅扫描 src 时缺席的 test 目录类名；产品内组件继续使用实际样式。
- Browser fixture 对全局环境持有独占 lease，未关闭前拒绝第二个 fixture；sandbox 无上层绑定时创建于中央验证根，已有绑定时创建于原绑定根的 `children`，验收断言须从启动前的环境确定该父目录。关闭后恢复原环境，下一次不得嵌套进已关闭 fixture。实际监听地址由 HTTP server 的已绑定端口确定，不依赖配置端口或展示 URL。Electron 先加载空白页，安装同源请求守卫与错误监听后才导航到 fixture。当前 Electron 41/Playwright 1.59 的 Fetch route 会使同源导航 `ERR_FAILED`（合成 HTML/模块控制组已复现）；Electron 使用 `session.webRequest.onBeforeRequest` 原生守卫，Chromium 使用 `context.route`，两者同一同源规则，不放宽为外部请求。
- 验收首先保存原始失败诊断，再尝试附加页面文本/截图；捕获或关闭失败只作为次级错误，不替换首个失败。隐藏 Electron 窗口没有可截图的 compositor surface（两配置控制组均复现），几何/截图验收显示自己创建的合成窗口但不抢焦点，不使用真实用户窗口。关闭 HTTP 活动连接并等待 server 的实际关闭，再恢复环境/释放 lease。关闭期限超出必须失败，未实际关闭前不得复用环境；期限只限制退出，不能替代产品状态同步。
- 完整视图仍使用原会话/editor owner；菜单仍使用原 draft config owner；Source、SQLite、CommandInbox 和两种远控交付语义不改变。

```text
两树路径/内容盘点 -> 原树有效成果提交到 perf
                 -> 吸收树独立分支审查、回归与修复
                 -> 门禁与产品 fixture 验收 -> 提交择项吸收
                 -> merge 吸收分支回 perf，逐文件保全原提交
                 -> 合入 main -> main 复核，记录真实结果
```

```text
项目路径/重解析点校验 -> fresh sandbox owner
  -> 受控子进程环境 -> Vite 显式 entry + 项目缓存
  -> 项目 browser profile + loopback-only requests
  -> 真实组件交互/节点身份/草稿/焦点断言
  -> close 自己创建的浏览器和 server -> 保留结果，不清理整根
```

## 验收与失败边界

1. 根与 CLI 类型检查、根 Lint、格式、架构、registry 和定向测试均实际运行；CLI 全包 Lint 与初始 HEAD 比较，分别报告既有与新增诊断，不放宽规则或更新 baseline。
2. UI fixture 覆盖完整视图往返、同一 Lexical 节点/草稿保留、最小化与阻塞请求、模型/思考菜单上下文与窄屏边界。静态/mock/fixture 不写成安装版或真机验收。
3. Source 历史数据安全接入仍未完整实现，保持 fail-closed；不以客户端布尔、重复 hash 或跳过 snapshot 证明替代真实停写租约，不扩大本轮实现范围。
4. 不运行不能证明写入范围的旧系统 TEMP/full-ci corpus，不读取真实 `.zcodium`。缺依赖时不安装、不下载；对应验收明确标为未执行。
5. 不声称绝对无 bug，也不把既存 Lint 失败或未完成产品闭环写成通过。提交只在新增明确回归修复、根门禁通过和现有失败有基线证据后进行。
6. 提交前展示中文文案。缓存、日志、编译产物、真实数据及 shell 残留不进入提交；推送与发行保持未执行。

## 实际执行结果

### 本地 Git 与保全

- 原树有效 161 路径已提交为 `23050742b41c3abd7ade16f161c11b4e0891b6a7`（收口官方依赖审计与本地诊断、字体维护修复），仍未推送。
- 吸收树已建立 `sync/official-3.16.2-integration`，初始 HEAD 为 `18cc72ce`。提交前复核原提交的 126 路径字节相同、8 个删除保留、27 路径为吸收后的有意扩展，未发现原成果丢失或官方依赖复活；这是路径/源码保全，不是全量行为等价证明。
- 最后候选 695 路径与旧清单完全一致（321 修改、8 删除、366 新文件）；中央项目内 `final-inventory-mHN8zx` 有界复核未发现敏感文件、路径链接或额外未知二进制。Office 五份二进制均为生成脚本对应的合成 fixture，许可原件保留。缓存、日志、dist、数据库/sidecar 不进入候选。最终提交、合并及主线复核在完成后另记，不能将尚未完成的步骤写成通过。
- 精确暂存后，完整 `git diff --cached --check` 仅对 `cjk.pdf` / `paper.pdf` 的 PDF 格式空格报尾随空白（现有 `astextplain` 属性使 Git 将 PDF 当文本）；未改格式属性或 PDF 字节。两份 staged blob 与磁盘逐字节相同、hash 不变，其余693路径的空白检查通过。此结果不写成完整检查 exit0。

### 已核准的实际验证

Windows Node `24.18.0` / pnpm `10.33.2`；仓库 pin `24.14.0`，未切换工具链，非 macOS/固定小版本验收。

| 验证                                           | 结果与边界                                                                                                                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原树根 typecheck / lint / fmt / architecture   | 全部 exit 0；本轮提交前独立执行                                                                                                                                                                                                                         |
| 原树 audit/no-official-purchase                | 12 项通过，合成/只读                                                                                                                                                                                                                                    |
| 吸收树根 typecheck / lint / fmt / architecture | `verify-gates-2LIbbg` 最后复跑各项 exit 0；Lint 3319 文件 0/0，format 3850 文件，architecture 0 violations/baseline/new                                                                                                                                 |
| CLI typecheck / registry                       | `verify-cli-types-29mdre` 最后 typecheck exit 0；`verify-gates-2LIbbg` registry exit 0                                                                                                                                                                  |
| CLI 全包 lint                                  | **exit 1，79 errors / 55 warnings**；同 oxlint/config/path 的初始 HEAD archive 对照为135诊断，当前134，新增0、少1 warning；22个既存超行文件行数增长单列，不放宽规则或升baseline                                                                         |
| UI/store/registry 单元                         | 11文件、56叶子断言通过；最终复跑 `adoption-ui-units-vNzW8y`，不是浏览器验收                                                                                                                                                                             |
| Browser fixture owner                          | 最后经中央 runner 复跑3项通过（`source-tests-aumc19`）；验证越界拒绝、环境独占、真实端口、close幂等与恢复原绑定。首轮顶层路径硬编码失败已修，失败日志保留                                                                                               |
| 真实 UI 合成交互                               | 两场景联合复跑2/2通过：完整视图的同一 Lexical 节点/草稿/挂载、浮动/最小化/阻塞恢复；模型/思考选择、迟到事件拒绝、独立草稿、390px菜单边界。`full-view-acceptance-IcGz9g`、`model-menu-acceptance-XejxoP` 的页面/请求/外域/次级错误数组均空；非安装版验收 |
| CLI定向                                        | model completion6、governor3、ToolSearch41、Bash输出3全部通过；Bash fixture SecurityWarning污染严格输出的测试问题已修，产品代码未改                                                                                                                     |
| Source/SQLite                                  | 隔离6、layout4、组合5、CLI11、枚举7；infrastructure27、startup20、baseline2、inspection RPC4全部通过；旧baseline更新参数2项早拒绝且冻结字节不变                                                                                                         |
| Source迁移入口                                 | 最后合成链接接缝收紧后 alias92、admission25项目内复跑通过（`NayG2U`、`nMSjZK`）；migration contract11、ingress token1、Source RPC1通过（`AlHNfo`、`YAaQLy`、`eepWXp`）。原生创建前检查target/link路径和媒体类型，Windows禁AutoRun，创建后回读identity   |
| 离线产品/审计                                  | 最终 `verify-readonly-RqHQ6G` 14入口全部exit0；目录9/投影5的真实child数量不与wrapper1重复相加                                                                                                                                                           |
| Office                                         | 正常包级pnpm test为20文件/89通过，唯一写白名单为fresh sandbox（`office-vitest-1jaxjv`）；实际四格式源码编译/分发6（`source-tests-bw0vUW`）、模拟seed1通过；无SEA/安装/GUI产品验收                                                                       |

最终 Source/SQLite 组证据为 `verify-source-PiNkal`、`verify-fixtures-358oYE`；CLI 四区及 Office 字体15/日志2/审计9的详细证据见各分区 spec。成功、预期失败与首轮失败的日志均保留，不删除以美化结果。

### 本轮安全偏离

Source 子代理此前直接运行 `node --test scripts/ci/workspace-alias.test.mjs` 与 `node --test scripts/ci/adoption-source-workspace-admission.test.mjs`，cwd为吸收树，但HOME/USERPROFILE、TEMP/TMP未绑定，`PROJECT_TEST_SANDBOX_ROOT`缺失。旧本体在系统TEMP创建自己的合成fixture，并在t.after递归删除这些自建目录；代理报告未读写真实`.zcodium`，主代理未再删除/恢复项目外目录。两次结果不计入合规项目内验收；对应入口已迁为中央sandbox wrapper并如上复跑。**因此不能宣称本轮项目脚本「项目外零写」**，也不能将后续合规结果抹去这一偏离。

历史全量TEMP/真实setting事故继续保留在维护spec和此前实施记录，不改写因果或擅自恢复丢失数据。

### 未完成产品与未验收

- Source历史数据仍history-present/unavailable、snapshot-unproven/snapshot-stale fail-closed；真实全写者lease、可信snapshot原生后端、preview/confirm/execute/retry/report/restore的UI/channel未接通，首次库创建后重连可能保守阻断。
- 桌面remote kind改走Source transport，远端需已部署daemon；旧桌面自动部署链不再接线，未配置目标会needs-install/needs-start。普通server HTTP旧入口仍在；没有真实SSH/WSL/Docker/daemon验收，不宣称一键部署完成。
- 未执行真实模型/Key、workflow/Agent、用户数据库迁移、手机设备、Windows taskbar/DPI、Office四格式GUI、安装/升级、exe/dmg/SEA、完整root/CLI corpus或macOS；不推送、不触发Actions、不发行。
