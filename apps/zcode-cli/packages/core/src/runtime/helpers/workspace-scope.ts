/**
 * 工作区键路径（workspace key path）的唯一读取入口。
 *
 * 与「执行 cwd」的分工：
 * - 执行 cwd（`workingDirectory` / `workspaceRoot`）：文件读写、命令 cwd、相对路径解析、
 *   plan 文件、上下文快照里的 `path.cwd`。checkpoint/rewind 的路径基准是**创建该 checkpoint
 *   时的 cwd**（artifact 的 `workspaceRoot`，老数据回落到工作区键路径），见
 *   `resolveWorkspaceCheckpointRoot`。
 * - 工作区键路径（本函数）：项目记忆根、项目级配置/权限、projectID、workspace 级 MCP
 *   工程配置、按工作区分桶的存储与展示。
 *
 * 对话会话（未指定项目的会话）的执行 cwd 是每会话独立目录，工作区身份仍是「对话根」；
 * 两者混用会让上面这些 workspace 级能力按会话各建一份而静默失效。见
 * docs/specs/conversation-session-workspace.md 规则 9。
 *
 * `AgentRuntime` 构造时把 `config.workspacePath ?? workingDirectory` 写进
 * `workspaceScopeRoot`，所以真实 runtime 恒走第一支。之后只有 context 初始化会在
 * **没有 workspacePath**（CLI/TUI 独立运行）时把它收敛到本次会话的执行边界
 * （`methods/context.ts`，冷恢复需要覆盖已经过时的启动 cwd）；没有第二次推断。只有
 * **部分建模**的 runtime 替身（测试桩只给执行边界、不带 workspacePath）会走第二支——
 * 那正是「调用方没有 workspacePath 时会话的工作区键路径就是执行边界」的 CLI/TUI 语义，
 * 与规格「未注入即旧行为」一致。
 */
export function workspaceScopeRootOf(runtime: {
  workspaceScopeRoot?: string;
  workspaceRoot: string;
}): string {
  // 空串必须与缺席同义：`??` 只挡 `undefined`，而空串会一路走到
  // `resolve("")`（= 进程 cwd）去派生 projectID / 项目记忆根 / 技能发现根，
  // 让本函数"读点恒等于工作区键路径"的契约静默失效。畸形 `directory` 列
  // （空串落库）是唯一入口，代价只有一次长度判断。（`workspaceScopeRoot` 的
  // 两个赋值点都非空，此判断是契约护栏，不是常规分支。）
  const scopeRoot = runtime.workspaceScopeRoot;
  return scopeRoot !== undefined && scopeRoot.length > 0 ? scopeRoot : runtime.workspaceRoot;
}

/**
 * **工作区级机制**的根：`.zcodium` 下的工作区级产物（workflow 定义与草稿、skills/commands
 * 发现、hooks 发现、MCP 工程配置）按它定位。
 *
 * 与 `workspaceScopeRootOf` 的唯一区别在**没有 `config.workspacePath`** 的调用方（CLI/TUI
 * 独立运行、`-p` 脚本运行）：那里 `workspaceScopeRootOf` 返回 context 初始化时冻结的会话执行
 * 边界，而本函数返回**当前执行 cwd**——因为改动前这些读点用的就是 `workingDirectory`
 * （`context.workingDirectory`），Bash `cd` 之后必须继续跟随，否则 CLI/TUI 的行为会变
 * （见 docs/specs/conversation-session-workspace.md 规则 9）。
 *
 * 有 `workspacePath`（协议会话、项目/对话工作区）时两者同值：身份不随执行 cwd 漂移，
 * 对话会话的工作区级产物因此落在对话根，而不是每个会话目录各一份。
 *
 * 项目身份（`getProjectId`）、项目记忆根、持久化 agent memory 与 gen-ui 作用域**不**走本函数：
 * 它们必须与 `cd` 无关，见 `workspaceScopeRootOf`。
 * MCP 反过来与本函数同源（`methods/mcp.ts` 把它同时当池键与 stdio cwd）：协议会话里两者同值 =
 * 工作区键路径，CLI/TUI 里跟随当前执行 cwd —— 那是改动前 `this.workingDirectory` 的行为，
 * 本特性没有收窄它（收窄会让 `cd sub` 之后 MCP 池键与设置页入口分叉）。
 */
export function workspaceLevelRootOf(runtime: {
  config: { workspacePath?: string | undefined };
  workingDirectory?: string | undefined;
  workspaceRoot: string;
}): string {
  const declared = runtime.config.workspacePath;
  if (declared !== undefined && declared.length > 0) {
    return declared;
  }
  const live = runtime.workingDirectory;
  return live !== undefined && live.length > 0 ? live : runtime.workspaceRoot;
}
