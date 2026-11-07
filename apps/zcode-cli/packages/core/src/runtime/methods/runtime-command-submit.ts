import type { RuntimeCommand, RuntimeCommandId } from "../command-queue.js";
import { createTurnCancelledError } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";

type ResolvableRuntimeCommand<Result> = RuntimeCommand & {
  readonly id: RuntimeCommandId;
  readonly reject: (error: unknown) => void;
  readonly resolve: (result: Result) => void;
};

export function enqueueCancellableRuntimeCommand<
  Result,
  Command extends ResolvableRuntimeCommand<Result>,
>(
  runtime: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    createCommand: (handlers: {
      reject: (error: unknown) => void;
      resolve: (result: Result) => void;
    }) => Command;
    onCommandCancelled?: (error: unknown) => void | Promise<void>;
    /** 已通过取消检查，尚未进入 drain 的同步接纳点。 */
    onCommandAccepted?: () => void;
  },
): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    let settled = false;
    let cancelling = false;
    const abortSignal = input.abortSignal;
    const cleanup = () => {
      abortSignal?.removeEventListener("abort", abortQueuedCommand);
    };
    const resolveCommand = (result: Result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const rejectCommand = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const command = input.createCommand({
      reject: rejectCommand,
      resolve: resolveCommand,
    });
    const cancelCommand = (error: unknown) => {
      // Bugfix：异步终态持久化必须先于 completion 拒绝；重复 abort 不重复结算。
      if (settled || cancelling) return;
      cancelling = true;
      cleanup();
      void Promise.resolve()
        .then(() => input.onCommandCancelled?.(error))
        .then(() => rejectCommand(error), rejectCommand);
    };
    function abortQueuedCommand() {
      if (settled || cancelling) return;
      const removed = runtime.runtimeCommandQueue.removeById(command.id);
      if (removed) {
        cancelCommand(createTurnCancelledError(abortSignal?.reason));
        return;
      }
      // 取消可能撞上 command 刚出队但尚未进入实际执行的窄窗口，先记账让执行侧跳过。
      runtime.runtimeCommandQueue.markCancelPending(command.id);
    }
    if (abortSignal?.aborted) {
      cancelCommand(createTurnCancelledError(abortSignal.reason));
      return;
    }
    abortSignal?.addEventListener("abort", abortQueuedCommand, { once: true });
    try {
      input.onCommandAccepted?.();
    } catch (error) {
      cancelCommand(error);
      return;
    }
    runtime.enqueueRuntimeCommand(command);
  });
}
