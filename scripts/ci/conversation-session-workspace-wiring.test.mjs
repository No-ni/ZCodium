import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// 「会话执行 cwd 是谁」这件事在 UI 里有两条读法（见
// docs/specs/conversation-session-workspace.md 规则 11 / 13 与验收 9、14）：
//   - 工作区身份根（tab 的 `workspacePath`）——身份、tab 键、任务索引、code viewer 作用域；
//   - 会话执行 cwd（pane 的 `fileSearchRootPath` / 请求自带的 `fileReferenceRootPath`）——
//     模型写的相对路径（工具入参、write/edit 原文、分享正文引用）的解析根。
// 纯函数层的口径由 `packages/ui/src/lib/*` 的单测覆盖，但**接线**（谁把哪个根传给谁）没有：
// 把任一消费点改回身份根，全部单测 + E2E 依然绿（第七轮审查实测）。这些接线点一旦错位不会报错，
// 只会静默指向对话根下的同名文件或不存在——正是本规则要消灭的那类不一致。
//
// 因此这里用「源码契约」把它们钉住：每条都写明为什么必须是会话根。改名的重构要同步改本文件，
// 这正是清单存在的意义（与 session-local-errors / model-choice-submission 同一条路子）。
const CONTRACTS = [
  [
    "packages/ui/src/ToolCallBlocks.tsx",
    "buildToolDisplayModel(toolCall, fileReferenceRootPath ?? workspacePath)",
    "工具输出里的路径是模型写的原文，相对路径必须按 pane 的会话 cwd 解析；身份根是回落",
  ],
  [
    "packages/ui/src/command-center/CommandCenterDialog.tsx",
    "const readRoot = fileSearchRootPath ?? workspaceAbsPath;",
    "Cmd+P 最近改动/文件结果打开的是模型原文路径，读取基准（模型 cwd）派生一次、与展示基准分开",
  ],
  [
    "packages/ui/src/command-center/CommandCenterDialog.tsx",
    "path: resolveToolCallFilePath(file.path, readRoot),",
    "点击打开必须用那个单一读取根：展示取「最深包含根」，两者不能互相冒充（规则 11/12）",
  ],
  [
    "packages/ui/src/v4/ConversationFileSummaryPanel.tsx",
    "resolveToolCallFilePath(path, context.fileSearchRootPath ?? context.workspacePath)",
    "文件变更摘要的「查看文件/diff」要按会话 cwd 读，否则指向对话根的同名文件",
  ],
  [
    "packages/ui/src/v4/ConversationFileSummaryPanel.tsx",
    "resolveFileDisplayBasePath(item.path, [context.fileSearchRootPath, workspacePath])",
    "展示标题按「最深包含根」算，会话目录必须参与候选，否则相对路径显示成绝对路径",
  ],
  [
    "packages/ui/src/app-shell/WorkflowArtifactSidePane.tsx",
    "joinFilePath(fileReferenceRootPath ?? tab.workspacePath, sourcePath)",
    "产物 sourcePath 相对 run 的 cwd（会话执行目录），拼身份根会指到对话根的同名位置",
  ],
  [
    "packages/ui/src/app-shell/AnimatedSidePanePanel.tsx",
    "fileReferenceRootPath={tab.fileReferenceRootPath ?? effectiveWorkspacePath}",
    "侧栏产物 tab 优先用打开时冻结的请求根；聚焦会话 cwd 只作缺席回落",
  ],
  [
    "packages/ui/src/app-shell/WorkflowRunSidePane.tsx",
    "fileReferenceRootPath: tab.fileReferenceRootPath ?? tab.workspacePath,",
    "run 详情面板里的产物 chip 也要拼 sourcePath（相对 run 的 cwd）：解析根取自 tab 冻结值，缺席回落身份根",
  ],
  [
    "packages/ui/src/hooks/useAppPanels.ts",
    "const artifactRootPath = request.fileReferenceRootPath?.trim() || request.workspacePath;",
    "html 产物「直接开浏览器」的 URL 必须按发起 pane 的会话 cwd 拼（分屏时焦点可能已换）",
  ],
  [
    "packages/ui/src/prompt-editor/ChatPromptEditor.tsx",
    "fileReferenceRootPath: fileSearchRootPath,",
    "行内编辑器的拖拽/提及同源判据要与主 composer 同根，否则同源拖拽被误判成跨源",
  ],
  [
    "packages/ui/src/v4/V4InteractionDialogs.tsx",
    "fileReferenceRootPath={fileReferenceRootPath}",
    "权限弹窗里的工具入参路径按会话 cwd 展示/读取（`workspacePath` 仍是弹窗身份）",
  ],
  [
    "packages/ui/src/lib/workspaceFileDrag.ts",
    "options.fileReferenceRootResolved !== false &&",
    "解析根未被会话事实证明（草稿预热未就绪 / 首帧身份不匹配）时一律投绝对路径：两侧都回落成身份根，同源判据只会给出「相对路径可用」的假结论",
  ],
  [
    "packages/ui/src/lib/workspaceFileComposer.ts",
    "{ fileReferenceRootResolved: params.fileReferenceRootResolved },",
    "提及插入把解析根的来源透传给同源判据，默认 true = 改动前行为",
  ],
  [
    "packages/ui/src/v4/SessionPane.tsx",
    "const fileReferenceRootResolved = paneFileSearchRoot.resolved;",
    "解析根的来源由 pane 的派生一次性给出（会话事实 vs 回落值），下游不再各自判断",
  ],
  [
    "packages/ui/src/v4/ConversationComposer.tsx",
    "fileReferenceRootResolved,",
    "主 composer 的两条提及入口（拖拽 / Add to chat）都带来源事实",
  ],
  [
    "packages/ui/src/prompt-editor/ChatPromptEditor.tsx",
    "fileReferenceRootResolved={fileReferenceRootResolved}",
    "行内编辑器把来源事实同时下发给 Lexical 输入（@ 菜单）与动作菜单（+ 文件列表）",
  ],
  [
    "packages/ui/src/LexicalChatInput.tsx",
    "fileReferenceRootResolved={fileReferenceRootResolved}",
    "Lexical 输入把来源事实交给 MentionPlugin，@ 文件候选才会按绝对路径插入",
  ],
  [
    "packages/ui/src/mentions/MentionPlugin.tsx",
    "{ resolved: fileReferenceRootResolved, rootPath: fileSearchRootPath },",
    "@ 文件候选的搜索根必须与它的来源一起传（只传路径分不出「会话事实」与「回落值」）",
  ],
  [
    "packages/ui/src/prompt-editor/ChatPromptActionMenu.tsx",
    "{ resolved: fileReferenceRootResolved, rootPath: fileSearchRootPath },",
    "+ 菜单的文件列表与 @ 菜单同一条规则",
  ],
  [
    "packages/ui/src/mentions/providers/fileMentionProvider.ts",
    "const mentionTarget = rootResolved ? entry.relativePath : entry.path;",
    "候选插入形态由来源事实决定：未证明的根投绝对路径（首发会话的 cwd 还没铸出来）",
  ],
  [
    "packages/ui/src/v4/ConversationRowView.tsx",
    "fileReferenceRootResolved={context.fileReferenceRootResolved}",
    "行内消息编辑器从行渲染上下文拿到同一个来源事实",
  ],
  [
    "packages/ui/src/git-action-menu/currentSessionFileScope.ts",
    ".map((path) => resolveToolCallFilePath(path, fileReferenceRootPath)),",
    "提交弹窗的「当前会话文件范围」要按会话 cwd 解析模型原文路径，否则相对路径写出的变更被整条过滤",
  ],
  [
    "packages/ui/src/GitActionMenu.tsx",
    "fileReferenceRootPath: fileReferenceRootPath ?? workspacePath,",
    "弹窗范围与提交消息生成都带会话解析根（缺席回落身份根 = 改动前行为）",
  ],
  [
    "packages/ui/src/v4/ConversationStatusPanel.tsx",
    "fileReferenceRootPath={fileReferenceRootPath}",
    "会话执行 cwd 由 SessionPane 经状态面板下发给 GitActionMenu",
  ],
  [
    "packages/ui/src/app-shell/AnimatedSidePanePanel.tsx",
    "cwd={tab.cwd ?? effectiveWorkspacePath}",
    "侧栏终端的 PTY cwd 必须是会话执行目录：PTY 的 cwd 创建后不可变，改回身份根会让整个会话的终端停在对话根（边界 1/9）",
  ],
  [
    "apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts",
    "const inheritedExecutionWorkspacePath = resolveConversationSessionWorkspaceInherited( record.executionWorkspacePath, );",
    "规则 5：fork / 侧会话必须继承父会话的执行 cwd（重算会让子会话跑到另一个目录、并让删除边界的『仍被别的在册会话使用』守卫失效）",
  ],
  [
    "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts",
    "const parentSessionId = this.detachedChildParent.get(sessionId);",
    "派生会话（subagent / workflow actor）在进程内没有 record，投影钩子对它们恒返回 null：必须回落到父 record 的执行 cwd（规则 5），否则子会话面板按对话根解析相对路径",
  ],
  [
    "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts",
    "publisher.seedSessionWorkspacePath(getWorkspacePath.call(this.host, parentSessionId));",
    "父 record 的执行 cwd 就是子会话继承的执行目录（缺席 ⇒ UI 回落对话根 = 打开错的同名文件）",
  ],
  // 忽略规则根（规则 10）：会话执行 cwd 是**搜索根**，`.zcodiumignore` 仍只有一份、落在对话根上。
  // 服务层刻意不做「搜索根像不像会话目录」的结构推断（那会出现第二个定义），所以「传对规则根」
  // 完全靠调用方：漏传任一处 ⇒ 规则文件被写进 <对话根>/<日期>/<id8>/，而该目录因非空永不回收。
  // 四处入口（文件树 / 提及 / Cmd+P / 设置页）都必须显式传，这组契约就是那条判据。
  [
    "packages/ui/src/mentions/providers/fileMentionProvider.ts",
    "const params = { rootPath: searchRootPath, ignoreRulesRoot, workspaceIdentity, query, limit };",
    "@ 面板（含 + 菜单共用同一 provider）的搜索根是会话 cwd，规则根必须显式传对话根",
  ],
  [
    "packages/ui/src/workspace-file-tree/WorkspaceFileTree.tsx",
    "ignoreRulesRoot: workspaceScope,",
    "文件树的搜索根跟随会话 cwd，忽略规则根固定是工作区身份路径",
  ],
  [
    "packages/ui/src/command-center/CommandCenterDialog.tsx",
    "void fetchWorkspaceFileEntriesPacked(fileService, fileSearchRoot, workspaceAbsPath)",
    "Cmd+P 的索引按会话 cwd 扫描，规则根用工作区身份路径（第二参是搜索根，第三参是规则根）",
  ],
  [
    "packages/ui/src/settings/WorkspaceFileSearchSection.tsx",
    "const ignoreRulesRoot = workspacePath;",
    "设置页编辑的规则文件必须落在对话根：本页的 workspacePath 是 tab 的工作区身份路径",
  ],
];

/**
 * 源码里的换行/缩进不影响判据：压成单空格后再做子串匹配。
 * 另外把 `{ ... }` 两侧的空格也压掉——oxfmt 会把长 JSX 属性折成
 * `attr={\n  expr\n}`，不归一化的话「单行写法」的契约会在格式化后失效。
 */
function normalize(source) {
  return source.replace(/\s+/gu, " ").replace(/\{\s+/gu, "{").replace(/\s+\}/gu, "}");
}

for (const [path, snippet, why] of CONTRACTS) {
  test(`接线契约：${path} → ${snippet}`, async () => {
    const source = normalize(await readFile(path, "utf8"));
    assert.ok(
      source.includes(normalize(snippet)),
      `${path} 必须保留这条接线（${why}）。实际未找到：${snippet}`,
    );
  });
}

test("SessionPane 的六处请求供给点都带 pane 的解析根（分享预检 / 分享发布 / 产物打开 / run 详情 / 脚本 transcript / run 目录页）", async () => {
  const source = normalize(await readFile("packages/ui/src/v4/SessionPane.tsx", "utf8"));
  const occurrences = source.split("fileReferenceRootPath: fileSearchRootPath,").length - 1;
  assert.equal(
    occurrences,
    6,
    `期望 6 处对象字面量供给点（分享预检 / 分享发布 / 产物打开 / run 详情 / 脚本 transcript / run 目录页），` +
      `实际 ${occurrences} 处；新增供给点请同步本清单（少一处就是某个入口悄悄退回身份根）`,
  );
});

test("两个 workflow 侧栏 tab 的宿主侧都优先用冻结在 tab 上的请求根", async () => {
  const source = normalize(
    await readFile("packages/ui/src/app-shell/AnimatedSidePanePanel.tsx", "utf8"),
  );
  const occurrences =
    source.split("fileReferenceRootPath={tab.fileReferenceRootPath ?? effectiveWorkspacePath}")
      .length - 1;
  assert.equal(
    occurrences,
    2,
    `期望 2 个 tab（产物 / 脚本 transcript）由宿主传冻结根，实际 ${occurrences} 处；` +
      "run 详情面板的产物 chip 直接从自己的 tab 读冻结根（见上面的契约）",
  );
});

test("内置 node_repl 的 spawn cwd 跟随会话执行 cwd（不是工作区键路径）", async () => {
  const source = await readFile("apps/zcode-cli/packages/bootstrap/src/app/create-app.ts", "utf8");
  const start = source.indexOf("resolveBuiltInNodeReplMcpServers({");
  assert.ok(start >= 0, "create-app 必须调用 resolveBuiltInNodeReplMcpServers");
  const call = source.slice(start);
  const body = call.slice(0, call.indexOf("});"));
  // 注释里两个名字都会出现（解释取舍），判据只看代码行。
  const code = body
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.match(
    code,
    /\bworkingDirectory,/u,
    "node_repl 的 cwd 必须是本会话的执行 cwd：`js` 里相对路径写出的文件要与 Read/Write/Bash 同一个根",
  );
  assert.doesNotMatch(
    code,
    /\bworkspaceDirectory\b/u,
    "node_repl 的 cwd 是执行 cwd，不是工作区键路径（用后者会让 js 的相对写入落进对话根）",
  );
});

test("裸 CLI/TUI 的 resumeFromStore 包装器必须先重建会话目录（协议路径之外唯一重建点）", async () => {
  const source = await readFile("apps/zcode-cli/packages/bootstrap/src/app/create-app.ts", "utf8");
  const start = source.indexOf("const resumeFromStore = async");
  assert.ok(start >= 0, "create-app 必须保留 resumeFromStore 包装器");
  const end = source.indexOf("const prepareResume", start);
  const body = source.slice(start, end);
  // 注释里会出现函数名解释取舍，判据只看代码行。
  const code = body
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.match(
    code,
    /await ensureConversationSessionDirForBareResume\(\{[\s\S]*?sessionStore,\s*\}\);/u,
    "裸 CLI/TUI 恢复（zcode --resume/--continue，与桌面同库）没有协议路径的 ensure 分支，" +
      "path 指向的会话目录被回收/手工删除后 cwd 不存在，首个 Bash 即 ENOENT——接线删掉即回归",
  );
  // 重建调用必须在 runtime.resumeFromStore 之前：cwd 赋值之后才建目录，首次执行仍会 ENOENT。
  assert.ok(
    code.indexOf("ensureConversationSessionDirForBareResume") <
      code.indexOf("runtime.resumeFromStore"),
    "目录重建必须发生在 runtime.resumeFromStore（core 里 workingDirectory 赋值）之前",
  );
});

test("SessionPane 的两个 JSX 供给点（权限弹窗 / 状态面板）各自带一次解析根", async () => {
  // 用计数而不是 `includes`：这条 prop 在同一个文件里出现两次，子串判据删掉任意一处仍然成立
  //（第九轮审查实测：删掉权限弹窗那一处后 28/28 全绿）。两处供给点见 SessionPane 的
  // `<V4InteractionDialogs>`（权限弹窗里的工具入参路径）与 `<ConversationStatusPanel>`（git 提交范围）。
  const source = normalize(await readFile("packages/ui/src/v4/SessionPane.tsx", "utf8"));
  const occurrences = source.split("fileReferenceRootPath={fileSearchRootPath}").length - 1;
  assert.equal(
    occurrences,
    2,
    `期望权限弹窗与状态面板各 1 处，实际 ${occurrences} 处；少一处就是某个消费点悄悄退回身份根`,
  );
});

test("设置页的三个 .zcodiumignore 调用点（读取 / 分区操作 / 保存）都带规则根", async () => {
  const source = normalize(
    await readFile("packages/ui/src/settings/WorkspaceFileSearchSection.tsx", "utf8"),
  );
  const occurrences = source.split("rootPath: workspacePath, ignoreRulesRoot,").length - 1;
  assert.equal(
    occurrences,
    3,
    `期望读取 / applyTransform / save 三处都带规则根，实际 ${occurrences} 处；` +
      "少一处就会把第二份 .zcodiumignore 写进会话执行目录（该目录因非空永不回收）",
  );
});

test("git 提交弹窗的两条筛选入口都显式带会话解析根", async () => {
  const source = normalize(await readFile("packages/ui/src/GitActionMenu.tsx", "utf8"));
  const filterOccurrences =
    source.split("fileReferenceRootPath: fileReferenceRootPath ?? workspacePath,").length - 1;
  assert.equal(
    filterOccurrences,
    2,
    `期望 staged / unstaged 两条筛选都带解析根，实际 ${filterOccurrences} 处`,
  );
  assert.ok(
    source.includes(
      "getCurrentSessionFilePaths( state.activeTaskChangeSummary, fileReferenceRootPath ?? workspacePath,",
    ),
    "提交消息生成用的会话文件列表也要按会话 cwd 解析（服务侧拿不到会话根）",
  );
});

// 删除边界的三个回收调用点（旧 closeSession、v4 closeSession、创建失败自清理）共用同一条
// 守卫：`isConversationSessionDirectoryInUseAcrossProcesses`（进程内注册表 + 会话库）。
// 只查注册表会漏掉**别的 app-server** 里继承同一执行 cwd 的 fork / 侧会话——B 窗口删父会话
// 时 rmdir 掉 A 窗口存活子会话的正空目录，它下一次相对写入即 ENOENT（第十轮审查实测）。
// 接线错位同样不会报错、只会静默少一层守卫，因此钉成源码契约；不排除自己的行也不行：
// v4 deleteSession 是 close 语义（行留在库里），不排除 ⇒ 空目录永不回收。
const DELETE_GUARD_WIRING = [
  ["apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts", 2],
  ["apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts", 1],
];
for (const [path, expected] of DELETE_GUARD_WIRING) {
  test(`接线契约：${path} 的删除回收用惰性跨进程复检（${expected} 处）`, async () => {
    const source = normalize(await readFile(path, "utf8"));
    // 惰性传入（判定链通过后才查库）：急切 await 会让项目工作区/远端每次 close 白跑全表查询。
    const lazyOccurrences = source.split("resolveSharedByOtherSession: () =>").length - 1;
    assert.equal(
      lazyOccurrences,
      expected,
      `期望 ${expected} 处回收调用点惰性复检跨进程事实，实际 ${lazyOccurrences} 处；` +
        "改回急切求值或删掉一处守卫都会在这里变红",
    );
    assert.doesNotMatch(
      source,
      /sharedByOtherSession:\s*await/u,
      "不得把跨进程复检改回急切求值（回潮 = 每次 close 为注定不回收的场景白跑一次 listSessions）",
    );
    const guardOccurrences =
      source.split("isConversationSessionDirectoryInUseAcrossProcesses({").length - 1;
    assert.equal(
      guardOccurrences,
      expected,
      `期望 ${expected} 处跨进程守卫调用，实际 ${guardOccurrences} 处`,
    );
    // 被关会话自己的行必须排除，且库事实来自 host 的 sessionStore（不是第二份存储通道）。
    const excludeOccurrences = source.split("excludeSessionId: String(").length - 1;
    assert.equal(
      excludeOccurrences,
      expected,
      `期望每处守卫都排除被关会话自己的行，实际 ${excludeOccurrences} 处`,
    );
    const portOccurrences = source.split("sessionPathSource: context.deps.sessionStore").length - 1;
    assert.equal(
      portOccurrences,
      expected,
      `期望每处守卫都接 host 的 sessionStore，实际 ${portOccurrences} 处`,
    );
  });
}
