import type { TaskNotificationPayload } from "@zcode/shared";
import type {
  ConversationSnapshot,
  PendingInteraction,
  SessionSummary,
  UserInputRequestPayload,
} from "@zcode/shared/zcode-protocol-v4";
import { sessionTerminalNotificationStatus } from "@zcode/shared/zcode-protocol-v4";
import type { IntlInstance } from "@/i18n/index.js";

type FormatMessage = IntlInstance["formatMessage"];

function taskTitleBody(
  title: string,
  fallbackMessageId: string,
  formatMessage: FormatMessage,
): string {
  const trimmedTitle = title.trim();
  if (trimmedTitle) {
    return formatMessage({ id: "notification.taskWithTitle" }, { title: trimmedTitle });
  }
  return formatMessage({ id: fallbackMessageId });
}

function terminalPayloadForSession(
  session: SessionSummary,
  status: Extract<TaskNotificationPayload["status"], "completed" | "failed">,
  formatMessage: FormatMessage,
): TaskNotificationPayload {
  if (status === "completed") {
    return {
      taskId: session.sessionId,
      status,
      title: formatMessage({ id: "notification.completed" }),
      body: taskTitleBody(session.title, "notification.completedBody", formatMessage),
    };
  }

  return {
    taskId: session.sessionId,
    status,
    title: formatMessage({ id: "notification.error" }),
    body: taskTitleBody(session.title, "notification.error", formatMessage),
  };
}

export function collectTerminalTaskNotificationPayloads(params: {
  previousBySessionId: ReadonlyMap<string, SessionSummary>;
  sessions: readonly SessionSummary[];
  formatMessage: FormatMessage;
  notificationScope?: {
    endpointKey?: string;
    workspaceKey: string;
    logEpoch: string;
  };
}): TaskNotificationPayload[] {
  const payloads: TaskNotificationPayload[] = [];
  for (const session of params.sessions) {
    const status = sessionTerminalNotificationStatus(session);
    if (!status) continue;

    const previous = params.previousBySessionId.get(session.sessionId);
    if (!previous) continue;

    const previousStatus = sessionTerminalNotificationStatus(previous);
    // conflated snapshot/recovery 可能省略两轮之间的 running；CLI 已观察到新资格边沿时，
    // 不同事实身份仍代表新通知。旧 CLI 没有身份则保持原资格比较，避免重放冷历史。
    if (
      previousStatus === status &&
      (!previous.notificationEventId ||
        !session.notificationEventId ||
        previous.notificationEventId === session.notificationEventId)
    ) {
      continue;
    }

    const payload = terminalPayloadForSession(session, status, params.formatMessage);
    if (params.notificationScope && session.notificationEventId) {
      // 相同真实事件跨窗口保持同一身份；不同 Host/workspace/epoch 的同 taskId 必须隔离。
      payload.notificationId = JSON.stringify([
        params.notificationScope.endpointKey ?? null,
        params.notificationScope.workspaceKey,
        params.notificationScope.logEpoch,
        session.sessionId,
        session.notificationEventId,
      ]);
    }
    payloads.push(payload);
  }
  return payloads;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlanApprovalInteraction(payload: UserInputRequestPayload): boolean {
  if (payload.toolName === "ExitPlanMode") {
    return true;
  }
  if (!isPlainRecord(payload.schema)) {
    return false;
  }
  return (
    payload.schema.interaction === "plan_approval" || payload.schema.toolName === "ExitPlanMode"
  );
}

function pendingInteractionPayload(params: {
  snapshot: ConversationSnapshot;
  interaction: PendingInteraction;
  formatMessage: FormatMessage;
}): TaskNotificationPayload | null {
  const { snapshot, interaction, formatMessage } = params;
  const requestId = interaction.interactionId;
  const taskId = snapshot.sessionId;
  const taskTitle = snapshot.meta.title;

  // workspace Hook review 的唯一入口是 Settings；不得把它伪装成
  // permission/elicitation 系统通知。
  if (interaction.payload.kind === "workspaceHookReview") {
    return null;
  }

  if (interaction.payload.kind === "permission") {
    return {
      taskId,
      status: "permission_request",
      requestId,
      title: formatMessage({ id: "notification.permissionRequired" }),
      body:
        interaction.payload.summary.trim() ||
        taskTitleBody(taskTitle, "notification.permissionRequired", formatMessage),
    };
  }

  if (isPlanApprovalInteraction(interaction.payload)) {
    return {
      taskId,
      status: "elicitation_request",
      requestId,
      title: formatMessage({ id: "notification.planApprovalRequired" }),
      body: formatMessage({ id: "notification.planApprovalBody" }),
    };
  }

  return {
    taskId,
    status: "elicitation_request",
    requestId,
    title: formatMessage({ id: "notification.inputRequired" }),
    body:
      interaction.payload.prompt.trim() ||
      taskTitleBody(taskTitle, "notification.inputRequired", formatMessage),
  };
}

export function collectPendingInteractionNotificationPayloads(params: {
  snapshot: ConversationSnapshot;
  seenRequestIds: ReadonlySet<string>;
  formatMessage: FormatMessage;
}): TaskNotificationPayload[] {
  return params.snapshot.pendingInteractions
    .filter((interaction) => !params.seenRequestIds.has(interaction.interactionId))
    .flatMap((interaction) => {
      const payload = pendingInteractionPayload({
        snapshot: params.snapshot,
        interaction,
        formatMessage: params.formatMessage,
      });
      return payload ? [payload] : [];
    });
}
