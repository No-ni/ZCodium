import {
  type AppOperationRef,
  type AppSessionRef,
  type OperationSnapshot,
} from "@zcode/session-control/contracts";
import {
  type CommandAck,
  type CommandQueryTurn,
  type ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import { zcodeProtocolErrorCodes, zcodeTurnStartedEventPayloadSchema } from "@zcode/shared";
import {
  ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE,
  type IZCodeAgentService,
} from "#src/zcode-agent/zcodeAgent.js";

/** 只读已活跃 session；缺 runtime 是明确未知，不订阅/恢复历史。 */
export async function readAppLiveSummary(
  agent: IZCodeAgentService,
  session: AppSessionRef,
): Promise<
  { status: "unknown" | "idle" | "running" | "needs_attention"; executionId?: string } | undefined
> {
  const target = {
    workspacePath: session.workspacePath,
    workspaceIdentity: session.workspaceIdentity,
    sessionId: session.sessionId,
    runtimePolicy: "existing-only" as const,
  };
  try {
    const snapshot = await agent.readSession({
      ...target,
      messageLimit: 1,
      contentProfile: "index",
    });
    const turnId = snapshot.runtime.activeTurnId;
    const status =
      snapshot.projection.pendingPermissions.length > 0 ||
      snapshot.runtime.pendingRequestIds?.length > 0 ||
      snapshot.projection.status === "waiting"
        ? ("needs_attention" as const)
        : turnId || snapshot.projection.status === "running"
          ? ("running" as const)
          : snapshot.projection.status === "idle" || snapshot.projection.status === "completed"
            ? ("idle" as const)
            : ("unknown" as const);
    if (!turnId) return { status };
    // 旧事件接口只支持 tail limit，不能把 afterSeq 当成向前分页。逐级扩大有界窗口，
    // 长轮超过保留窗口时保持无 executionId，禁止把 turnId/lease runId 充当停止凭据。
    for (const limit of [200, 1_000, 5_000]) {
      const events = await agent.readSessionEvents({ ...target, limit });
      const started = events.findLast(
        (event) =>
          event.sessionId === session.sessionId &&
          event.turnId === turnId &&
          event.type === "turn.started",
      );
      const payload = started
        ? zcodeTurnStartedEventPayloadSchema.safeParse(started.payload)
        : undefined;
      if (payload?.success && payload.data.foregroundExecutionId)
        return { status, executionId: payload.data.foregroundExecutionId };
      if (events.length < limit) break;
    }
    return { status };
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (
      code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE ||
      code === zcodeProtocolErrorCodes.sessionUnavailable
    )
      return undefined;
    throw error;
  }
}

export function operationSnapshotFromFacts(
  operation: AppOperationRef,
  snapshot: ConversationSnapshot,
  ack?: CommandAck | "unknown",
  ownerTurn?: CommandQueryTurn,
): OperationSnapshot<AppSessionRef> {
  const base = { operation, epoch: snapshot.logEpoch, revision: snapshot.seq };
  const row = snapshot.rows.window.find(
    (item) => item.kind === "turnHeader" && item.sourceCommandId === operation.commandId,
  );
  // Bug 根因：快照只有 60 行尾窗，长回合的 header 滚出窗口后，已结束的回合被判成 unknown，
  // 等审批的回合因为拿不到 turnId 被判成 running。尾窗里没有该行时，用 owner 在 commands/query
  // 回包里给出的回合状态；尾窗行可能更新，优先使用。
  const header = row?.kind === "turnHeader" ? { turnId: row.turnId, state: row.state } : ownerTurn;
  if (header && header.state !== "running") {
    return {
      ...base,
      status:
        header.state === "completedSuccess"
          ? "completed"
          : header.state === "completedInterrupted"
            ? "interrupted"
            : "failed",
    };
  }
  const work = snapshot.control.activeWorks.find(
    (item) => item.sourceCommandId === operation.commandId,
  );
  if (header || work) {
    const interaction = snapshot.pendingInteractions.find(
      (item) =>
        item.anchorRowId === null ||
        snapshot.rows.window.some(
          (candidate) =>
            candidate.rowId === item.anchorRowId && candidate.turnId === header?.turnId,
        ),
    );
    return {
      ...base,
      status: interaction ? "needs_attention" : "running",
      ...(work?.foregroundExecutionId ? { executionId: work.foregroundExecutionId } : {}),
      ...(interaction
        ? {
            attention: {
              kind:
                interaction.kind === "userInput" ? ("question" as const) : ("approval" as const),
            },
          }
        : {}),
    };
  }
  if (snapshot.queue.items.some((item) => item.sourceCommandId === operation.commandId))
    return { ...base, status: "queued" };
  // ACK 与 TurnStarted 之间由 owner 的当前 pending 事实承接；单独历史 ACK 不能证明仍待执行。
  if (snapshot.pendingCommands.some((item) => item.commandId === operation.commandId))
    return { ...base, status: "accepted" };
  if (ack && ack !== "unknown") {
    if (ack.status === "failed" || ack.status === "rejected" || ack.status === "stale")
      return { ...base, status: "failed", reason: ack.reasonCode };
    if (
      ack.result?.type === "inputAccepted" ||
      (ack.result?.type === "createSession" && ack.result.input)
    ) {
      const delivery =
        ack.result.type === "inputAccepted" ? ack.result.delivery : ack.result.input!.delivery;
      // ACK 只证明曾接纳。尾窗缺少关联事实可能已分页或重启，不能伪造仍在执行。
      return { ...base, status: "unknown", reason: `No current execution facts for ${delivery}` };
    }
  }
  return { ...base, status: "unknown" };
}
