import { createSessionId, SessionEventType, type TurnCompletePayload } from "@zcode/contracts";
import { createCliSessionControl } from "@zcode/session-control/cli";
import {
  SessionControlError,
  type CliSessionRef,
  type CreateSessionResult,
} from "@zcode/session-control/contracts";
import type { ZCodeApp } from "../app/types.js";
import { resolveStableForkTargetFromTranscript } from "../zcode-protocol-v4/stable-fork-target.js";
import type { RuntimeMethodContext } from "./runtimeMethodContext.js";

export function createCliRuntimeExecution(
  context: RuntimeMethodContext,
): Parameters<typeof createCliSessionControl>[0]["execution"] {
  const {
    roots,
    workspace,
    options,
    observations,
    assertOpen,
    ref,
    owner,
    writable,
    reserveRoot,
    fence,
    validate,
    validateRead,
    listStored,
    trace,
    remember,
    commandId,
    attach,
    track,
    storedRef,
    storedSummary,
    readStored,
    readVisibleMessages,
    summary,
    releaseRootReservation,
    submit,
  } = context;
  return {
    async createSession(ctx, input, grant) {
      validate(ctx, grant);
      return remember(
        ctx,
        "createSession",
        input,
        async (): Promise<CreateSessionResult<CliSessionRef>> => {
          validate(ctx, grant);
          reserveRoot();
          const sessionId = createSessionId();
          let app: ZCodeApp | undefined;
          try {
            app = await options.createRootApp({
              sessionId,
              cwd: workspace.workspacePath,
              resume: false,
              ...(input.model ? { model: input.model } : {}),
              traceContext: trace(ctx, sessionId),
            });
            if (app.sessionId !== sessionId) {
              await app.close?.();
              throw new SessionControlError("conflict", "Factory returned a different session");
            }
            const root = attach(app, true);
            assertOpen();
            // 新根采用独立安全模式；不从 actor 继承 yolo 或审批。
            await app.setMode("build");
            await app.runtime.ensureSessionPersistedForExternalActivity(input.prompt, {
              traceContext: trace(ctx, sessionId),
            });
            validate(ctx, grant);
            const first = await submit(ctx, root, input.prompt, input.requestId, grant);
            return {
              requestId: input.requestId,
              creation: "created",
              firstInput: first.admission,
              delivery: first.delivery,
              session: first.session,
              operation: first.operation,
              ...(first.reason ? { reason: first.reason } : {}),
            };
          } catch (error) {
            const root = roots.get(sessionId);
            if (root) root.failure = error instanceof Error ? error.message : String(error);
            // 创建后持久化失败可能已写入 session；保留稳定引用与回执，禁止重试再建。
            return {
              requestId: input.requestId,
              creation: app ? "created" : "unknown",
              firstInput: "unknown",
              delivery: "unknown",
              session: ref(sessionId),
              reason: error instanceof Error ? error.message : String(error),
            };
          } finally {
            releaseRootReservation();
          }
        },
      );
    },
    async sendToSession(ctx, input, grant) {
      validate(ctx, grant);
      return remember(ctx, "sendToSession", input, async () => {
        validate(ctx, grant);
        return submit(ctx, writable(input.session), input.prompt, input.requestId, grant);
      });
    },
    async interruptSession(ctx, input, grant) {
      validate(ctx, grant);
      return remember(ctx, "interruptSession", input, async () => {
        validate(ctx, grant);
        const result = writable(input.session).app.runtime.stopActiveForegroundExecution({
          expectedForegroundExecutionId: input.expectedExecutionId,
          reason: "CLI session control interrupt",
        });
        return result.kind === "stopped"
          ? { requestId: input.requestId, status: "applied" as const }
          : {
              requestId: input.requestId,
              status: "rejected" as const,
              reason: result.kind === "mismatch" ? "Execution changed" : "No active execution",
            };
      });
    },
    async renameSession(ctx, input, grant) {
      validate(ctx, grant);
      return remember(ctx, "renameSession", input, async () => {
        validate(ctx, grant);
        const root = writable(input.session);
        await root.app.setCustomSessionTitle({
          title: input.title,
          traceContext: trace(ctx, root.app.sessionId),
        });
        return { requestId: input.requestId, status: "applied" as const };
      });
    },
    async forkSession(ctx, input, grant) {
      validate(ctx, grant);
      // 规格 0.14：每个回执都要带请求身份，收成一个构造器，避免逐处重复三行。
      const rejected = (reason: string) =>
        ({ requestId: input.requestId, status: "rejected", reason }) as const;
      return remember(ctx, "forkSession", input, async () => {
        const source = writable(input.session);
        const leaseId = commandId(ctx, input.requestId);
        const lease = source.app.runtime.acquireForegroundPromotionLease({
          leaseId,
          mode: "idle-only",
          promotedInputId: leaseId,
        });
        if (lease.kind !== "acquired")
          return rejected("Fork requires an idle owner to validate independent permissions");
        try {
          const stored = await options.sessionStore.getSession(source.app.sessionId);
          // 现有 stable fork 原子 bundle 会复制 permission；build 不会清掉 allow/deny/ask。
          // 无安全清除参数前只允许无持久权限规则、无后台写者的 idle 来源，绝不在 adapter 改库。
          if (
            !stored ||
            source.app.runtime.hasRunningBackgroundTasks() ||
            Object.keys(stored.permission ?? {}).some((key) => key !== "mode") ||
            (stored.permission?.mode && stored.permission.mode !== "build")
          )
            return rejected(
              "Stable fork cannot copy session permission rules into an independent root",
            );
          const messages = await options.sessionStore.messages({
            sessionID: source.app.sessionId,
          });
          const boundary = messages.find((message) => message.info.id === input.atMessage);
          if (
            !boundary ||
            boundary.info.role !== "assistant" ||
            boundary.info.error ||
            !boundary.info.anchor?.turnId
          )
            return rejected("Message has no verifiable stable assistant boundary");
          if (boundary.info.mode !== "build")
            return rejected(
              "Stable fork cannot copy historical permission mode into an independent root",
            );
          const turnId = boundary.info.anchor.turnId;
          const events = await source.app.runtime
            .getSessionEventStore()
            .getEvents(source.app.sessionId);
          const complete = events.find(
            (event) =>
              event.turnId === turnId &&
              event.type === SessionEventType.TurnComplete &&
              (event.payload as TurnCompletePayload).resultType === "success",
          );
          const laterAssistant = messages
            .slice(messages.indexOf(boundary) + 1)
            .some(
              (message) =>
                message.info.role === "assistant" && message.info.anchor?.turnId === turnId,
            );
          if (!complete || laterAssistant)
            return rejected("Target turn is not a completed stable assistant boundary");
          const resolution = await resolveStableForkTargetFromTranscript({
            candidate: {
              productTurnId: boundary.info.anchor.productTurnId ?? turnId,
              transcriptTurnId: turnId,
              boundaryMessageId: input.atMessage,
              startMessageId: boundary.info.parentID,
            },
            messages,
            store: options.sessionStore,
          });
          if (!resolution.ok) return rejected(resolution.reasonCode);
          validate(ctx, grant);
          reserveRoot();
          const childId = createSessionId();
          let committed = false;
          try {
            await source.app.runtime.forkStableConversationAtMessage({
              forkedSessionId: childId,
              target: resolution.target,
              goalBoundary: resolution.goalBoundary,
              sourceCommandId: commandId(ctx, input.requestId),
              traceContext: trace(ctx, source.app.sessionId),
            });
            committed = true;
            const app = await options.createRootApp({
              sessionId: childId,
              cwd: workspace.workspacePath,
              resume: true,
              traceContext: trace(ctx, childId),
            });
            if (app.sessionId !== childId) {
              await app.close?.();
              throw new SessionControlError(
                "conflict",
                "Factory returned a different fork session",
              );
            }
            const root = attach(app, true);
            assertOpen();
            await app.resume({ traceContext: trace(ctx, childId) });
            // 历史模型属于 fork 点；权限模式不沿 actor/fork 的旧 yolo 扩散。
            await app.setMode("build");
            root.prepared = true;
            return {
              requestId: input.requestId,
              status: "created" as const,
              session: ref(childId),
            };
          } catch (error) {
            const root = roots.get(childId);
            if (root) root.failure = error instanceof Error ? error.message : String(error);
            return {
              requestId: input.requestId,
              status: committed ? ("created" as const) : ("unknown" as const),
              session: ref(childId),
              reason: error instanceof Error ? error.message : String(error),
            };
          } finally {
            releaseRootReservation();
          }
        } finally {
          source.app.runtime.releaseForegroundPromotionLease(leaseId);
        }
      });
    },
  };
}
