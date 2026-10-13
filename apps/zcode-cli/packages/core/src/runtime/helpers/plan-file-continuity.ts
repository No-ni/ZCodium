import { join } from "node:path";
import {
  CoreErrorType,
  PLAN_MODE_MAX_PLAN_CHARS,
  createCoreError,
  isFileSystemPortError,
  type FileSystemPort,
  type SessionId,
  type TraceContext,
} from "@zcode/contracts";
import {
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";

const PLAN_FILE_REFERENCE_MAX_BYTES = PLAN_MODE_MAX_PLAN_CHARS * 4 + 1024;

function resolveApprovedPlanFilePath(input: {
  sessionId: SessionId | string;
  workspaceRoot: string;
}): string {
  return join(
    input.workspaceRoot,
    ".zcodium",
    "plans",
    `plan-${sanitizePlanFileSessionId(input.sessionId)}.md`,
  );
}

export async function writeApprovedPlanFile(input: {
  abortSignal?: AbortSignal;
  fileSystemPort: FileSystemPort;
  plan: string;
  sessionId: SessionId | string;
  traceContext?: TraceContext;
  workspaceRoot: string;
}): Promise<{ path: string }> {
  if (!input.plan.trim()) {
    throw createCoreError(CoreErrorType.InvalidInput, "ExitPlanMode plan cannot be empty", {
      recoverable: true,
    });
  }

  const path = resolveApprovedPlanFilePath(input);
  await input.fileSystemPort.writeTextFile(
    {
      atomic: true,
      content: input.plan,
      createParents: true,
      encoding: "utf8",
      path,
      trace: input.traceContext,
    },
    { signal: input.abortSignal },
  );
  return { path };
}

export async function readApprovedPlanFileReferenceEntry(input: {
  abortSignal?: AbortSignal;
  fileSystemPort: FileSystemPort;
  sessionId: SessionId | string;
  traceContext?: TraceContext;
  workspaceRoot: string;
  /**
   * 工作区键路径（老计划文件的落点）。
   *
   * 本特性把对话会话的执行 cwd 从工作区键路径改成会话独立目录，而**升级前**写下的计划文件仍住在
   * `<工作区键路径>/.zcodium/plans/`：只按执行 cwd 找会让这次压缩的「计划仍在进行」提醒静默消失
   * （文件从未被删，只是换了地方）。执行 cwd 下找不到时才回退到这里；两个根相等（CLI/TUI 独立运行、
   * 项目工作区、以及会话还没有独立目录）时不产生第二次读。
   *
   * 判据方向是「宁可不提醒，不读错文件」：先执行 cwd（本会话当前事实），命中即用；只有 not_found
   * 才看老落点，而计划文件名带会话 id、一个 id 只会有一个计划文件，因此回退读到的必然是本会话自己的
   * 老计划（不是别的会话的）。见 docs/specs/conversation-session-workspace.md 已知边界 25。
   */
  workspaceKeyRoot?: string;
}): Promise<RuntimeMessageEntry | undefined> {
  for (const workspaceRoot of resolveApprovedPlanFileReadRoots(input)) {
    const entry = await readApprovedPlanFileReferenceEntryAtRoot({
      ...input,
      workspaceRoot,
    });
    if (entry) return entry;
  }
  return undefined;
}

/** 计划文件的读取根次序：执行 cwd 优先，工作区键路径只在两者不同且前者没命中时兜底。 */
function resolveApprovedPlanFileReadRoots(input: {
  workspaceRoot: string;
  workspaceKeyRoot?: string;
}): string[] {
  const executionRoot = input.workspaceRoot.trim();
  const keyRoot = input.workspaceKeyRoot?.trim();
  if (!keyRoot || keyRoot === executionRoot) return [executionRoot];
  return [executionRoot, keyRoot];
}

async function readApprovedPlanFileReferenceEntryAtRoot(input: {
  abortSignal?: AbortSignal;
  fileSystemPort: FileSystemPort;
  sessionId: SessionId | string;
  traceContext?: TraceContext;
  workspaceRoot: string;
}): Promise<RuntimeMessageEntry | undefined> {
  const path = resolveApprovedPlanFilePath(input);
  let content: string;
  try {
    const read = await input.fileSystemPort.readTextFile(
      {
        maxBytes: PLAN_FILE_REFERENCE_MAX_BYTES,
        path,
        trace: input.traceContext,
      },
      { signal: input.abortSignal },
    );
    content = read.content;
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "not_found") {
      return undefined;
    }
    throw error;
  }

  if (!content.trim()) return undefined;
  return systemReminderAttachmentEntry(
    "plan_file_reference",
    formatPlanFileReference({ planContent: content, planFilePath: path }),
  );
}

function formatPlanFileReference(input: { planContent: string; planFilePath: string }): string {
  return [
    `A plan file exists from plan mode at: ${input.planFilePath}`,
    "",
    "Plan contents:",
    "",
    input.planContent,
    "",
    "If this plan is relevant to the current work and not already complete, continue working on it.",
  ].join("\n");
}

function sanitizePlanFileSessionId(sessionId: SessionId | string): string {
  const sanitized = String(sessionId)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!sanitized) {
    throw createCoreError(
      CoreErrorType.InvalidInput,
      "Session id cannot produce a plan file name",
      {
        recoverable: false,
      },
    );
  }
  return sanitized;
}
