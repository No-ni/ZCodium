import { describe, expect, it, vi } from "vitest";
import { createRootTraceContext, createSessionId, type MessageId } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { ActiveTurnSteeringState } from "../src/runtime/types.js";
import {
  createRuntimeCommandId,
  type TaskNotificationRuntimeCommand,
} from "../src/runtime/command-queue.js";
import {
  enqueueBackgroundTaskNotification,
  persistBackgroundTaskNotificationBatch,
  shouldSuppressTaskNotificationRuntimeCommand,
} from "../src/runtime/methods/background-notifications.js";
import { closeGoalStateChangeReminderDeferral } from "../src/runtime/methods/goal-state-reminder.js";
import { maybeStartGoalSummaryTitleGeneration } from "../src/runtime/methods/goal-summary-title.js";
import { maybeStartSessionTitleGeneration } from "../src/runtime/methods/session-title.js";

const marker = "fixture-private-error-content";
const sessionId = createSessionId("fixture-sidecar-privacy");
const traceContext = createRootTraceContext({ sessionId });
const objective = "合成目标标题回退与后台通知故障测试";
const target = { targetID: "fixture-target", objective, summaryTitle: "" };
const failures = [
  { name: "Error", make: () => new Error(marker) },
  { name: "string", make: () => marker },
  {
    name: "throwing toString",
    make: () => ({
      toString: vi.fn(() => {
        throw new Error(marker);
      }),
    }),
  },
];

function fixture() {
  const pending: Promise<unknown>[] = [];
  // 观察实际挂在 residency work 上的 catch；测试也消费其拒绝，防止失败实现的
  // toString 二次异常逃到 Vitest 全局。生产的 Promise/catch 顺序保持。
  const track = (work: Promise<unknown>) => ({
    catch(handler: (error: unknown) => unknown) {
      const handled = work.catch(handler);
      pending.push(handled);
      void handled.catch(() => undefined);
      return handled;
    },
  });
  const warn = vi.fn();
  const store = {
    saveSessionInput: vi.fn().mockResolvedValue(undefined),
    markSessionInputPromoted: vi.fn().mockResolvedValue(undefined),
    settleSessionInput: vi.fn().mockResolvedValue(undefined),
    getSession: vi.fn().mockResolvedValue({ taskType: "interactive", titleSource: "first_input" }),
    readTarget: vi.fn().mockResolvedValue(target),
    updateTargetSummaryTitle: vi.fn().mockImplementation(async (input) => ({
      ...target,
      summaryTitle: input.summaryTitle,
    })),
  };
  const notice = vi.fn().mockResolvedValue(undefined);
  const enqueue = vi.fn();
  const addAttachment = vi.fn();
  const runtime = {
    sessionId,
    rootTraceContext: traceContext,
    branchGeneration: 0,
    turnNumber: 0,
    config: { taskType: "interactive", titleGeneration: { enabled: false } },
    logger: { warn, info: vi.fn(), debug: vi.fn() },
    runtimeTaskRegistry: { get: () => undefined },
    sessionStore: store,
    trackResidencyBlockingWork: track,
    ensureContextInitialized: vi.fn().mockResolvedValue(undefined),
    persistSyntheticUserNoticeForSession: notice,
    enqueueRuntimeCommand: enqueue,
    recordTargetChanged: vi.fn().mockResolvedValue(undefined),
    messageHistory: { addUser: vi.fn(), addAttachment },
  } as unknown as AgentRuntimeInternal;
  return {
    runtime,
    store,
    warn,
    notice,
    enqueue,
    addAttachment,
    async drain() {
      const settled = await Promise.allSettled(pending);
      expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
    },
  };
}

function command(): TaskNotificationRuntimeCommand {
  return {
    branchGeneration: 0,
    createdAt: new Date(),
    id: createRuntimeCommandId(),
    mode: "task-notification",
    priority: "next",
    source: "background_task",
    text: "fixture notification body",
    toolName: "Bash",
    traceContext,
  };
}

const events = {
  admission: ["session_input.admit_failed"],
  promotion: ["session_input.promote_mark_failed"],
  discarded: ["session_input.settle_failed"],
  reminder: ["target.reminder.materialize.failed"],
  goal_generation: ["goal_summary_title_generation.failed"],
  goal_fallback: ["goal_summary_title_generation.fallback_failed"],
  session_generation: ["session_title_generation.failed"],
  session_fallback: ["session_title_generation.failed", "session_title_generation.fallback_failed"],
} as const;

describe("Runtime 非主请求的失败日志不泄漏或中断原收尾", () => {
  for (const kind of Object.keys(events) as (keyof typeof events)[]) {
    it.each(failures)(`${kind}: $name`, async ({ make }) => {
      const error = make();
      const f = fixture();
      switch (kind) {
        case "admission": {
          f.store.saveSessionInput.mockRejectedValue(error);
          enqueueBackgroundTaskNotification.call(f.runtime, {
            text: "fixture notification body",
            traceContext,
          });
          await f.drain();
          expect(f.enqueue).toHaveBeenCalledTimes(1);
          break;
        }
        case "promotion": {
          f.store.markSessionInputPromoted.mockRejectedValue(error);
          await expect(
            persistBackgroundTaskNotificationBatch.call(f.runtime, [command()]),
          ).resolves.toMatchObject({ text: "fixture notification body" });
          expect(f.notice).toHaveBeenCalledTimes(1);
          break;
        }
        case "discarded": {
          f.runtime.config.taskType = "subagent_child";
          f.runtime.backgroundTaskNotificationsSealed = true;
          f.store.settleSessionInput.mockRejectedValue(error);
          expect(shouldSuppressTaskNotificationRuntimeCommand.call(f.runtime, command())).toBe(
            true,
          );
          await f.drain();
          expect(f.store.settleSessionInput).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              status: "discarded",
              reason: "subagent_notifications_sealed",
            }),
          );
          break;
        }
        case "reminder": {
          const turn = {
            kind: "regular",
            goalStateChangeReminderDeferralOpen: true,
            pendingGoalStateChangeReminder: { text: "fixture goal paused" },
          } as ActiveTurnSteeringState;
          f.notice.mockRejectedValue(error);
          await expect(
            closeGoalStateChangeReminderDeferral.call(f.runtime, turn, traceContext),
          ).resolves.toBeUndefined();
          expect(turn.goalStateChangeReminderDeferralOpen).toBe(false);
          expect(turn.pendingGoalStateChangeReminder).toBeUndefined();
          await closeGoalStateChangeReminderDeferral.call(f.runtime, turn, traceContext);
          expect(f.notice).toHaveBeenCalledTimes(1);
          expect(f.addAttachment).toHaveBeenCalledTimes(1);
          break;
        }
        case "goal_generation": {
          f.runtime.config.titleGeneration = {};
          f.store.readTarget.mockRejectedValueOnce(error);
          expect(
            maybeStartGoalSummaryTitleGeneration.call(f.runtime, objective, target.targetID),
          ).toBe(true);
          await f.drain();
          expect(f.store.updateTargetSummaryTitle).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              summaryTitle: objective,
              targetID: target.targetID,
            }),
          );
          break;
        }
        case "goal_fallback": {
          f.store.readTarget.mockRejectedValue(error);
          expect(
            maybeStartGoalSummaryTitleGeneration.call(f.runtime, objective, target.targetID),
          ).toBe(false);
          await f.drain();
          expect(f.store.updateTargetSummaryTitle).not.toHaveBeenCalled();
          break;
        }
        case "session_generation":
        case "session_fallback": {
          f.runtime.config.titleGeneration = {};
          f.store.getSession.mockRejectedValue(
            kind === "session_generation" ? error : new Error("fixture primary failure"),
          );
          if (kind === "session_fallback") f.store.readTarget.mockRejectedValue(error);
          expect(
            maybeStartSessionTitleGeneration.call(
              f.runtime,
              objective,
              "fixture-message" as MessageId,
              traceContext,
              { goalSummaryTargetID: target.targetID },
            ),
          ).toBe(true);
          await f.drain();
          if (kind === "session_generation") {
            expect(f.store.updateTargetSummaryTitle).toHaveBeenCalledExactlyOnceWith(
              expect.objectContaining({
                summaryTitle: objective,
                targetID: target.targetID,
              }),
            );
          } else expect(f.store.updateTargetSummaryTitle).not.toHaveBeenCalled();
          break;
        }
      }
      expect(f.warn.mock.calls.map((call) => call[1]?.event)).toEqual(events[kind]);
      expect(JSON.stringify(f.warn.mock.calls)).not.toContain(marker);
      for (const call of f.warn.mock.calls) {
        expect(call[1]).toMatchObject({ module: "core.runtime", status: "failed" });
        expect(call[1]).not.toHaveProperty("errorMessage");
      }
      if (typeof error === "object" && !(error instanceof Error)) {
        expect(error.toString).not.toHaveBeenCalled();
      }
    });
  }
});
