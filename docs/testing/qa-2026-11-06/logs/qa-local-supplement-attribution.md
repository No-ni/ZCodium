# local-supplement 外置 QA 修正依据

记录时刻：2026-11-06 19:38 UTC 之后。只读分析已结束 run 的日志、独占 JSON/PNG 和当前源码；没有操作 UI、进程、产品、canonical、bootstrap 或 runner。旧运行结果保留，下面三项的修正版本仅静态 READY，等待新的独立运行。

| 项目 | 原实际停点 | 已确认的 QA 边界 | 最小补测 |
| --- | --- | --- | --- |
| RLM05 | [005-RLM05.json](../runtime/qa-menu-20261106-local-supplement/evidence/qa-residual-local-menus-0-3-25872-1793991442433/005-RLM05.json) 在18:58:21.768 UTC记录15秒等待失败，activeWorkspace 已变成本run `.zcodium/workspace/draft-…` | global New Task 创建全局草稿；最近任务查询只取当前 workspace 且排除 active task。原测试改变了查询范围，未验收 alpha 查询/选择/history | 在 alpha 所属的同一 workspace 真实导入第二个独占 anchor task，公开读取验证不同 taskId、相同 workspace/identity；alpha 非 active 后再验 recent/query/select/history。仍不修改RLM04/07唯一selected断言 |
| RLM06 | [007-RLM06.json](../runtime/qa-menu-20261106-local-supplement/evidence/qa-residual-local-menus-0-3-25872-1793991442433/007-RLM06.json) 在18:59:02.951 UTC记录正文读取失败；[PNG](../runtime/qa-menu-20261106-local-supplement/evidence/qa-residual-local-menus-0-3-25872-1793991442433/007-RLM06.png)有实际文件正文 | Files索引/选择已到预览，原 `body.innerText` 不进入代码 open shadowRoot；不能登记空白文件产品bug | 只读 preview 容器下的 open shadowRoot，精确第1行 `RLM_FILE_CONTENT_中文 空格`；保留20秒和原选择动作，保存原始行/归一行/根数量 |
| SLM15 | [022-SLM15.json](../runtime/qa-menu-20261106-local-supplement/evidence/qa-short-local-menus-0-4-31192-1793991767933/022-SLM15.json) 在19:05:17.948 UTC记录30秒正文等待失败；[PNG](../runtime/qa-menu-20261106-local-supplement/evidence/qa-short-local-menus-0-4-31192-1793991767933/022-SLM15.png)清楚显示正确首行及后续正文 | preview显示已通过；原父 `textContent` 不进入代码 open shadowRoot。滚动/Find路由后续未抵达，不记这些功能通过 | 同一只读 helper 精确第1行完整 `合成文件查找行 1：仅本树离线QA。`，保持30秒；后续原滚动与全局查找路由断言不变 |

当前 renderer 是 `@pierre/diffs` 的 File。此前根据截图称其为 Monaco 的推断在此纠正：`previewPaneCodeContent.tsx`调用 CodeViewer，`code-viewer.tsx:12`导入File，产品自身208–226行递归读取 open shadowRoot 和 `[data-line]`；已安装依赖 File.js:295 使用 `attachShadow({mode:"open"})`，FileRenderer.js:250写 `[data-code]`，processLine.js:16写 `[data-line]`。旧run没有shadow DOM快照，不能补称旧现场已读到U+00A0；新helper仅对已知U+00A0归一普通空格并去除一个行终止符，实际原始文本将随新run保存。

只读 source SHA256：

| 文件 | SHA256 |
| --- | --- |
| packages/ui/src/previewPaneCodeContent.tsx | `4b73aa46c7d1ee1a3fe20fc56e103e185f2958f508a18fc5e29379d6364d8837` |
| packages/ui/src/components/ui/code-viewer.tsx | `dfccd2feaccc62af84f3e92dc5b8e25e7025b6c64cbd16f177586b1dc763affe` |
| node_modules/@pierre/diffs/dist/components/File.js | `a444b933b0fb1d78fb4ccfaac66f7e12f244cc7981a35eaa426170307d4e52a0` |
| node_modules/@pierre/diffs/dist/renderers/FileRenderer.js | `863df90f974e7224a9bf64c36d41aeb7e61b01c1dce487926749f4d3e9589cf9` |
| node_modules/@pierre/diffs/dist/utils/processLine.js | `733205619aa88c494b7abeb42ec37220543950a9f936d7565d0841d57ea66174` |

修前源码基准见 [supplement静态准入](feature-inventory-local-supplement-preflight.json)及各自原静态文件；当前修后见 [19:38:25最终静态证据](e2e-preflight-final-local-gaps-static.json)。不是把当前源码反写旧worker。

| QA 文件 | 修前 SHA256 | 修后 SHA256 |
| --- | --- | --- |
| qa-residual-local-menus-20261106.test.ts | `2eb73bb1cb66625d0d074c71ecfe68649c43d29b0e1c57442c12d8499fa70ab7` | `eaebe0c7aaf09d13946e99827db1960a1808ac1dacfbca496dcf71c75100c152` |
| qa-short-local-menus-20261106.test.ts | `abb2086e369104e2dd2e0a47405966296ea254e9aa8aefd426ae1a1906f39fbe` | `5cff511dc4b82153fb71ff9d6e2bac8c229ec18cef4b171bac5bcb39174ad4af` |
| 新qa-preview-dom.ts | 无 | `3646eaec8b75953d7944c864fde82d65770bef502b3cb049a1e366183a99d01d` |

全外置 noEmit 0，六个相关文件 lint 0警告/0错误，真实module注册35个fullTitle，限定FLG7/RLM05-06/SLM15筛选10项，62callback无keepNames闭包、8rawJS syntax0。未执行真实UI，公共Host fixture/51项目分页/Git diff/Memory scope均不计PASS。

SLM13保留真实安全 SKIP：[019-SLM13.json](../runtime/qa-menu-20261106-local-supplement/evidence/qa-short-local-menus-0-4-31192-1793991767933/019-SLM13.json)明确 `PowerShell profile probe returned unknown keys`，发生于PTY前；本轮不放宽/不复跑。RLM04/07现场可见两个selected Settings候选保持原断言和产品候选，没有通过隐藏过滤去除。RFC旧run的两个500仍为未完整匹配，raw请求已被后worker重置；新的精确title fixture仅是当前source构造的受控待验证输入，不把旧500追认为已证title。
