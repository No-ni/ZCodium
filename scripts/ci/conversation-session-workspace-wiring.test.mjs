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
    "packages/ui/src/AssistantPreviewCards.tsx",
    'scope.workspacePath ? "exact" : "ambient",',
    "预览卡片冻结来源 Host，旧缺席 scope 保留兼容",
  ],
  [
    "packages/ui/src/v4/sessionWorkspacePath.ts",
    'workspaceIdentity ?? null, undefined, "exact",',
    "tab 的执行目录订阅不能借同路径活动远程 Host",
  ],
  [
    "packages/ui/src/v4/V4ConversationContext.tsx",
    'scope.workspaceIdentity ?? null, undefined, "exact",',
    "显式 pane scope 不借壳层远程身份",
  ],
  [
    "packages/ui/src/WorkspaceEditorButtonGroup.tsx",
    'workspaceIdentity, remoteTarget, "exact",',
    "header 任务目录精确读取来源 Host",
  ],
  [
    "packages/ui/src/useTaskListItemContextActions.ts",
    'workspaceIdentity, undefined, "exact",',
    "任务菜单 cwd 查询精确读取来源 Host",
  ],
  [
    "packages/ui/src/PreviewPane.tsx",
    'source?.workspacePath ? "exact" : "ambient",',
    "冻结 CodeViewer 来源使用精确 Host，旧无来源工作区仍保留 ambient 兼容",
  ],
  ...[
    "packages/ui/src/workspace-file-tree/useWorkspaceFileTreeData.ts",
    "packages/ui/src/workspace-file-tree/useWorkspaceFileSearchIndex.ts",
  ].map((path) => [
    path,
    'workspaceIdentity, undefined, "exact",',
    "文件树与搜索读取明确目标 scope，不借同路径活动远程 Host",
  ]),
  [
    "packages/ui/src/components/ai-elements/message.tsx",
    "resolveTaskExecutionWorkspaceServices({ baseServices, workspaceIdentity: fileLink.workspaceIdentity, remoteSessionId: fileLink.workspaceRemoteSessionId, })",
    "Markdown 右键编辑器 stat 与左键使用相同来源 Host，不能借预览所在壳层服务",
  ],
  [
    "packages/ui/src/components/ai-elements/message.tsx",
    "const baseServices = useOptionalBaseWorkspaceServices();",
    "本地来源右键动作从本机根服务开始，不能把主 pane 的远程服务当成本机",
  ],
  [
    "packages/ui/src/root/useRemoteWorkspaceHistory.ts",
    "tabStoreApi.getState().activateTab(existingWorkspaceTab.id);",
    "历史入口已经找到的旧 session-only remote tab 按精确 id 激活，不能误用本地 path-only 导航",
  ],
  [
    "packages/ui/src/app-shell/WorkspaceShellLayout.tsx",
    "resolveTaskExecutionWorkspaceServices({ baseServices, workspaceIdentity: target.workspaceIdentity, remoteSessionId: target.workspaceRemoteSessionId, });",
    "跨 Host 分屏文件链接的 stat 按来源 scope 路由，不能读取活动壳层 Host",
  ],
  [
    "packages/ui/src/app-shell/PlanDetailSidePane.tsx",
    "workspaceIdentity={tab.workspaceIdentity} workspaceRemoteSessionId={tab.remoteSessionId}",
    "远端分屏打开的 Plan Markdown 必须把冻结 Host 身份带到文件链接",
  ],
  [
    "packages/ui/src/v4/WorkbenchPane.tsx",
    "onOpenFileLink={shell.onOpenFileLink}",
    "跨 workspace 分屏共享文件打开 sink，sink 必须消费 SessionPane 的来源身份",
  ],
  [
    "packages/ui/src/previewPaneContent.tsx",
    "workspaceIdentity={source.workspaceIdentity} workspaceRemoteSessionId={source.workspaceRemoteSessionId}",
    "远端 CodeViewer 的 Markdown 预览必须继续使用被冻结的文件来源 Host",
  ],
  [
    "packages/ui/src/previewPaneMarkdownContent.tsx",
    "workspaceIdentity={workspaceIdentity} workspaceRemoteSessionId={workspaceRemoteSessionId}",
    "Markdown 预览把来源 Host 传至链接动作，而不是借活动壳层连接",
  ],
  [
    "packages/ui/src/App.tsx",
    "const terminalExecutionSessionId = sessionPathTargetId; const terminalExecutionWorkspacePath = effectiveWorkspacePath;",
    "project 分类不能否决 CLI 会话执行根；底部与右侧终端共用同一目标会话及执行目录",
  ],
  [
    "packages/ui/src/WorkspaceSidebarItem.tsx",
    "...(isActiveWorkspace ? (activeTaskId ? { taskId: activeTaskId } : {}) : { taskId: null }),",
    "当前 tab 草稿省略 taskId 才跟随预热目录；非激活 tab 显式 null 始终请求身份根，不能借当前草稿 cwd",
  ],
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
    "joinFilePath(artifactRunRootPath, sourcePath)",
    "产物 sourcePath 相对 run 的 cwd（会话执行目录），拼身份根会指到对话根的同名位置",
  ],
  [
    "packages/ui/src/app-shell/AnimatedSidePanePanel.tsx",
    "fileReferenceRootPath={tab.fileReferenceRootPath ?? effectiveWorkspacePath}",
    "侧栏产物 tab 优先用打开时冻结的请求根；聚焦会话 cwd 只作缺席回落",
  ],
  [
    "packages/ui/src/app-shell/WorkflowRunSidePane.tsx",
    "fileReferenceRootPath: artifactRoot,",
    "run 详情面板里的产物 chip 也要拼 sourcePath（相对 run 的 cwd）：解析根取自 tab 冻结值，缺席回落身份根",
  ],
  [
    "packages/ui/src/hooks/useAppPanels.ts",
    "const artifactRootPath = executionWorkspacePath ?? (request.fileReferenceRootPath?.trim() || request.workspacePath);",
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
    "const inheritedExecutionWorkspacePath = resolveConversationSessionWorkspaceInherited( record.executionWorkspacePath, conversationRuleApplies ? conversationRoot : undefined, );",
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
    "useCommandCenterFileSearch({ enabled: searchFiles, rootPath: fileSearchRoot, workspaceIdentity, ignoreRulesRoot: workspaceAbsPath, query: searchQuery, })",
    "Cmd+P 有界搜索按会话 cwd 扫描，规则根使用工作区身份路径",
  ],
  // 搜索已迁入 hook；旧断言仍要求被移除的全索引调用，误报 CI 失败。两段接线共同保护规则根。
  [
    "packages/ui/src/hooks/useCommandCenterFileSearch.ts",
    '.searchWorkspaceFiles({ rootPath, workspaceIdentity, ignoreRulesRoot, query, limit: RESULT_LIMIT, matchMode: "terms", })',
    "Cmd+P hook 必须把搜索根、身份和规则根一同传给既有服务",
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

test("Markdown 预览与计划详情把文档解析根传入 MessageResponse，计划打开时冻结来源根", async () => {
  const previewSource = normalize(await readFile("packages/ui/src/previewPaneContent.tsx", "utf8"));
  assert.ok(
    previewSource.includes("resolveDocumentFileReferenceRootPath(") &&
      previewSource.includes("fileReferenceRootPath={fileReferenceRootPath}"),
    "Markdown 预览应按 source.path 所在目录解析相对引用，再显式传给 MessageResponse",
  );
  assert.equal(
    previewSource.match(/fileReferenceRootPath=\{fileReferenceRootPath\}/g)?.length,
    2,
    "text 与 file 两种 Markdown 预览入口都必须传文档解析根",
  );

  const previewBody = normalize(
    await readFile("packages/ui/src/previewPaneMarkdownContent.tsx", "utf8"),
  );
  assert.ok(
    previewBody.includes("fileReferenceRootPath={fileReferenceRootPath}"),
    "MarkdownPreviewContent 必须把引用根交给 MessageResponse，workspacePath 仍保留 service 身份",
  );

  const artifactBody = normalize(
    await readFile("packages/ui/src/app-shell/workflow-artifacts/WorkflowArtifactBody.tsx", "utf8"),
  );
  const artifactPreview = normalize(
    await readFile(
      "packages/ui/src/app-shell/workflow-artifacts/WorkflowArtifactTilePreview.tsx",
      "utf8",
    ),
  );
  assert.ok(
    artifactBody.includes("fileReferenceRootPath={fileReferenceRootPath}") &&
      artifactBody.includes("workspacePath={workspacePath}") &&
      artifactPreview.includes("fileReferenceRootPath={markdownFileReferenceRootPath}") &&
      artifactPreview.includes("workspacePath={workspacePath}"),
    "完整产物正文与完成/运行缩略图都要把来源文档根交给 MessageResponse，同时保留 workspace 身份路径",
  );

  const planCard = normalize(
    await readFile("packages/ui/src/ToolCallBlocks/renderers/switch-mode.tsx", "utf8"),
  );
  assert.ok(
    planCard.includes("fileReferenceRootPath: sourceRootPath") &&
      planCard.includes("fileReferenceRootPath={documentReferenceRootPath}"),
    "计划内联预览和详情请求都必须使用同一来源根与文档目录优先级",
  );

  const planTab = normalize(await readFile("packages/ui/src/lib/workspaceSidePane.ts", "utf8"));
  assert.ok(
    planTab.includes("fileReferenceRootPath?: string") &&
      planTab.includes("fileReferenceRootPath: options.fileReferenceRootPath"),
    "plan detail request 的来源根必须完整透传并冻结到 tab",
  );

  const planPane = normalize(
    await readFile("packages/ui/src/app-shell/PlanDetailSidePane.tsx", "utf8"),
  );
  assert.ok(
    planPane.includes("tab.fileReferenceRootPath ?? tab.workspacePath") &&
      planPane.includes("fileReferenceRootPath={documentReferenceRootPath}"),
    "计划详情必须用 tab 冻结根解读 raw toolCall，并按计划文件目录解析正文链接",
  );
  const sessionPane = normalize(await readFile("packages/ui/src/v4/SessionPane.tsx", "utf8"));
  const planProducer = sessionPane.slice(
    sessionPane.indexOf("const handleOpenPlanDetail ="),
    sessionPane.indexOf("const handleOpenWorkflowRun ="),
  );
  assert.ok(
    planProducer.includes(
      "fileReferenceRootPath: request.fileReferenceRootPath ?? fileSearchRootPath",
    ) && planProducer.includes("[fileSearchRootPath, onOpenPlanDetail"),
    "状态面板的计划详情请求必须由所属 pane 补冻结根，已有来源根则保留",
  );
});

test("Automations saved workflow opens preserve the run cwd through the side-pane request", async () => {
  const openers = normalize(
    await readFile(
      "packages/ui/src/settings/saved-workflows/useSavedWorkflowRunOpeners.ts",
      "utf8",
    ),
  );
  assert.ok(
    openers.includes("fileReferenceRootPath: run.cwd?.trim() || target.workspacePath"),
    "saved run and artifact open requests must use the persisted run cwd, with legacy workspace fallback",
  );

  const shell = normalize(
    await readFile("packages/ui/src/app-shell/WorkspaceShellLayout.tsx", "utf8"),
  );
  assert.ok(
    shell.includes("fileReferenceRootPath: params.fileReferenceRootPath ?? targetWorkspacePath"),
    "the run cwd must be copied into both the run-detail and artifact side-tab requests",
  );
});

test("saved workflow navigation keeps explicit local targets independent of the active remote workspace", async () => {
  const shell = normalize(
    await readFile("packages/ui/src/app-shell/WorkspaceShellLayout.tsx", "utf8"),
  );
  for (const [start, end] of [
    ["const handleOpenSavedWorkflowRun =", "// 侧栏运行行"],
    ["const handleOpenSavedWorkflowArtifact =", "const handlePaneActiveSessionChange ="],
  ]) {
    const handler = shell.slice(shell.indexOf(start), shell.indexOf(end, shell.indexOf(start)));
    assert.ok(handler.includes("const targetWorkspaceIdentity = params.workspaceIdentity;"));
    assert.ok(handler.includes("findTaskNavigationWorkspaceTab(workspaceTabs, {"));
    assert.ok(!handler.includes("workspaceTabs.find("));
  }
  const sidebar = shell.slice(
    shell.indexOf("const handleOpenSidebarWorkflowRun ="),
    shell.indexOf("// 中枢的产物 chip"),
  );
  assert.match(sidebar, /findTaskNavigationWorkspaceTab\(\s*workspaceTabs,\s*target,?\s*\)/u);
});

test("sidebar workflow run opens freeze the exact local session root and reject stale lookups", async () => {
  const shell = normalize(
    await readFile("packages/ui/src/app-shell/WorkspaceShellLayout.tsx", "utf8"),
  );
  const handlerStart = shell.indexOf("const handleOpenSidebarWorkflowRun =");
  const handlerEnd = shell.indexOf("// 中枢的产物 chip", handlerStart);
  const handler = shell.slice(handlerStart, handlerEnd);
  const openKeysStart = shell.indexOf("const openWorkspaceKeys =");
  const openKeysEnd = shell.indexOf("// 保活回收", openKeysStart);
  const invalidationEffect = shell.slice(openKeysStart, openKeysEnd);
  assert.ok(
    handler.includes("resolveTaskExecutionWorkspaceServices({") &&
      handler.includes("baseServices,") &&
      handler.includes("if (!executionServices)") &&
      handler.includes("await resolveTaskExecutionWorkspacePath(executionServices, {") &&
      handler.includes("workspacePath: target.workspacePath,") &&
      handler.includes("sessionId: target.sessionId,") &&
      handler.includes("fileReferenceRootPath ? {fileReferenceRootPath} : {}") &&
      handler.includes("workspaceIdentity: target.workspaceIdentity") &&
      handler.includes("remoteSessionId: targetRemoteSessionId"),
    "sidebar run summaries omit cwd, so the host must query the exact session and freeze its execution root",
  );
  assert.ok(
    handler.includes("requestVersion !== sidebarWorkflowRunOpenGenerationRef.current") &&
      invalidationEffect.includes("activeTaskId,") &&
      invalidationEffect.includes("isSidePaneOpen,") &&
      invalidationEffect.includes("openWorkspaceKeys,") &&
      invalidationEffect.includes("sidePaneOwnerId,") &&
      invalidationEffect.includes("sidePaneState?.activeTabId,") &&
      invalidationEffect.includes("sidePaneState?.tabs,") &&
      invalidationEffect.includes("workspaceAbsPath,") &&
      invalidationEffect.includes("workspaceIdentity,") &&
      invalidationEffect.includes("workspaceRemoteSessionId,") &&
      invalidationEffect.includes(
        "return () => {sidebarWorkflowRunOpenGenerationRef.current += 1;};",
      ),
    "a newer click, workspace/session switch, side-pane change, or unmount must discard stale lookup results",
  );
});

test("workflow run side-pane scope carries the frozen root into successors and related tabs", async () => {
  const runPane = normalize(
    await readFile("packages/ui/src/app-shell/WorkflowRunSidePane.tsx", "utf8"),
  );
  assert.ok(
    runPane.includes("workflowRunTabScope(tab)") &&
      runPane.includes(
        "[tab.fileReferenceRootPath, tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath]",
      ),
    "workflow-run tab scope and its memo dependencies must include the frozen root",
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

test("workflow actor factory consumes the run cwd instead of the app's initial cwd", async () => {
  const source = normalize(
    await readFile("apps/zcode-cli/packages/bootstrap/src/app/create-app.ts", "utf8"),
  );
  const actorFactory = source.slice(
    source.indexOf("createActorRuntime: ({"),
    source.indexOf("// persona 不再经 request.opts.systemPrompt"),
  );
  assert.ok(actorFactory.includes("cwd: actorWorkingDirectory"));
  assert.ok(actorFactory.includes("workingDirectory: actorWorkingDirectory"));
});

test("real subagent runtime readiness reports cwd after persistence or resume", async () => {
  const source = normalize(
    await readFile("apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts", "utf8"),
  );
  assert.ok(source.includes("await request.onSessionReady?.(executionWorkspacePath)"));
  const ready = source.indexOf("await notifySessionReady(childRuntime.getWorkingDirectory())");
  assert.ok(ready > source.indexOf("await childRuntime.resumeFromStore("));
  assert.ok(
    ready > source.indexOf("await childRuntime.ensureSessionPersistedForExternalActivity("),
  );
});

test("script actor forwards live child cwd through the existing event sink", async () => {
  const child = normalize(
    await readFile(
      "apps/zcode-cli/packages/bootstrap/src/app/script-workflow-child-runtime.ts",
      "utf8",
    ),
  );
  assert.ok(child.includes("onSessionEvent: async (event, executionWorkspacePath) =>"));
  assert.ok(child.includes("childSessionId, executionWorkspacePath, event, traceContext"));
  const operations = normalize(
    await readFile(
      "apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts",
      "utf8",
    ),
  );
  assert.ok(operations.includes("record.app.sessionId, executionWorkspacePath,"));
});
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

test("dynamic workflow file actions prefer authorized journal cwd over the initial pane root", async () => {
  const read = async (path) => normalize(await readFile(path, "utf8"));
  const artifacts = await read("packages/ui/src/hooks/useWorkflowRunArtifacts.ts");
  assert.ok(
    artifacts.includes(normalize("setExecutionWorkspacePath(result.executionWorkspacePath);")),
  );
  assert.ok(artifacts.includes(normalize("setExecutionWorkspacePath(undefined);")));
  for (const [file, expected] of [
    [
      "packages/ui/src/app-shell/WorkflowArtifactSidePane.tsx",
      "fileReferenceRootPath={executionWorkspacePath ?? fileReferenceRootPath}",
    ],
    [
      "packages/ui/src/v4/ConversationWorkflowCompletion.tsx",
      "fileReferenceRootPath={state.executionWorkspacePath ?? fileReferenceRootPath}",
    ],
    [
      "packages/ui/src/app-shell/WorkflowWorkspaceSidePane.tsx",
      "workspace.executionWorkspacePath ?? fileReferenceRootPath ?? tab.workspacePath",
    ],
  ])
    assert.ok((await read(file)).includes(normalize(expected)), file);
  const panels = await read("packages/ui/src/hooks/useAppPanels.ts");
  assert.ok(
    panels.includes(normalize("openInBrowser(sourcePath, result.executionWorkspacePath);")),
  );
  assert.ok(!panels.includes(normalize("openInBrowser(knownSourcePath);")));
});
