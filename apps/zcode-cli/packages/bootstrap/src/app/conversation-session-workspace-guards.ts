import { lstatSync, type Stats } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { Logger } from "@zcode/contracts";

/**
 * 对话会话目录的**判据与护栏**：包含关系、两层目录可用性、复用门禁与降级日志。
 *
 * 与 `conversation-session-workspace.ts`（命名 / 规划 / 建目录 / 落盘）拆开的原因：那个模块的
 * 有效行数已顶到 400 行上限，而这一组函数是自洽的一类——它们只回答「这个路径、这层目录能不能
 * 用」，不建目录、不写库、不依赖会话状态，改动频率也低（每次都是「又发现一种坏占位形态」而加
 * 一层判据）。原导入路径保持可用：主模块把这些符号原样 re-export，调用方不需要改 import。
 */

/**
 * 日期目录不可用时 warn 的稳定原因值。
 *
 * 日志只报「哪一类问题」，不带任何真实路径：会话目录在用户数据根之下，CLI 日志规则禁止
 * 采集用户路径，这个 warn 只用于定位「当天的会话为什么没用独立目录」。
 */
export const CONVERSATION_SESSION_DATE_DIR_UNUSABLE_REASON = "date_dir_unusable";
/**
 * 会话目录本身（`<对话根>/<日期>/<名字>` 的末段）不可用时 warn 的稳定原因值。
 *
 * 与日期目录同一类问题的两个层次，日志必须能分辨：末段被用户放了一个同名文件/链接时该修的
 * 是那个名字，而不是「那一天的日期目录坏了」。
 */
export const CONVERSATION_SESSION_DIR_UNUSABLE_REASON = "session_dir_unusable";
export type ConversationSessionDirUnusableReason =
  | typeof CONVERSATION_SESSION_DATE_DIR_UNUSABLE_REASON
  | typeof CONVERSATION_SESSION_DIR_UNUSABLE_REASON;
/**
 * 本模块只需要 warn 一条日志能力：不把 bootstrap 绑死在某个日志实现上，调用方直接传
 * `context.logger` 即可；测试也可以给一个只收集消息的窄实现。
 */
export type ConversationSessionWorkspaceLogger = Pick<Logger, "warn">;

/**
 * 判断一个持久化路径是不是「对话根下的会话目录」。
 *
 * 严格包含：等于对话根（存量会话的旧值）返回 false，只有真正落在根之下才算。
 * 这是补发判定的唯一入口——存量会话与项目会话都在这里被排除。
 */
export function isConversationSessionWorkspacePath(
  candidate: string | undefined,
  conversationRoot: string | undefined,
): boolean {
  const root = conversationRoot?.trim();
  const path = candidate?.trim();
  if (!root || !path) {
    return false;
  }
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  // Windows 跨盘符时 `relative` 返回的是**绝对路径**（`D:\x`），首段不是 `..`，
  // 只按首段判定会把另一个盘上的同名目录当成会话目录。这个判定同时被 mkdir、身份投影、
  // 派生继承与恢复复用使用，护栏必须在这里（回收侧另有一份复检，见 reclaim 模块）。
  if (isAbsolute(relative(resolvedRoot, resolvedPath))) {
    return false;
  }
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel.length === 0) {
    return false;
  }
  // Windows 下 relative 用反斜杠；只看首段，避免路径中间出现 `..` 字面量时被误判。
  const segments = rel.split(/[\\/]/u);
  return segments[0] !== "..";
}

/**
 * 持久化路径是否「就是本规则铸造的会话目录」——未注入对话根标记时的兜底判据。
 *
 * 正常路径用对话根标记判定（`isConversationSessionWorkspacePath`）。但未注入标记也要能识别已经
 * 迁移过的会话：`path` 严格落在**工作区键路径**之下且不等于它，只有本规则铸造的会话目录长这样
 * （项目工作区与健康远端会话的 `directory` 与 `path` 恒相等；core 冷恢复也一律按 `session.path`
 * 取执行 cwd，见 core/src/runtime/methods/resume.ts）。两侧必须同口径，否则会出现
 * 「runtime 在会话目录、UI 快照回落对话根」或「cwd 指向已被删掉的目录」的分叉。
 */
export function isPersistedConversationExecutionPath(
  candidate: string | undefined,
  workspacePath: string,
): boolean {
  const path = candidate?.trim();
  if (!path || resolve(path) === resolve(workspacePath)) {
    return false;
  }
  return isConversationSessionWorkspacePath(path, workspacePath);
}

/**
 * `lstat` 但不跟随符号链接、且不抛错：拿不到（不存在 / 权限不足）返回 undefined。
 *
 * 必须用 `lstat` 而不是 `existsSync`：后者跟随符号链接，**悬空链接会被判成"不存在"**，
 * 于是占位护栏被绕过、`mkdir` 抛 ENOENT（会话创建永久失败，见 spec 已知边界 11）。
 */
export function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/**
 * 日期目录是否**可用作真目录**：缺席（会由 `mkdir(recursive)` 建出）或 `lstat` 意义上的真目录。
 *
 * 为什么必须单独判这一层：`resolveConversationSessionDirNameForCreate` 只 `lstat` 最后一段
 * `<日期>/<id8>`，而 `<日期>` 本身被占住时子路径的 `lstat` 一律 ENOENT（被判成"名字空闲"），
 * 于是：
 * - 普通文件 / 悬空链接 ⇒ 当天所有会话都用 8 位去 `mkdir`，报 ENOTDIR，整天确定性失败；
 * - 指向别处的**活链接** ⇒ `mkdir(recursive)` 跟随链接，把会话目录建到对话根之外：词法包含判定
 *   仍说"在根内"，而回收（`isRealDirectory`）与清扫（`dirent.isDirectory()`）都拒绝这种中间链接，
 *   目录永远不会被回收。
 * 因此符号链接一律不算可用（`lstat` 不跟随链接）。占位者不删、不修：那是用户的东西，
 * 本规则只把当天的会话降级回 `cwd = workspacePath`。
 */
export function isConversationSessionDateDirUsable(dateDir: string): boolean {
  const entry = lstatOrUndefined(dateDir);
  return entry === undefined || entry.isDirectory();
}

/**
 * 会话目录本身（`<对话根>/<日期>/<名字>`）是否可用作真目录：缺席（随后 `mkdir` 幂等补建）
 * 或 `lstat` 意义上的真目录。
 *
 * 日期目录那一层之外还要单独判这一层，理由与它同源（规则 8）：恢复/创建边界的复用一支随后
 * 会对持久化 `path` 直接 `ensureConversationSessionWorkspaceDir`（幂等 `mkdir`），末段被占住时
 * - 普通文件 ⇒ `mkdir` 报 EEXIST，整次恢复/导入**确定性失败**（规则 8 承诺的是降级）；
 * - 符号链接（含悬空）⇒ `mkdir(recursive)` 跟随链接，会话目录落到对话根之外，而词法包含判定、
 *   回收（`isRealDirectory`）与清扫（`dirent.isDirectory()`）都不认这种末段链接。
 * 老会话目录被用户删掉（缺席）不受影响：那正是恢复路径的正常输入，`mkdir` 会把它建回来。
 * 占位者一律不删、不修，本规则只把该会话降级回 `cwd = workspacePath`。
 */
export function isConversationSessionDirUsable(directory: string): boolean {
  const entry = lstatOrUndefined(directory);
  return entry === undefined || entry.isDirectory();
}

/**
 * 持久化执行 cwd 里「本规则铸造的那两层」不可用的稳定原因；可用（或缺省）返回 undefined。
 *
 * 单一实现：创建侧复用门禁（`isReusablePersistedConversationExecutionPath`）、恢复侧复用分支与
 * 两处的降级日志都读它，避免「门禁按一套判据、日志按另一套说」。
 * 顺序即优先级：先日期目录（父），再会话目录（末段）。
 */
export function classifyPersistedConversationExecutionPathUnusable(input: {
  conversationRoot: string | undefined;
  persistedPath: string | undefined;
}): ConversationSessionDirUnusableReason | undefined {
  const persisted = input.persistedPath?.trim();
  if (!persisted || !isConversationSessionWorkspacePath(persisted, input.conversationRoot)) {
    return undefined;
  }
  const directory = resolve(persisted);
  return isConversationSessionDateDirUsable(dirname(directory))
    ? isConversationSessionDirUsable(directory)
      ? undefined
      : CONVERSATION_SESSION_DIR_UNUSABLE_REASON
    : CONVERSATION_SESSION_DATE_DIR_UNUSABLE_REASON;
}

/**
 * 目录不可用时的唯一 warn：稳定 message + 稳定 reason，**不带任何真实路径**。
 *
 * 日志抛错必须吞掉：这个判定在会话创建/恢复的关键路径上，日志实现的问题不能改变裁决结果
 * （回收模块的 `logBestEffort` 是同一取舍）。
 */
export function warnConversationSessionDirUnusable(
  logger: ConversationSessionWorkspaceLogger | undefined,
  reason: ConversationSessionDirUnusableReason,
): void {
  try {
    logger?.warn("conversation session workspace disabled: session directory is not usable", {
      reason,
    });
  } catch {
    // 日志失败不影响「回退旧行为」这一结果。
  }
}
