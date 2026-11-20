import { formatLocalIsoDate, type TraceContext } from "@zcode/contracts";
import { buildCurrentDateSection } from "../../context/sections/current-date.js";
import type { ContextBuildResult } from "../../context/types.js";
import {
  buildEnvironmentAnnouncement,
  buildModelSection,
  environmentSnapshot,
  isEnvInfoGitRepository,
  type EnvironmentSnapshot,
} from "../../context/sections/env-info.js";
import {
  systemReminderAttachmentEntry,
  type RuntimeAttachmentEntry,
} from "../../agent/message-history.js";
import {
  buildDateChangeReminderBody,
  buildOutputStyleInstructionsBody,
  OUTPUT_STYLE_RESET_REMINDER,
} from "../helpers/runtime-reminders.js";
import { querySourceForTask } from "./turn-model-step-usage.js";
import { commitTurnRequestEntries } from "./turn-output-token-continuation.js";
import type { TurnRequestState } from "./turn-loop-state.js";
import { countContextPrefixMessages } from "../deps.js";
import type { Model, OutputStylePromptConfig } from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { buildContextHistoryEntries } from "./context-history-entries.js";
import { throwIfTurnAborted } from "../helpers/turn-errors.js";
import { buildProjectionAnchor } from "./projection-anchor.js";
import { persistRuntimeReminderMessage } from "./runtime-reminder-persistence.js";
import { supersedeContextComposition } from "../context-composition/state.js";
import { promptSnapshotFor } from "../helpers/prompt-snapshot.js";
import { resolveGenUiOutputDirectory } from "../helpers/gen-ui-output.js";
import {
  fullInstructionAttachment,
  announcedInstructionFiles,
  environmentOf,
  latestAnnouncedEnvironment,
  environmentAttachment,
  lastAnnouncedAttachments,
} from "./context-announcement-inputs.js";
import { resolveSessionContextAnnouncement } from "./context-session-announcement.js";
import {
  currentInstructions,
  buildInstructionAnnouncement,
} from "./context-instruction-announcement.js";

export {
  resolveSessionContextAnnouncement,
  previewSessionContextAnnouncement,
} from "./context-session-announcement.js";

export { restateContextAfterCompact } from "./context-compact-restatement.js";

export { latestAnnouncedEnvironment } from "./context-announcement-inputs.js";

export function rebuildContextPrefix(
  runtime: AgentRuntimeInternal,
  options: { model?: Model; turnRequestEntries?: readonly RuntimeMessageEntry[] } = {},
): readonly RuntimeMessageEntry[] {
  // 通知在 microtask 之后才发出（bootstrap tracker 合并），届时下面的同步重建已经完成。
  supersedeContextComposition(runtime, "context_prefix");
  if (!runtime.contextBuilder || !runtime.contextInitialized) {
    // 首轮 context 初始化前，model/outputStyle/language 变更只能刷新同步预览，
    // 不能把 config-only fallback envInfo 写入 config.envInfo。否则真实 context source
    // 会以为 envInfo 已由外部显式提供，跳过平台和 git 探测。
    if (runtime.contextBuilder) {
      runtime.contextBuilder = runtime.createContextBuilderFromSnapshot(
        runtime.createConfigOnlyContextSnapshot(runtime.workingDirectory),
        runtime.memoryRoot,
        {
          memoryIndexContent: runtime.memoryIndexContent,
          model: options.model,
          persistEnvInfo: false,
        },
      );
    }
    return options.turnRequestEntries ?? runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  }

  const contextSnapshot =
    runtime.contextSourceSnapshot ??
    runtime.createConfigOnlyContextSnapshot(runtime.workingDirectory);
  runtime.contextBuilder = runtime.createContextBuilderFromSnapshot(
    contextSnapshot,
    runtime.memoryRoot,
    { memoryIndexContent: runtime.memoryIndexContent, model: options.model },
  );
  const effectiveContextResult = runtime.contextBuilder.build();
  // 主会话的 prompt 快照适用于这个模型时，system 用快照记录的字节，不用当前代码的渲染结果。
  // 修复原因：system 原来每次按当前代码重建，升级或冷恢复后已发送的前缀字节改变，prompt cache 失效。
  const snapshot = promptSnapshotFor(runtime, options.model);
  const contextEntries: RuntimeMessageEntry[] = snapshot
    ? snapshot.system.map((message) => ({ message: structuredClone(message) }))
    : buildContextHistoryEntries(effectiveContextResult);
  const canonicalEntries = runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  const canonicalConversationEntries = canonicalEntries.slice(
    countContextPrefixMessages(canonicalEntries),
  );

  runtime.latestContextBuildResult = effectiveContextResult;
  runtime.messageHistory.replaceMessages([...contextEntries, ...canonicalConversationEntries]);

  const turnEntries = options.turnRequestEntries;
  if (!turnEntries) return runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  return [...contextEntries, ...turnEntries.slice(countContextPrefixMessages(turnEntries))];
}

// 输入附件中的环境、模型与 output style 指令（environment → model → output_style_instructions）。
// ToolSearch 公告、agent listing、skills 由 turn-loop 紧随其后追加。
export async function appendRuntimeContextAnnouncements(
  runtime: AgentRuntimeInternal,
  state: TurnRequestState,
  model: Model,
  outputStyle: OutputStylePromptConfig | undefined,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<void> {
  const contextResult = runtime.latestContextBuildResult;
  const environment = announcesEnvironment(contextResult)
    ? await resolveCurrentEnvironment(
        runtime,
        latestAnnouncedEnvironment(state.entries),
        traceContext,
        signal,
      )
    : undefined;
  const attachments = buildRuntimeContextAnnouncements(runtime, state.entries, {
    contextResult,
    environment,
    model,
    outputStyle,
  });
  throwIfTurnAborted(signal);
  await persistAnnouncements(runtime, state, attachments, traceContext);
}

function announcesEnvironment(contextResult: ContextBuildResult | undefined): boolean {
  return contextResult?.sections.some((section) => section.source === "env_info") === true;
}

/**
 * 环境、模型与 output style 指令公告的纯计算部分；当前环境由调用方先读好传入。
 * 输入附件收集（读当前环境）与 context 组成预演（只用历史或启动快照）共用，二者产出同一组公告。
 */
export function buildRuntimeContextAnnouncements(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[],
  input: {
    contextResult: ContextBuildResult | undefined;
    environment: EnvironmentSnapshot | undefined;
    model: Model;
    outputStyle: OutputStylePromptConfig | undefined;
  },
): RuntimeAttachmentEntry[] {
  if (!announcesEnvironment(input.contextResult)) return [];
  const last = lastAnnouncedAttachments(entries);
  const attachments: RuntimeAttachmentEntry[] = [];
  const previous = environmentOf(last.get("environment"))?.snapshot;
  const hasFullBlock = entries.some((entry) => environmentOf(entry)?.full);
  // 环境公告带 Desktop 段与会话的 Gen UI 输出目录（withDesktopContext，纯计算，不建目录）：
  // 正式请求与 context 组成预演走同一份规则，预演出的环境公告与真实首个请求一致。
  const environment = input.environment && withDesktopContext(runtime, input.environment);
  const announcement = environment
    ? buildEnvironmentAnnouncement(environment, previous, hasFullBlock)
    : null;
  if (announcement) attachments.push(environmentAttachment(announcement));
  const identity = buildModelSection(input.model)!;
  if (last.get("model")?.content !== identity.content) {
    attachments.push(systemReminderAttachmentEntry("model", identity.content));
  }
  // output style 只对主线程宣告。内容与最近一次宣告不同时再宣告；
  // 清除风格时，若最近一次宣告的是某个风格，宣告一次重置。
  if (querySourceForTask(runtime.config.taskType) === "main_turn") {
    const previousStyle = last.get("output_style_instructions")?.content;
    const instructions =
      buildOutputStyleInstructionsBody(input.outputStyle) ??
      (previousStyle === undefined ? undefined : OUTPUT_STYLE_RESET_REMINDER);
    if (instructions !== undefined && instructions !== previousStyle) {
      attachments.push(systemReminderAttachmentEntry("output_style_instructions", instructions));
    }
  }
  return attachments;
}

/**
 * 不做 IO 的当前环境：沿用历史里最近一次公告（没有时用启动快照），只换上当前 cwd 与 shell。
 * 输入附件收集在目录未变时用它；context 组成预演一律用它（不重新探测仓库属性）。
 */
export function baselineCurrentEnvironment(
  runtime: AgentRuntimeInternal,
  previous: EnvironmentSnapshot | undefined,
): EnvironmentSnapshot | undefined {
  const initial = runtime.contextSourceSnapshot?.envInfo ?? runtime.config.envInfo;
  const additionalWorkingDirectories = runtime.config.additionalDirectories ?? [];
  const baseline =
    previous ?? (initial ? environmentSnapshot(initial, additionalWorkingDirectories) : undefined);
  if (!baseline) return undefined;
  return {
    ...baseline,
    cwd: runtime.workingDirectory,
    shell: runtime.config.bashShellSelection?.display.name ?? baseline.shell,
    additionalWorkingDirectories: [...additionalWorkingDirectories],
  };
}

async function resolveCurrentEnvironment(
  runtime: AgentRuntimeInternal,
  previous: EnvironmentSnapshot | undefined,
  trace: TraceContext,
  signal?: AbortSignal,
): Promise<EnvironmentSnapshot | undefined> {
  const initial = runtime.contextSourceSnapshot?.envInfo ?? runtime.config.envInfo;
  const additionalWorkingDirectories = runtime.config.additionalDirectories ?? [];
  const baseline =
    previous ?? (initial ? environmentSnapshot(initial, additionalWorkingDirectories) : undefined);
  if (!baseline) return undefined;
  const cwd = runtime.workingDirectory;
  const shell = runtime.config.bashShellSelection?.display.name;
  const port = runtime.contextSourcePort;
  if (cwd === baseline.cwd || !port) {
    const current = baselineCurrentEnvironment(runtime, previous)!;
    if (!runtime.repositoryRecheckPending || !port) return current;
    // 修复原因：目录不变时沿用历史，冷恢复后的新 runtime 就一直报告存储里的"是否仓库"；
    // 会话中途 git init 后冷恢复，环境公告仍写 false。新 runtime 第一次公告重读一次，只取是否仓库，
    // 平台、shell、系统版本仍沿用历史。
    const facts = await port.resolveEnvironment(
      { workingDirectory: cwd, effectiveShellDisplayName: shell, trace },
      { signal },
    );
    throwIfTurnAborted(signal);
    runtime.repositoryRecheckPending = false;
    return { ...current, isGitRepository: isEnvInfoGitRepository(facts) };
  }
  // 新目录的仓库属性必须重新探测，不能沿用起始目录冻结的 envInfo。
  const facts = await port.resolveEnvironment(
    { workingDirectory: cwd, effectiveShellDisplayName: shell, trace },
    { signal },
  );
  throwIfTurnAborted(signal);
  runtime.repositoryRecheckPending = false;
  // cwd/shell 与事实来自同一次读取，公告自洽。IO 期间的变化不重试：
  // 历史是唯一基线，下一次请求比较最新公告与当前状态时再宣告。
  return environmentSnapshot(
    { ...facts, cwd, shell: shell ?? facts.shell },
    additionalWorkingDirectories,
  );
}

/**
 * context builder 加了 Desktop 段（zcode_desktop，且不是 custom system prompt、workflow 子代理、subagent）时，
 * 环境公告带 Desktop 段与会话的 Gen UI 输出目录；否则都不带。
 * 目录按 sessionId 取（默认当前会话）；fork 时传子会话 id，给子会话写入环境更新（buildChildEnvironmentUpdate）。
 * fork 到另一个 cwd 时再传子会话的 workspace 路径（即它的 cwd），目录与子会话自己的公告用同一个键。
 */
function withDesktopContext(
  runtime: AgentRuntimeInternal,
  snapshot: EnvironmentSnapshot,
  sessionId: string = runtime.sessionId,
  workspacePath?: string,
): EnvironmentSnapshot {
  const { visualizationDirectory: _directory, desktopContext: _desktop, ...current } = snapshot;
  if (
    !runtime.latestContextBuildResult?.sections.some(
      (section) => section.source === "desktop_context",
    )
  )
    return current;
  // 工作树只改变执行 cwd，身份仍取项目 scope；与真实子 runtime 使用相同输出键。
  const directory = resolveGenUiOutputDirectory(runtime, sessionId, undefined, workspacePath);
  return {
    ...current,
    desktopContext: true,
    ...(directory ? { visualizationDirectory: directory } : {}),
  };
}

/**
 * fork 给子会话写的环境更新：其余事实沿用 previous（子会话恢复后的模型视图里最近一次公告），Desktop 段与
 * Gen UI 目录按 runtime 当前状态重新取，目录用子会话 id；没有变化时返回 undefined。
 * 修复原因：原来整份沿用父会话的事实、只换目录，"是否在 Desktop"也照抄父会话。在终端里分叉来自 Desktop
 * 的会话时，更新仍带整段 Desktop 说明，与子会话实际的运行面不符。现在与普通环境公告共用 withDesktopContext。
 * 修复原因：fork 到受管 worktree 时子会话换了 cwd，原来 cwd 沿用父会话、目录按父会话的 workspace 路径计算。
 * 子会话第一个请求若是新轮通知，模型看到的工作目录是父会话的，可能用绝对路径改动父会话目录里的文件，
 * 而不是 worktree 里的；生成的文件也写进按父会话路径算出的目录，不是子会话自己的目录。
 * 现在传入 childCwd 时 cwd 取它，目录也按它计算。
 */
export function buildChildEnvironmentUpdate(
  runtime: AgentRuntimeInternal,
  previous: EnvironmentSnapshot,
  childSessionId: string,
  hasFullBlock: boolean,
  childCwd?: string,
): RuntimeAttachmentEntry | undefined {
  const child = childCwd ? { ...previous, cwd: childCwd } : previous;
  const announcement = buildEnvironmentAnnouncement(
    withDesktopContext(runtime, child, childSessionId, childCwd),
    previous,
    hasFullBlock,
  );
  return announcement ? environmentAttachment(announcement) : undefined;
}

/**
 * 给定历史里没有 skill 列表、且当前目录不为空时返回完整列表。
 * 输入附件收集对比整段历史，compaction 对比保留段（否则 compact 后第一次请求没有 skill 名单）。
 * 目录变化不在这里宣告，由 refreshRestoredAnnouncements 在加载历史时原位更新。
 */
export function collectSkillsListing(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[],
  contextResult: ContextBuildResult | undefined = runtime.latestContextBuildResult,
): RuntimeAttachmentEntry | undefined {
  const content = currentSkillsListing(contextResult);
  if (!content || lastAnnouncedAttachments(entries).has("skills_listing")) return undefined;
  return systemReminderAttachmentEntry("skills_listing", content);
}

/**
 * 从库加载历史后（冷恢复、rewind），已恢复的 skill 列表按 runtime 当前目录原位更新：
 * 内容不同就在原位置改成当前内容，当前为空就删除。只改内存，库里的记录只决定位置，每次加载都重新套用。
 * 目录只在 runtime 启动时读取，运行中不变；内容变化时之前的请求字节变一次，prompt cache 失效一次。
 * 指令公告（含 Memory 索引）不在这里处理：发出后不改写，变化由请求前公告追加增量。
 */
export function refreshRestoredAnnouncements(runtime: AgentRuntimeInternal): void {
  if (!runtime.latestContextBuildResult) return;
  const current = currentSkillsListing(runtime.latestContextBuildResult);
  const entries = runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  const isStale = (entry: RuntimeMessageEntry) =>
    entry.kind === "attachment" &&
    entry.metadata.source === "skills_listing" &&
    entry.content !== current;
  if (!entries.some(isStale)) return;
  runtime.messageHistory.replaceMessages(
    entries.flatMap((entry) => {
      if (entry.kind !== "attachment" || !isStale(entry)) return [entry];
      return current ? [{ ...entry, content: current }] : [];
    }),
  );
}

function currentSkillsListing(contextResult: ContextBuildResult | undefined): string | undefined {
  return contextResult?.metaUserAttachments.find((item) => item.source === "skills_listing")
    ?.content;
}

export async function appendRuntimeSkillsAnnouncement(
  runtime: AgentRuntimeInternal,
  state: TurnRequestState,
  traceContext: TraceContext,
): Promise<void> {
  const entry = collectSkillsListing(runtime, state.entries);
  await persistAnnouncements(runtime, state, entry ? [entry] : [], traceContext);
}

/**
 * 请求前公告：instructions → session_context → date。
 * 每次模型请求前都运行，不受输入附件的跳过规则影响。
 */
export async function appendRequestAnnouncements(
  runtime: AgentRuntimeInternal,
  state: TurnRequestState,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<void> {
  const sessionContext = await resolveSessionContextAnnouncement(
    runtime,
    state.entries,
    "request",
    traceContext,
    signal,
  );
  await persistAnnouncements(
    runtime,
    state,
    buildRequestAnnouncements(runtime, state.entries, sessionContext),
    traceContext,
  );
}

/**
 * 按给定历史去重后需要宣告的请求前公告。
 * 指令文件（含 Memory 索引）按已公告的文件比较，见 buildInstructionAnnouncement；增量的 reason
 * 取 runtime 状态（启动时 session_start，compaction 提交重读后 compaction）。
 * compact 移除旧公告后按剩余历史重新宣告一次。Git 会话上下文由调用方按同一规则先读好传入。
 */
export function buildRequestAnnouncements(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[],
  sessionContext?: RuntimeAttachmentEntry,
  contextResult: ContextBuildResult | undefined = runtime.latestContextBuildResult,
): RuntimeAttachmentEntry[] {
  const instructions = buildInstructionAnnouncement(
    currentInstructions(contextResult),
    entries,
    runtime.instructionRefreshReason ?? "session_start",
    runtime.unreadableInstructionPaths,
  );
  return [
    ...(instructions ? [instructions] : []),
    ...buildSessionContextAndDate(runtime, entries, sessionContext),
  ];
}

function buildSessionContextAndDate(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[],
  sessionContext?: RuntimeAttachmentEntry,
): RuntimeAttachmentEntry[] {
  const attachments = sessionContext ? [sessionContext] : [];
  const previousDate = lastAnnouncedAttachments(entries).get("date");
  // 日期一律取运行时时钟：context snapshot 的日期在会话起点冻结，跨天 compact 后
  // 剩余历史没有日期公告时，回退到它会先宣告一次过期日期。
  const date = formatLocalIsoDate(runtime.now());
  const initialDate = buildCurrentDateSection(date)!.content;
  const changedDate = buildDateChangeReminderBody(date);
  if (previousDate?.content !== initialDate && previousDate?.content !== changedDate) {
    attachments.push(
      systemReminderAttachmentEntry("date", previousDate ? changedDate : initialDate),
    );
  }
  return attachments;
}

/**
 * compaction 放在 summary 之前的请求前公告：保留段已有的来源不重复，date 也按来源判断。
 * date 不比较内容：保留段里是过期日期时，summary 前若再加一条日期变化，
 * 下一次请求又以保留段里的旧日期为基准追加一条，同一请求出现两次。
 * 指令公告只认完整块：保留段有完整块时不放，内容变化由下一次请求追加增量；保留段没有完整块时
 * （只有增量也算没有）放完整块，内容取 instructionSource（compaction 重读的结果，提交前不交给 runtime）。
 * 修复原因：原来指令公告例外，保留段有完整块且内容变化时在 summary 之前放增量；增量落在保留段之前，
 * 与保留段里的旧公告顺序颠倒，下一次请求以保留段的旧公告为最新，又追加一次同样的增量。
 */
export function buildCompactLeadingAnnouncements(
  runtime: AgentRuntimeInternal,
  keptEntries: readonly RuntimeMessageEntry[],
  sessionContext?: RuntimeAttachmentEntry,
  instructionSource: ContextBuildResult | undefined = runtime.latestContextBuildResult,
): RuntimeAttachmentEntry[] {
  const kept = lastAnnouncedAttachments(keptEntries);
  const current = announcedInstructionFiles(keptEntries)
    ? undefined
    : currentInstructions(instructionSource);
  return [
    ...(current ? [fullInstructionAttachment(current)] : []),
    ...buildSessionContextAndDate(runtime, keptEntries, sessionContext).filter(
      (entry) => !kept.has(entry.metadata.source),
    ),
  ];
}

export async function persistAnnouncements(
  runtime: AgentRuntimeInternal,
  state: TurnRequestState,
  attachments: readonly RuntimeAttachmentEntry[],
  traceContext: TraceContext,
  model?: Model,
): Promise<void> {
  for (const entry of attachments) {
    // 持久化成功才算已宣告；同一历史同时负责恢复、去重和 provider 投影。
    // 与 ToolSearch 公告、compaction 附件同一种隐藏提醒记录：不写顶层 source，
    // 旧版本 App 按封闭列表校验该字段，新值会让它拒绝整个会话。
    // 隐藏提醒不是对话消息，不移动对话指针（compaction 覆盖边界、timeline 锚点读它）。
    await persistRuntimeReminderMessage.call(runtime, entry, traceContext, {
      model,
      anchor: buildProjectionAnchor(traceContext, "synthetic"),
    });
    commitTurnRequestEntries(runtime, state, [entry]);
  }
}
