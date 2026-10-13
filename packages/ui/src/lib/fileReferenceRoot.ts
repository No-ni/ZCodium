/**
 * 「相对路径解析根 + 这个根是否由会话事实证明」。
 *
 * 两个字段必须一起传：只传路径时调用方无从分辨「这是会话执行 cwd」还是「这是缺省回落的工作区
 * 键路径」，而两者的结论相反——回落值在对话工作区里意味着接收这批内容的会话**还没有自己的执行
 * 目录**（草稿预热未就绪 / 首帧身份不匹配），此时投相对路径会被首发会话按新铸的会话目录解析而
 * 找不到文件。
 *
 * `resolved` 的定义与两种来源（快照投影了 `workspacePath`；快照存在但没有该字段 ⇒ 该会话的 cwd
 * 恒等于工作区键路径）见 `@/v4/sessionWorkspacePath.js` 的 `resolvePaneFileSearchRoot`；
 * 产品规则见 docs/specs/conversation-session-workspace.md 规则 11 与已知边界 14。
 */
export interface FileReferenceRoot {
  /** 解析根：会话执行 cwd，任何一环缺省时回落工作区键路径（= 改动前行为）。 */
  rootPath: string;
  /** false = 根是回落值、接收方 cwd 未知 ⇒ 引用/提及必须写成绝对路径。 */
  resolved: boolean;
}
