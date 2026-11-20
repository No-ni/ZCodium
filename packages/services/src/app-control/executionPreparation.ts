import { createHash } from "node:crypto";
import { completeNewModelSelection, validateModelSelectionOptions } from "@zcode/provider";
import {
  SessionControlError,
  type AppSessionRef,
  type AppTrustedContext,
  type MutationResult,
} from "@zcode/session-control/contracts";
import { type CommandAck, type ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { ProjectDirectories } from "#src/project/contract.js";
import type { AppControlServiceDependencies } from "#src/app-control/contract.js";

export function appControlCommandId(context: AppTrustedContext, requestId: string): string {
  return `app-control-${createHash("sha256")
    .update(JSON.stringify([context.callerId, requestId]))
    .digest("hex")}`;
}

function delivery(value: "startNow" | "queue" | "guide" | undefined) {
  return value === "startNow"
    ? ("start_now" as const)
    : value === "queue"
      ? ("queued" as const)
      : ("unknown" as const);
}

function mutation(ack: CommandAck, requestId: string): MutationResult {
  return {
    requestId,
    status:
      ack.status === "accepted" || ack.status === "duplicate" || ack.status === "noop"
        ? "applied"
        : "rejected",
    ...(ack.reasonCode ? { reason: ack.reasonCode } : {}),
  };
}

export async function resolveAppCreationDirectories(
  sourceServerId: string,
  directories: ProjectDirectories,
  resolveIdentity?: (workspacePath: string) => Promise<string>,
): Promise<ProjectDirectories> {
  if (sourceServerId === "local") return directories;
  if (!resolveIdentity)
    throw new SessionControlError(
      "unavailable",
      "Remote creation identity resolver is unavailable",
    );
  const workspaceIdentity = await resolveIdentity(directories.workspacePath);
  if (!workspaceIdentity.trim())
    throw new SessionControlError("unavailable", "Remote creation identity is unavailable");
  if (directories.workspaceIdentity && directories.workspaceIdentity !== workspaceIdentity)
    throw new SessionControlError("conflict", "Remote creation identity changed");
  return { ...directories, workspaceIdentity };
}

export async function resolveAppForkBoundary(
  agent: AppControlServiceDependencies["agent"],
  session: AppSessionRef,
  atMessage: string,
  initial: ConversationSnapshot,
  signal?: AbortSignal,
): Promise<{
  target: { rowId: number; entityId: string };
  baseRevision: number;
  baseLogEpoch: string;
}> {
  let rows = initial.rows.window;
  let revision = initial.revision;
  let more =
    initial.rows.firstRowId !== null &&
    (rows.length === 0 || rows[0]!.rowId > initial.rows.firstRowId);
  let before = rows[0]?.rowId;
  while (true) {
    if (signal?.aborted) throw new SessionControlError("cancelled", "Fork lookup cancelled");
    // ReadSession 返回 transcript messageId；新投影 entityId/assistantResponseId 均由该事实派生。
    // 同一 response 可能有多段正文，只选择 owner 标为 canFork 的稳定轮尾段。
    const row = rows.findLast(
      (item) =>
        item.kind === "assistantText" &&
        (item.assistantResponseId === atMessage || item.entityId === atMessage) &&
        item.actions?.canFork,
    );
    if (row) {
      if (!row.actions?.canFork || !row.entityId)
        throw new SessionControlError("unavailable", "Message is not a stable fork boundary");
      return {
        target: { rowId: row.rowId, entityId: row.entityId },
        baseRevision: revision,
        baseLogEpoch: initial.logEpoch,
      };
    }
    if (!more) throw new SessionControlError("unavailable", "Stable fork message was not found");
    const page = await agent.conversationRowsRangeV4({
      workspacePath: session.workspacePath,
      workspaceIdentity: session.workspaceIdentity,
      sessionId: session.sessionId,
      beforeRowId: before,
      limit: 200,
    });
    if (page.atLogEpoch !== initial.logEpoch)
      throw new SessionControlError("conflict", "Fork history changed owner epoch");
    const next = page.rows[0]?.rowId;
    if (page.rows.length === 0 || (before !== undefined && (next === undefined || next >= before)))
      throw new SessionControlError("unavailable", "Fork history cursor did not advance");
    rows = page.rows;
    revision = page.atRevision;
    more = page.hasMore;
    before = next;
  }
}

/**
 * 把 `modelId` 或 `providerId/modelId` 解析成完整选择（createSession 与客户端的 sendToSession 共用，§18.1 H10）。
 * 没给 model 时用偏好选择。必须唯一匹配、provider 不能隐藏、选项合法，否则不发命令。
 */
async function resolveModelSelection(
  models: AppControlServiceDependencies["models"],
  model: string | undefined,
) {
  const view = await models.getView();
  let selection = view.preferredSelection;
  if (model) {
    const matches = view.providers.flatMap((provider) =>
      provider.models
        .filter(
          (candidate) =>
            candidate.modelId === model || `${provider.providerId}/${candidate.modelId}` === model,
        )
        .map((candidate) => ({ providerId: provider.providerId, modelId: candidate.modelId })),
    );
    if (matches.length !== 1)
      throw new SessionControlError("invalid_input", "Model selection is missing or ambiguous");
    selection = completeNewModelSelection(view, matches[0]!);
  }
  const provider = view.providers.find((item) => item.providerId === selection?.providerId);
  const resolved = provider?.models.find((item) => item.modelId === selection?.modelId);
  if (
    !selection ||
    !resolved ||
    provider?.config.visibility === "hidden" ||
    !validateModelSelectionOptions(resolved, selection).ok
  )
    throw new SessionControlError(
      "unavailable",
      "A complete executable model selection is required",
    );
  return { ...selection, options: { ...selection.options } };
}
export { delivery, mutation, resolveModelSelection };
