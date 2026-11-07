# menu-final 外置 QA 前置失败与补测修正

实际运行是 `qa-menu-20261106-menu-final`。以下三个 worker 均在 beforeAll 失败，没有执行对应的 40 条产品用例；静态 READY 不计 UI PASS。根执行器串行运行，本文作者没有操作 UI 或运行构建。

| Worker | 原始证据 | 归因与最小修正 |
| --- | --- | --- |
| 0-0 / QLA12 | [原始日志](logs/e2e-qa-menu-20261106-menu-final.log)，6459–6475：`displayed:163 → closeMenus:175 → footerSubmenu:186 → chooseLocale:200` 的原生 stale element reference | 切换 locale 后 Radix 菜单退出/重建，QA 向已脱离文档的 WDIO handle 调用 isDisplayed；该引用错误不能登记产品缺陷。以单次 renderer DOM 快照读可见性及菜单状态，使用新 handle 真正点击，仅原生 stale 允许重查。 |
| 0-1 / RLM13 | 同日志 12401–12433：实际 input `.zcodium`/count1，516bytes 的本树 File/DataTransfer onchange；12610附近 `17:45:58.682 aria-busy=false`、input0；12644–12649：裸标题等待30秒超时 | [importer](../../../packages/services/src/conversation-share/conversationArchiveImporter.ts:322) 的 importedHistory.title 为 `Imported: ` / `导入：` + 原题；QA 比较裸原题，short-circuit 也未进入后续pane查询。现按 readSettings().locale 精确前缀查同一只读index，再独立等待该 taskId 激活。日志确认输入/busy释放；原失败现场没有保存导入任务DB/正文，不能仅据此宣称导入成功或真实用户数据损失。 |
| 0-2 / SLM15 | 同日志 17681–17697 / 20434–20450：`visible:87 → closeMenus:96 → presentation:107`，beforeAll和恢复afterAll同类stale | 与 QLA 同一 QA 元素生命周期问题，统一使用同一个同步DOM菜单 helper。SLM 导入标题比较也同步按当前产品前缀修正，避免后续再阻断。 |

[V4 helper](../../../packages/desktop/test/e2e/helpers/v4-conversation.ts:217) 仍读取 `v4-session-pane-workspace-main` 的顶层 sessionId，当前使用形状没有过期证据。产品 picker [browserFilePicker](../../../packages/ui/src/lib/browserFilePicker.ts:25) 在真正 onchange 后读取 File.arrayBuffer；测试只拦 file-input click 抑制系统 picker，其余输入/Host事务没有 mock。

导入公开rows的边界必须保留：[CLI import](../../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts:1108) 原子创建 shared-context、model-only/hidden message；[Notice](../../../packages/ui/src/v4/ConversationShareImportNotice.tsx:25) 明确不反向映射为runtime Message，[SessionPane](../../../packages/ui/src/v4/SessionPane.tsx:4713) 在 timeline headerSlot 渲染只读公开副本。只读 [assistant renderer](../../../packages/ui/src/v4/ConversationShareReadonlyTimeline.tsx:300) 没有 runtime v4-copy 动作，runtime [find](../../../packages/ui/src/v4/useConversationTimelineFind.ts:39) 对 renderUnits 构建索引。SLM05/14 若真实只读块存在且无runtime目标，保存现场并 BLOCKED；不把该前置误判为产品缺陷，也不发送模型请求制造历史。

三suite均新增独立 beforeAll 失败 PNG/JSON（当前 active pane、菜单/heading、只读合成index及可用toast），避免0case只有bootstrap截图。路径隔离、PS7窄reparse guard、clipboard/input出口拦截未放宽。产品、旧canonical、bootstrap、observer及runner未修改。

| QA文件 | 修前 SHA256（menu-final加载） | 修后 SHA256 |
| --- | --- | --- |
| QLA | `79fb9645d90acc4564ebe80f33dd6d36e92e1494e6230c09f2f3c8f867c9e83f` | `07f2557d74b5d4068d1e48b8c86929a3573cfc2659fe8997fb40cb5b122bd31c` |
| RLM | `dc7f185b21cd74c68b348bcc0107694c8fddff5de437e1b748852b8eab988670` | `3fe46363e145869dcbcc48b3eda9d62a4e22cca35541021d00c8899d8ccd0828` |
| SLM | `6abe6c4ba875b0a3197f33ce48db7662d35b654517bbd42406c7a580c51649ac` | `d74361289cb0f1a806ee1a36aa0bf933dadea1432e50205f5fc133aeae0742c8` |
| 新菜单helper | 不存在 | `dba3eca2867cccac260b285dd7e82463ce021df7d879c32dc692852d7b74c493` |

修后静态实测：18:03:14UTC [allQA noEmit / 5文件lint / keepNames](logs/e2e-preflight-short-static.json) 0 diagnostics、0 lint warnings/errors、64 serialized callbacks无闭包finding、4 raw scripts语法无错误；[RLM实际tsx13项注册](logs/e2e-preflight-residual-static.json) 18:03:27UTC；[QLA实际tsx12项注册](logs/e2e-preflight-local-menu-static.json) 18:03:42UTC；SLM实际15项注册。公共 archive 编解码仍为3rows/0artifact。没有执行 hooks/cases/UI/Host导入/PTY，补测后的UI结果等待根执行器。

根下次在当前桌面进程全部退出后串行运行相同3个精确spec（可与SPFV001+002合并），保留 `-Bootstrap -SafeTerminal`；根已决定无 `-OpenSidePane`。SLM05/14的runtime补测另用有限已有replay、真实composer首发，不执行原chat-find中的Git commit/diff部分。

18:12UTC根要求再收敛异步locale：RLM与SLM切显式语言后等待本树 `readSettings().localePreference` 和 resolved `locale` 同时保存为该值；system只要求preference，不假定系统语言。精确prefix仍来自已持久化locale，无扩大标题匹配。最终RLM SHA `797b81824a904bc37d275408eb63cd18e936e098a3368a2a182110a9e63a1aac`、SLM SHA `eaca839f6ba0a303d46adac1027745a7f898145d6d87463ddf70214571d2de1c`，QLA/helper不变。[18:12:15静态](logs/e2e-preflight-short-static.json) allQA noEmit0/5文件lint0、64callback/4rawscript无问题；[18:12:26 RLM](logs/e2e-preflight-residual-static.json) 实际13注册、noEmit0/lint0。前表保留18:03版本记录，下一批使用本段最终SHA。
