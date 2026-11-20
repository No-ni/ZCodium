import { type TraceContext } from "@zcode/contracts";
import type { ContextBuildResult } from "../../context/types.js";
import { buildGitSystemContextSection } from "../../context/sections/env-info.js";
import {
  systemReminderAttachmentEntry,
  type RuntimeAttachmentEntry,
} from "../../agent/message-history.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { throwIfTurnAborted } from "../helpers/turn-errors.js";
import { lastAnnouncedAttachments } from "./context-announcement-inputs.js";

/**
 * Git 会话上下文每个窗口（会话开始或 compaction 之后的历史）只决定一次，只看历史：
 * 已有 Git 公告就沿用，什么都不读（切目录也不重读）。请求前已有 date 公告，说明本窗口的首个请求
 * 决定过（决定后同一批写入 date），也什么都不读：当时没有 Git、之后进入仓库或冷恢复后继续都一样。
 * 否则按当前目录读取 Git，是仓库才宣告；不在仓库时不宣告，并记住该目录（是否在仓库由文件系统查找
 * .git 决定，总是确定的）。compaction 为压缩后的历史决定：保留段已有 Git 公告就沿用，否则读取。
 * 新会话初始化时刚读过 Git，只给第一次判断用一次（目录未变时）；恢复的快照来自存储，不算。
 * 读到的 Git 只进入公告，不改 runtime 的 context 快照。
 * 修复原因：原来按「上一次构建结果里有没有 Git 段」决定是否读取；会话从非仓库目录开始，
 * 或在非仓库目录 compact 一次之后，进入仓库也永远不再宣告 Git。现在进入仓库后，从下一个窗口开始宣告。
 * 修复原因（date 判断）：非仓库窗口没有 Git 公告，"已决定"原来只记在 runtime 内存里；冷恢复后的
 * 新 runtime 又读 Git 并宣告，与环境公告里的 "Is a git repository: false" 矛盾。现在恢复的窗口与 live
 * 一样沿用历史、不读 Git；新 runtime 只在环境公告里报告自己读到的是否仓库。
 */
export async function resolveSessionContextAnnouncement(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[],
  occasion: "request" | "compaction",
  trace: TraceContext,
  signal?: AbortSignal,
): Promise<RuntimeAttachmentEntry | undefined> {
  // 子 agent 与自定义 system prompt 不带 Git（与 context builder 的分支相同）。
  if (runtime.config.subagentContext || runtime.config.systemPrompt?.trim()) return undefined;
  // 预取只服务第一次判断，不论这次历史里有没有 Git；否则很久之后的 compaction 会用到旧快照。
  const prefetched = runtime.sessionStartGitPrefetch === true;
  runtime.sessionStartGitPrefetch = false;
  const last = lastAnnouncedAttachments(entries);
  if (last.has("session_context")) return undefined;
  if (occasion === "request" && last.has("date")) return undefined;
  const directory = runtime.workingDirectory;
  // 本 runtime 已确认不是仓库的目录，之后的窗口不再检查。修复原因：不在仓库时每次判断都要跑一次
  // git 检查，慢文件系统上可能等到 git 命令超时。
  if (runtime.nonGitDirectories?.has(directory)) return undefined;
  const snapshot = runtime.contextSourceSnapshot;
  const port = runtime.contextSourcePort;
  if (!snapshot || !port) {
    // 没有 context port 时，会话起始快照是唯一的 Git 来源。
    return startSnapshotSessionContext(runtime);
  }
  if (prefetched && directory === snapshot.workingDirectory) {
    // 修复原因：起始快照原来分不清"确定不是仓库"与"没读到"，为空时不记住，第二个请求还要再查一次。
    // 现在它来自文件系统查找，说"不是仓库"就是确定结论，同样记住目录。
    if (snapshot.envInfo.isGitRepository === false) rememberNonGitDirectory(runtime, directory);
    return startSnapshotSessionContext(runtime);
  }
  const git = await port.resolveGitContext({ workingDirectory: directory, trace }, { signal });
  throwIfTurnAborted(signal);
  const content = buildGitSystemContextSection({ ...snapshot.envInfo, ...git })?.content;
  if (content) return systemReminderAttachmentEntry("session_context", content);
  if (git.isGitRepository === false) rememberNonGitDirectory(runtime, directory);
  return undefined;
}

/**
 * context 组成预演用的 Git 会话上下文：判断规则同 resolveSessionContextAnnouncement，但不做 IO、
 * 不消费 sessionStartGitPrefetch、不记住非仓库目录；需要读 Git 时一律取启动快照。
 */
export function previewSessionContextAnnouncement(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[],
  contextResult: ContextBuildResult | undefined,
): RuntimeAttachmentEntry | undefined {
  if (runtime.config.subagentContext || runtime.config.systemPrompt?.trim()) return undefined;
  const last = lastAnnouncedAttachments(entries);
  if (last.has("session_context") || last.has("date")) return undefined;
  if (runtime.nonGitDirectories?.has(runtime.workingDirectory)) return undefined;
  const content = contextResult?.metaUserAttachments.find(
    (item) => item.source === "session_context",
  )?.content;
  return content ? systemReminderAttachmentEntry("session_context", content) : undefined;
}

function rememberNonGitDirectory(runtime: AgentRuntimeInternal, directory: string): void {
  (runtime.nonGitDirectories ??= new Set()).add(directory);
}

function startSnapshotSessionContext(
  runtime: AgentRuntimeInternal,
): RuntimeAttachmentEntry | undefined {
  const content = runtime.latestContextBuildResult?.metaUserAttachments.find(
    (item) => item.source === "session_context",
  )?.content;
  return content ? systemReminderAttachmentEntry("session_context", content) : undefined;
}
export { rememberNonGitDirectory, startSnapshotSessionContext };
