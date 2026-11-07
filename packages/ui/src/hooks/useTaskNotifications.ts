import { useEffect, useRef } from "react";
import type { IPlatformService, TaskNotificationPayload } from "@zcode/shared";
import type { ConversationSnapshot, SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import { useServices } from "@/hooks/useServices.js";
import type { IntlInstance } from "@/i18n/index.js";
import { logger } from "@/logger.js";
import {
  collectPendingInteractionNotificationPayloads,
  collectTerminalTaskNotificationPayloads,
} from "@/lib/taskNotificationOrchestrator.js";
import {
  acquireSessionsIndex,
  releaseSessionsIndex,
  type SessionsIndexScope,
} from "@/v4/sessionsIndexRegistry.js";

type FormatMessage = IntlInstance["formatMessage"];
type TaskNotificationPlatform = Pick<IPlatformService, "showTaskNotification">;

interface WorkspaceTerminalTaskNotificationsParams {
  workspacePath: string;
  workspaceIdentity?: string;
  endpointKey?: string | null;
  enabled: boolean;
  rpcReady: boolean;
  platform: TaskNotificationPlatform | null | undefined;
  formatMessage: FormatMessage;
}

interface PendingInteractionTaskNotificationsParams {
  snapshot: ConversationSnapshot | null;
  enabled: boolean;
  platform: TaskNotificationPlatform | null | undefined;
  formatMessage: FormatMessage;
}

function trimOptional(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function toSessionMap(sessions: readonly SessionSummary[]): Map<string, SessionSummary> {
  return new Map(sessions.map((session) => [session.sessionId, session]));
}

function showTaskNotification(
  platform: TaskNotificationPlatform,
  payload: TaskNotificationPayload,
): void {
  try {
    platform.showTaskNotification(payload);
  } catch (error) {
    logger.warn("[task-notification] 触发平台通知失败", {
      taskId: payload.taskId,
      status: payload.status,
      error,
    });
  }
}

/**
 * v4 任务终态通知编排。
 *
 * v4 重构删掉旧 renderer background monitor 后，platform 通知通道仍在，
 * 但 sessions-index 事实没有再被翻译成展示命令，导致任务完成/失败没有系统通知。
 * 这里只在 renderer 做“已观察边沿”的通知意图，事实仍以 sessions-index 为准；
 * 是否因窗口活跃而抑制通知继续交给 desktop/web platform 层判断。
 */
export function useWorkspaceTerminalTaskNotifications({
  workspacePath,
  workspaceIdentity: rawWorkspaceIdentity,
  endpointKey: rawEndpointKey,
  enabled,
  rpcReady,
  platform,
  formatMessage,
}: WorkspaceTerminalTaskNotificationsParams): void {
  const { zcodeAgentService } = useServices();
  const workspaceIdentity = trimOptional(rawWorkspaceIdentity);
  const endpointKey = trimOptional(rawEndpointKey);
  const workspaceKey = workspaceIdentity ?? workspacePath;
  const formatMessageRef = useRef(formatMessage);

  useEffect(() => {
    // 通知基线属于 workspace/runtime；切换语言若重建订阅，会丢失重连前已观察的 running。
    // 只更新文案函数，让同一订阅保留边沿并使用当前语言。
    formatMessageRef.current = formatMessage;
  }, [formatMessage]);

  useEffect(() => {
    if (!enabled || !rpcReady || !platform) {
      // App 壳在 remote attachment 就绪前会先挂载，旧通知 hook
      // 只看用户开关就订阅 sessions-index，从而越过 conversation 的 readiness gate
      // 访问断连代理。这里共用 workspace rpcReady；本地 workspace 始终为 true。
      return;
    }

    const registryScope: SessionsIndexScope = {
      workspaceKey,
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(endpointKey ? { endpointKey } : {}),
    };
    const store = acquireSessionsIndex(registryScope, zcodeAgentService);
    let previousBySessionId: Map<string, SessionSummary> | null = null;
    let previousLogEpoch: string | null = null;
    const syncState = () => {
      // 通知是投影发布的副作用。复制进 React state 再等 effect 会消费迟到的终态，
      // 此时当前 store 可能已进入下一轮；直接读取同一订阅当前态，且不为通知重渲染 App。
      const index = store.getState();
      if (store.getStatus() !== "live" || index.logEpoch === null) {
        if (index.logEpoch === null) previousBySessionId = null;
        return;
      }
      const sessions = store.getSessions();
      const nextBySessionId = toSessionMap(sessions);
      if (!previousBySessionId || previousLogEpoch !== index.logEpoch) {
        // runtime 换代的 stored snapshot 是冷基线；不能拿旧进程 running 推导历史完成。
        previousBySessionId = nextBySessionId;
        previousLogEpoch = index.logEpoch;
        return;
      }
      const payloads = collectTerminalTaskNotificationPayloads({
        previousBySessionId,
        sessions,
        formatMessage: formatMessageRef.current,
        notificationScope: { endpointKey, workspaceKey, logEpoch: index.logEpoch },
      });
      // 先推进边沿基线，平台调用即使引发同步回调也不能重复同一通知。
      previousBySessionId = nextBySessionId;
      for (const payload of payloads) {
        showTaskNotification(platform, payload);
      }
    };
    const unsubscribe = store.subscribe(syncState);
    syncState();

    return () => {
      unsubscribe();
      releaseSessionsIndex(registryScope, store);
    };
  }, [
    enabled,
    endpointKey,
    platform,
    rpcReady,
    workspaceIdentity,
    workspaceKey,
    workspacePath,
    zcodeAgentService,
  ]);
}

/**
 * 当前 conversation snapshot 的阻塞交互通知。
 *
 * 首个 snapshot 只作为基线，避免订阅历史/恢复 replayable snapshot 时重放旧权限弹窗通知；
 * 后续新增 interactionId 才发通知，重复 pending 不会刷屏。
 */
export function usePendingInteractionTaskNotifications({
  snapshot,
  enabled,
  platform,
  formatMessage,
}: PendingInteractionTaskNotificationsParams): void {
  const seenRef = useRef<{ sessionId: string; seenRequestIds: Set<string> } | null>(null);

  useEffect(() => {
    if (!enabled || !snapshot) {
      seenRef.current = null;
      return;
    }

    const currentRequestIds = snapshot.pendingInteractions.map(
      (interaction) => interaction.interactionId,
    );
    const currentSeen = seenRef.current;
    if (!currentSeen || currentSeen.sessionId !== snapshot.sessionId) {
      seenRef.current = {
        sessionId: snapshot.sessionId,
        seenRequestIds: new Set(currentRequestIds),
      };
      return;
    }

    if (platform) {
      const payloads = collectPendingInteractionNotificationPayloads({
        snapshot,
        seenRequestIds: currentSeen.seenRequestIds,
        formatMessage,
      });
      for (const payload of payloads) {
        showTaskNotification(platform, payload);
      }
    }

    for (const requestId of currentRequestIds) {
      currentSeen.seenRequestIds.add(requestId);
    }
  }, [enabled, formatMessage, platform, snapshot]);
}
