import {
  SessionControlError,
  type AccessGrant,
  type CliScope,
  type CliSessionRef,
  type CliTrustedContext,
  type SendToSessionResult,
} from "@zcode/session-control/contracts";
import type { ZCodeApp } from "../app/types.js";
import { type Root } from "./runtimeFacts.js";
import type { RuntimeMethodContext } from "./runtimeMethodContext.js";

export async function submitToCliRoot(
  context: RuntimeMethodContext,
  ctx: CliTrustedContext,
  root: Root,
  prompt: string,
  requestId: string,
  grant: AccessGrant<CliScope>,
): Promise<SendToSessionResult<CliSessionRef>> {
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
  } = context;

  const session = ref(root.app.sessionId);
  // 回执带裸 sessionId，模型才能把整个 operation 原样放回 WaitSessions（规格 0.14）。
  const operation = {
    session,
    sessionId: session.sessionId,
    commandId: commandId(ctx, requestId),
  };
  const observed = observations.register(operation);
  const executionOptions = {
    inputId: operation.commandId,
    abortSignal: root.signal.signal,
    traceContext: trace(ctx, root.app.sessionId),
  };
  const watch = (completion: ReturnType<ZCodeApp["submitPrompt"]>): void => {
    track(
      root,
      completion.then(
        (result) => {
          for (const event of result.events) observations.onEvent(event);
          if (!["completed", "interrupted", "failed"].includes(observed.snapshot.status))
            observations.update(observed, "unknown", {
              reason: "Runtime completed without a correlated terminal event",
            });
        },
        (error: unknown) =>
          observations.update(observed, root.signal.signal.aborted ? "interrupted" : "failed", {
            reason: error instanceof Error ? error.message : String(error),
          }),
      ),
    );
  };
  try {
    if (!root.owned && root.app.runtime.getActiveForegroundExecutionId()) root.prepared = true;
    if (root.preparation) await root.preparation;
    validate(ctx, grant);
    if (root.failure) throw new SessionControlError("unavailable", root.failure);
    if (root.prepared) {
      // 根因：sendInput(queueDelivery=queue) 只建 V4 deferred 项，独立 CLI 没有 V4 消费者。
      // 已初始化的独立根直接进入 Core 原有 command FIFO；同步调用之间无 await，无第二队列。
      const queued = root.app.runtime.hasActiveOrQueuedTurnWork();
      const completion = root.app.runtime.executeTurn(prompt, undefined, executionOptions);
      if (queued) observations.update(observed, "queued");
      watch(completion);
      return {
        session,
        operation,
        requestId,
        admission: "accepted",
        delivery: queued ? "queued" : "start_now",
      };
    }
    const prepare = (async () => {
      const admission = await root.app.sendInput(prompt, {
        ...executionOptions,
        requireIdle: true,
      });
      if (admission.kind !== "started_turn") return admission;
      root.prepared = true;
      observed.turnId = admission.turnId;
      watch(admission.completion);
      return admission;
    })();
    root.preparation = prepare.then(
      () => undefined,
      () => undefined,
    );
    const admission = await prepare;
    if (admission.kind !== "started_turn") {
      observations.update(observed, "failed", { reason: "Initial execution was not admitted" });
      return {
        session,
        operation,
        requestId,
        admission: "rejected",
        delivery: "none",
        reason: "Initial execution was not admitted",
      };
    }
    return { requestId, session, operation, admission: "accepted", delivery: "start_now" };
  } catch (error) {
    // Bug 根因：这里原先把任意 admission 异常写进 root.failure，而 writable() 把该字段当成
    // 永久不可写。于是 provider 抖动、网络错误等可恢复失败会让刚建好的会话再也发不出消息。
    // admission 的不确定属于**这一个请求**：只把该 operation 记为 unknown 并保留原回执，
    // root 的可写性仍由关闭、runtime 损坏与 owner 代际失效决定（见 createSession / fork 的
    // catch 与 close 路径）。调用方换新 requestId 即可重试。
    observations.update(observed, "unknown", {
      reason: error instanceof Error ? error.message : String(error),
    });
    observed.settle();
    return {
      session,
      operation,
      requestId,
      admission: "unknown",
      delivery: "unknown",
      reason: "Input admission failed without a conclusive receipt",
    };
  }
}
