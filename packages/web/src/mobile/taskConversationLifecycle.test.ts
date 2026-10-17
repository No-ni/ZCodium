import { describe, expect, it, vi } from "vitest";
import type { ZCodeMessageWithParts, ZCodeStreamEvent } from "@zcode/shared";
import { conversationReducer, initialConversationState } from "./conversationReducer.js";
import type { TaskStreamSubscription } from "./protocol.js";
import { TaskConversationLifecycle } from "./taskConversationLifecycle.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const scope = { workspaceKey: "workspace-a", taskId: "task-a" };
const chunk: ZCodeStreamEvent = {
  type: "agent_message_chunk",
  taskId: scope.taskId,
  traceId: "trace",
  messageId: "m",
  content: "delta",
};
const complete: ZCodeStreamEvent = {
  type: "task_complete",
  taskId: scope.taskId,
  traceId: "trace",
  stopReason: "complete",
};
const snapshotUpdated: ZCodeStreamEvent = {
  type: "task_snapshot_updated",
  taskId: scope.taskId,
  traceId: "trace",
  workspaceKey: scope.workspaceKey,
  workspacePath: "/workspace/a",
};

function snapshot(text: string): ZCodeMessageWithParts[] {
  return [
    {
      info: {
        messageId: "m",
        sessionId: scope.taskId,
        role: "user",
        time: { created: 1 },
        agent: "test",
      },
      parts: [{ type: "text", text, messageId: "m", sessionId: scope.taskId, partId: "part" }],
    },
  ];
}

async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function harness(read = vi.fn<() => Promise<ZCodeMessageWithParts[]>>()) {
  let state = initialConversationState;
  const callbacks: ((event: ZCodeStreamEvent) => void)[] = [];
  const disposals: ReturnType<typeof vi.fn>[] = [];
  const onError = vi.fn();
  const subscribe = vi.fn(async (callback: (event: ZCodeStreamEvent) => void) => {
    callbacks.push(callback);
    const dispose = vi.fn();
    disposals.push(dispose);
    return { dispose };
  });
  const lifecycle = new TaskConversationLifecycle(scope, {
    prepare: vi.fn().mockResolvedValue(undefined),
    read,
    subscribe,
    onError,
    dispatch: (action) => {
      state = conversationReducer(state, action);
    },
  });
  return { lifecycle, read, subscribe, callbacks, disposals, onError, state: () => state };
}

describe("TaskConversationLifecycle", () => {
  it.each([complete, snapshotUpdated])(
    "R → delta → $type → R resolve 串行补读，不拼缓冲 delta",
    async (terminal) => {
      const r = deferred<ZCodeMessageWithParts[]>();
      const r2 = deferred<ZCodeMessageWithParts[]>();
      const h = harness(vi.fn().mockReturnValueOnce(r.promise).mockReturnValueOnce(r2.promise));
      h.lifecycle.start();
      await flush();
      expect(h.read).toHaveBeenCalledTimes(1);
      h.callbacks[0]!(chunk);
      h.callbacks[0]!(terminal);
      expect(h.read).toHaveBeenCalledTimes(1);
      r.resolve(snapshot("过期"));
      await flush();
      expect(h.read).toHaveBeenCalledTimes(2);
      expect(h.state().messages).toEqual([]);
      expect(h.state().awaitingSnapshot).toBe(true);
      expect(h.state().needsResync).toBe(true);
      r2.resolve(snapshot("权威delta"));
      await flush();
      expect(h.state().messages[0]?.text).toBe("权威delta");
      expect(h.state().awaitingSnapshot).toBe(false);
      expect(h.state().needsResync).toBe(false);
      h.lifecycle.dispose();
    },
  );

  it("只有 delta 也使在途 R 过期，稳定后无周期补读", async () => {
    const r = deferred<ZCodeMessageWithParts[]>();
    const h = harness(
      vi.fn().mockReturnValueOnce(r.promise).mockResolvedValue(snapshot("权威delta")),
    );
    h.lifecycle.start();
    await flush();
    h.callbacks[0]!(chunk);
    r.resolve(snapshot("旧"));
    await flush();
    expect(h.read).toHaveBeenCalledTimes(2);
    h.callbacks[0]!(chunk);
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.state().messages).toHaveLength(2);
    h.lifecycle.dispose();
  });

  it("同 scope 恢复释放旧订阅，旧 R/旧事件不能解除新屏障", async () => {
    const old = deferred<ZCodeMessageWithParts[]>();
    const fresh = deferred<ZCodeMessageWithParts[]>();
    const h = harness(vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise));
    h.lifecycle.start();
    await flush();
    h.lifecycle.recoverBridge();
    await flush();
    expect(h.disposals[0]).toHaveBeenCalledTimes(1);
    expect(h.subscribe).toHaveBeenCalledTimes(2);
    expect(h.read).toHaveBeenCalledTimes(2);
    h.callbacks[0]!(complete);
    old.resolve(snapshot("旧读取"));
    await flush();
    expect(h.state().awaitingSnapshot).toBe(true);
    fresh.resolve(snapshot("新读取"));
    await flush();
    expect(h.state().messages[0]?.text).toBe("新读取");
    expect(h.read).toHaveBeenCalledTimes(2);
    h.lifecycle.dispose();
  });

  it("读取失败保留屏障，后续信号重试并报告错误", async () => {
    const error = new Error("snapshot failed");
    const h = harness(vi.fn().mockRejectedValueOnce(error).mockResolvedValue(snapshot("重试")));
    h.lifecycle.start();
    await flush();
    expect(h.onError).toHaveBeenCalledWith(error);
    expect(h.state().awaitingSnapshot).toBe(true);
    h.callbacks[0]!(complete);
    await flush();
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.state().messages[0]?.text).toBe("重试");
    h.lifecycle.dispose();
  });

  it("迟到订阅句柄被释放，dispose 后事件/读取不写投影", async () => {
    const subscription = deferred<TaskStreamSubscription>();
    const dispose = vi.fn();
    const dispatch = vi.fn();
    const read = vi.fn();
    const lifecycle = new TaskConversationLifecycle(scope, {
      prepare: vi.fn().mockResolvedValue(undefined),
      subscribe: () => subscription.promise,
      read,
      dispatch,
      onError: vi.fn(),
    });
    lifecycle.start();
    await flush();
    lifecycle.dispose();
    subscription.resolve({ dispose });
    await flush();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("冷任务先恢复再订阅和读取，切代后迟到恢复不建旧订阅", async () => {
    const prepared = deferred<void>();
    const prepare = vi.fn().mockReturnValueOnce(prepared.promise).mockResolvedValue(undefined);
    const subscribe = vi.fn().mockResolvedValue({ dispose: vi.fn() });
    const read = vi.fn().mockResolvedValue([]);
    const lifecycle = new TaskConversationLifecycle(scope, {
      prepare,
      subscribe,
      read,
      dispatch: vi.fn(),
      onError: vi.fn(),
    });
    lifecycle.start();
    await flush();
    expect(subscribe).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    lifecycle.recoverBridge();
    await flush();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    prepared.resolve();
    await flush();
    expect(subscribe).toHaveBeenCalledTimes(1);
    lifecycle.dispose();
  });
});
