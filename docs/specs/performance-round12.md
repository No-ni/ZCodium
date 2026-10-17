# 第十二轮性能扫描与本地回归

## 授权与测试边界

用户授权扫描、修复和本地测试，并指定可使用 GPT-6 Luna / max 子代理。本轮同时使用三个子代理，分别检查 UI 常驻订阅、services 后台工作、RPC/client 连接生命周期。保留开工前所有未提交改动；不提交、推送、触发 Actions、生成安装包或修改已安装应用。

基线 freshness 检查 main 与 origin/main 同步（ahead 0 / behind 0）；架构初检 baseline 0 / new 0。Node 使用 mise.toml 固定的 24.14.0，pnpm 使用 corepack pnpm 10.33.2，仅在命令进程内调整 PATH。初始根 typecheck 与 lint 通过（0 warning / 0 error）。

测试只使用合成输入、受控 IO、内存协议和临时浏览器 profile；不启动用户 Agent、不调用外部模型、不读取用户会话数据或修改用户配置。任何临时服务仅监听 loopback，结束时关闭自己创建的资源。不能结束或重启用户已有应用、服务和测试进程。

## 修复准入与所有权

- 先沿当前调用方、契约和已有规格确认可达路径，再用失败回归确认问题，最后实现小范围修复。不能仅凭语法模式或理论复杂度判断用户收益。
- 各领域规格在对应实现之前更新，明确唯一 owner、接口、不变量、错误和关闭语义；异步流程用事件图说明。RPC 后续修改更新现有生命周期规格，不继续建立平行业务规则。
- 不新增跨请求事实缓存、业务写入路径、协议字段或超时补偿；不改变 workspace identity、owner/lease、stale run、desktop-continuous 和 web-remote-replayable 边界。
- 优先修复无用后台工作、重复订阅与终结后资源残留；没有充分证据的设计重构保留为待调查项。

## 验收

1. 各目标回归在原实现上失败，并在修复后验证工作量或资源归零以及既有结果、顺序和异常语义。
2. 涉及交互的改动执行隔离浏览器场景；不以打安装包验证。
3. 完成根 typecheck、lint、architecture:check --changed、定点格式检查与适当的既有性能和连接回归，报告实际失败和环境限制。
4. 用指定输入上的操作计数报告改善；没有整机对照时不声称整体提速百分比。

## 扫描与验证记录

### 已确认并修复

| 位置                                                  | 已确认问题                                                                                       | 修复与受控证据                                                                                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BrowserGuestManager.attachGuest`                     | 前后台切换重复上报同一个 guest，每次增加一个 destroyed listener；解绑后旧 guest 继续引用 manager | 每个绑定只登记一次，并通过原 detach 入口移除本 owner 的 listener。重复 attach 100 次保持 1 个，dispose 后归零；保留其他 owner、迟到回调保护与 CDP 崩溃收口。          |
| `EmbeddedBrowserJavaScriptDialogController.bindGuest` | 每次重绑只清 Map，没有移除之前的 destroyed listener                                              | registration 持有自己的回调，unbind、替换、非法重绑与 dispose 都释放。100 次重绑只留 1 个本 owner 的监听，旧回调不能移除新 registration。                             |
| `GitCliRepo.commit`                                   | staged-only 提交对每条状态用 includes 重扫全部选中路径                                           | 本次调用建立 Set，不改变清理路径和 Git 命令顺序。256 个所选路径在旧实现触发 32,896 次线性成员比较，超过 1,024 预算；修复避免该重复数组扫描。                          |
| `useSessionSubagents.refresh`                         | 目录失效后仍串行请求历史补页，最后才检查版本                                                     | 在每次 await 返回时检查已有 requestVersion。140 条场景中，首批等待时卸载的后续 RPC 从 2 降为 0，第二页等待时卸载从 1 降为 0；正常顺序、cursor 和 100/20/20 页序保持。 |

具体所有权、事件顺序与验收场景见同目录 `performance-round12-browser-guest.md`、`performance-round12-browser-dialog.md`、`performance-round12-git-commit.md`、`performance-round12-subagents.md`。

### 扫描中未扩大修改的候选

- `IPCServer` disposable 与 `RemoteAgentConnection` 重连候选未找到当前产品调用证据，未仅凭模式修改。
- DeveloperToolsVisibility 轮询同时支持同文档 console 偏好变化；移除会改变行为，本轮保留。
- Gen UI watcher 缺少逐 scope release 契约，需要生命周期设计，未新增兜底分支。
- 子代理目录旧请求结束前，新 scope refresh 可能被原单飞门禁跳过；这是另一个既有时序问题，本轮不改变请求所有权设计。
- 在既有 RPC 生命周期改动基础上复查当前 MessagePort、WebSocket、手机传输路径，未再确认需要修改的新资源泄漏。

### 最终验证

- 开工时既有性能与连接回归为 60 文件 / 400 测试通过，六个既有隔离浏览器脚本为 9 测试通过。`browser-without-payment.test.mjs` 为 1 测试通过。
- 独立 Desktop Main 类型检查仍失败，存在 60 个既有诊断。使用 CompilerHost 在内存中将本轮两个 Main 生产文件替换为 HEAD，按文件、错误码和消息做多重集比较：基线 60 / 当前 60，新增 0、移除 0、新测试诊断 0。根 typecheck 的项目列表本身不包含 Main，因此单独记录此限制。
- 一次整合回归与子代理临时恢复旧 Git 实现的复现窗口冲突，得到 409 通过 / 1 失败；该失败正是已确认的 32,896 次比较预算。修复版定点测试通过，后续待所有源码稳定后重新执行整合回归。

稳定版本的最终结果：

| 检查                                                                         | 实际结果                                                                                                                                                           |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 整合 Vitest，`--config packages/ui/vitest.config.ts --maxWorkers=1`          | 63 文件 / 411 测试通过（包括既有性能、RPC/server/client、桌面/手机连接回归和本轮新增的 5 条 manager、4 条 dialog、2 条 Git 回归）。                                |
| 新增 `node --test scripts/ci/performance-round12-subagents-browser.test.mjs` | 1/1 通过；与本轮已通过的既有 9 项浏览器测试合计 10 项。页面资源只来自本次 loopback 服务，临时 Edge profile、独立 Vite cache、探测 socket 与服务在 finally 中清理。 |
| `corepack pnpm typecheck`                                                    | 通过。                                                                                                                                                             |
| `corepack pnpm lint`                                                         | 通过，3031 文件，0 warning / 0 error。                                                                                                                             |
| `corepack pnpm architecture:check --changed`                                 | 通过，violations 0 / baseline 0 / new 0。                                                                                                                          |
| 定点 `oxfmt --check` 与 `git diff --check`                                   | 本轮 15 个文件格式通过，工作区 diff 无空白错误；Git 仅提示现有 CRLF 转换规则。                                                                                     |
| Desktop Main 独立类型检查                                                    | 未通过；保留上述 60 个既有错误，基线比较无新增。                                                                                                                   |

生产代码仅修改四个文件：desktop browser guest 与 dialog、services git repo、UI session subagents hook，共增加 43 行、删除 12 行，净增 31 行。没有新增跨域依赖、状态 owner、共享缓存、协议或后台计时器。其他未提交改动保持原样。

本轮没有打包、下载构建产物、触发 Actions、启动已安装 ZCodium、真实 Agent 或外部模型调用，也没有真实 Git 提交、推送、用户数据读取及配置改动。这里的性能结论仅限可复现的重复工作与资源预算，没有整机性能对照，不给出总体提速百分比。
