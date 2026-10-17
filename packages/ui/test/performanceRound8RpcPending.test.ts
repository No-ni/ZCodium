import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BufferReader,
  BufferWriter,
  CancellationTokenSource,
  ChannelClient,
  ChannelServer,
  deserialize,
  Emitter,
  type CancellationToken,
  serialize,
  type IServerChannel,
  VSBuffer,
} from "@zcode/rpc";

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// 使用既有 wire 数值和公开序列化入口，直接驱动 server，不依赖其私有派发方法。
function setup() {
  const incoming = new Emitter<VSBuffer>();
  const responses: Array<{ header: number[]; body: unknown }> = [];
  const server = new ChannelServer(
    {
      onMessage: incoming.event,
      send(buffer) {
        const reader = new BufferReader(buffer);
        responses.push({ header: deserialize(reader), body: deserialize(reader) });
      },
    },
    "fixture",
    100,
  );
  cleanups.push(
    () => server.dispose(),
    () => incoming.dispose(),
  );
  const request = (type: number, id: number, channel = "late", name = `request-${id}`) => {
    const writer = new BufferWriter();
    serialize(writer, [type, id, channel, name]);
    serialize(writer, { fixture: "payload" });
    incoming.fire(writer.buffer);
  };
  // 生命周期只有一张请求表；按当前阶段投影计数，不保留旧双表兼容字段。
  const records = () =>
    (
      server as unknown as {
        requests: Map<number, { phase: string; request: { channelName: string } }>;
      }
    ).requests.values();
  const pendingChannelCount = () =>
    new Set(
      [...records()]
        .filter((record) => record.phase === "waiting")
        .map((record) => record.request.channelName),
    ).size;
  const activeRequestCount = () =>
    [...records()].filter((record) => record.phase === "active").length;
  responses.length = 0;
  return { server, request, responses, pendingChannelCount, activeRequestCount };
}

function channel(onCall?: (name: string) => void) {
  const calls: string[] = [];
  const events = new Emitter<unknown>();
  cleanups.push(() => events.dispose());
  const value: IServerChannel = {
    async call<T>(_context: string, command: string) {
      calls.push(command);
      onCall?.(command);
      return command as T;
    },
    listen<T>(_context: string, event: string) {
      calls.push(event);
      return events.event as (listener: (value: T) => void) => { dispose(): void };
    },
  };
  return { value, calls, events };
}

describe("RPC pending request lifetime", () => {
  it("releases a timed out call and event and never dispatches them to a late channel", async () => {
    const test = setup();
    test.request(100, 1);
    test.request(102, 2);
    await vi.advanceTimersByTimeAsync(100);
    expect(test.responses).toEqual([
      {
        header: [202, 1],
        body: {
          name: "Unknown channel",
          message: "Channel name 'late' timed out after 100ms",
        },
      },
    ]);
    const late = channel();
    test.server.registerChannel("late", late.value);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.calls).toEqual([]);
    expect(test.pendingChannelCount()).toBe(0);
    expect(console.error).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels queued calls and subscriptions without affecting live requests", async () => {
    const test = setup();
    test.request(100, 1);
    test.request(102, 2);
    test.request(100, 3);
    test.request(101, 1);
    test.request(101, 1);
    test.request(103, 2);
    expect(vi.getTimerCount()).toBe(1);
    const late = channel();
    test.server.registerChannel("late", late.value);
    await vi.advanceTimersByTimeAsync(100);
    expect(late.calls).toEqual(["request-3"]);
    expect(test.responses).toEqual([{ header: [201, 3], body: "request-3" }]);
    expect(test.pendingChannelCount()).toBe(0);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("dispose releases pending payloads and timers and blocks an already scheduled flush", async () => {
    const test = setup();
    test.request(100, 1);
    test.request(102, 2, "other");
    const late = channel();
    test.server.registerChannel("late", late.value);
    test.server.dispose();
    test.server.dispose();
    await vi.advanceTimersByTimeAsync(100);
    expect(late.calls).toEqual([]);
    expect(test.responses).toEqual([]);
    expect(console.error).not.toHaveBeenCalled();
    expect(test.pendingChannelCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps timely dispatch order, active event disposal and active call cancellation", async () => {
    const test = setup();
    const late = channel();
    test.request(100, 1);
    test.request(102, 2);
    test.request(100, 3);
    test.server.registerChannel("late", late.value);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.calls).toEqual(["request-1", "request-2", "request-3"]);
    expect(test.responses).toEqual([
      { header: [201, 1], body: "request-1" },
      { header: [201, 3], body: "request-3" },
    ]);
    late.events.fire("first");
    test.request(103, 2);
    late.events.fire("discarded");
    expect(test.responses.at(-1)).toEqual({ header: [204, 2], body: "first" });
    expect(test.responses).toHaveLength(3);

    let cancelled = false;
    test.server.registerChannel("active", {
      ...late.value,
      call: <T>(_ctx: string, _name: string, _arg: unknown, token?: CancellationToken) => {
        token?.onCancellationRequested(() => {
          cancelled = true;
        });
        return new Promise<T>(() => {});
      },
    });
    test.request(100, 4, "active");
    test.request(101, 4);
    expect(cancelled).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(console.error).not.toHaveBeenCalled();
    expect(test.pendingChannelCount()).toBe(0);
  });

  it.each(["cancel", "dispose"])("honors synchronous %s during a pending flush", async (action) => {
    const test = setup();
    test.request(100, 1);
    test.request(100, 2);
    test.request(102, 3);
    const late = channel(() => {
      if (action === "dispose") test.server.dispose();
      else {
        test.request(101, 2);
        test.request(103, 3);
      }
    });
    test.server.registerChannel("late", late.value);
    await vi.advanceTimersByTimeAsync(100);
    expect(late.calls).toEqual(["request-1"]);
    expect(test.pendingChannelCount()).toBe(0);
  });

  it("releases thousands of timed out payloads while preserving a later request in another channel", async () => {
    const test = setup();
    for (let id = 0; id < 2000; id += 1) test.request(100, id);
    await vi.advanceTimersByTimeAsync(50);
    test.request(100, 2000, "other");
    await vi.advanceTimersByTimeAsync(50);
    expect(test.responses).toHaveLength(2000);
    expect(test.pendingChannelCount()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    const other = channel();
    test.server.registerChannel("other", other.value);
    await vi.advanceTimersByTimeAsync(0);
    expect(other.calls).toEqual(["request-2000"]);
    expect(test.pendingChannelCount()).toBe(0);
    expect(test.responses.at(-1)).toEqual({ header: [201, 2000], body: "request-2000" });
    await vi.advanceTimersByTimeAsync(100);
    expect(test.responses).toHaveLength(2001);
  });

  it("honors timeout, cancellation and unsubscribe from a real ChannelClient", async () => {
    const toServer = new Emitter<VSBuffer>();
    const toClient = new Emitter<VSBuffer>();
    const client = new ChannelClient({
      onMessage: toClient.event,
      send: (data) => toServer.fire(data),
    });
    const server = new ChannelServer(
      { onMessage: toServer.event, send: (data) => toClient.fire(data) },
      "fixture",
      100,
    );
    const cancellation = new CancellationTokenSource();
    cleanups.push(
      () => client.dispose(),
      () => server.dispose(),
      () => cancellation.dispose(),
      () => toServer.dispose(),
      () => toClient.dispose(),
    );
    const remote = client.getChannel("late");
    const timedOut = remote.call("timed-out").catch((error: Error) => error.name);
    const cancelled = remote
      .call("cancelled", undefined, cancellation.token)
      .catch((error: Error) => error.message);
    const subscription = remote.listen("unsubscribed")(() => {});
    cancellation.cancel();
    subscription.dispose();
    expect(await cancelled).toBe("Cancelled");
    await vi.advanceTimersByTimeAsync(100);
    expect(await timedOut).toBe("Unknown channel");
    const late = channel();
    server.registerChannel("late", late.value);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.calls).toEqual([]);
    expect(await remote.call("live")).toBe("live");
    expect(late.calls).toEqual(["live"]);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["cancel", "dispose"])(
    "cleans a never-settling call that synchronously triggers %s",
    async (action) => {
      const test = setup();
      let token: CancellationToken | undefined;
      const late = channel();
      test.request(100, 1);
      test.server.registerChannel("late", {
        ...late.value,
        call: <T>(_ctx: string, _name: string, _arg: unknown, cancellation?: CancellationToken) => {
          token = cancellation;
          if (action === "dispose") test.server.dispose();
          else test.request(101, 1);
          return new Promise<T>(() => {});
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(token?.isCancellationRequested).toBe(true);
      expect(test.activeRequestCount()).toBe(0);
    },
  );

  it.each(["unsubscribe", "dispose"])(
    "disposes a subscription returned after synchronous %s",
    async (action) => {
      const test = setup();
      let disposed = 0;
      const late = channel();
      test.request(102, 1);
      test.server.registerChannel("late", {
        ...late.value,
        listen:
          <T>() =>
          (listener: (value: T) => void) => {
            listener("first" as T);
            if (action === "dispose") test.server.dispose();
            else test.request(103, 1);
            listener("after-dispose" as T);
            return {
              dispose: () => {
                disposed += 1;
              },
            };
          },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(disposed).toBe(1);
      expect(test.activeRequestCount()).toBe(0);
      expect(test.responses).toEqual([{ header: [204, 1], body: "first" }]);
      test.server.dispose();
      test.request(103, 1);
      expect(disposed).toBe(1);
    },
  );

  it("removes an active subscription placeholder when listen throws synchronously", () => {
    const test = setup();
    const late = channel();
    test.server.registerChannel("late", {
      ...late.value,
      listen: () => {
        throw new Error("fixture");
      },
    });
    expect(() => test.request(102, 1)).toThrow("fixture");
    expect(test.activeRequestCount()).toBe(0);
  });
});
