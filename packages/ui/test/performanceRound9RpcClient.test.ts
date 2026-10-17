import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BufferReader,
  BufferWriter,
  CancellationTokenSource,
  ChannelClient,
  ChannelServer,
  deserialize,
  Emitter,
  serialize,
  type IServerChannel,
  type VSBuffer,
} from "@zcode/rpc";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup(onSubscribe?: () => void) {
  vi.useFakeTimers();
  const clientInput = new Emitter<VSBuffer>();
  const serverInput = new Emitter<VSBuffer>();
  const source = new Emitter<number>();
  const requests: Array<{ header: any[]; body: unknown }> = [];
  let subscriptions = 0;
  const client = new ChannelClient({
    onMessage: clientInput.event,
    send(buffer) {
      const reader = new BufferReader(buffer);
      requests.push({ header: deserialize(reader), body: deserialize(reader) });
      serverInput.fire(buffer);
    },
  });
  const server = new ChannelServer(
    { onMessage: serverInput.event, send: (buffer) => clientInput.fire(buffer) },
    "fixture",
    100,
    true,
  );
  const channel: IServerChannel = {
    async call<T>(_ctx, command, arg) {
      return { command, arg } as T;
    },
    listen<T>() {
      return (listener: (data: T) => void) => {
        subscriptions += 1;
        const disposable = source.event(listener as (data: number) => void);
        onSubscribe?.();
        return {
          dispose() {
            subscriptions -= 1;
            disposable.dispose();
          },
        };
      };
    },
  };
  server.registerChannel("fixture", channel);
  cleanups.push(
    () => client.dispose(),
    () => server.dispose(),
    () => source.dispose(),
    () => clientInput.dispose(),
    () => serverInput.dispose(),
  );
  const internals = client as unknown as {
    requests: Map<number, unknown>;
    _onDidInitialize: { listeners: Set<unknown> };
  };
  const fireOld = (id: number, value: number) => {
    const writer = new BufferWriter();
    serialize(writer, [204, id]);
    serialize(writer, value);
    clientInput.fire(writer.buffer);
  };
  return {
    client,
    server,
    source,
    requests,
    internals,
    fireOld,
    subscriptions: () => subscriptions,
    channel: client.getChannel("fixture"),
  };
}

describe("RPC client subscription and initialization lifetime", () => {
  it("does not retain handlers for events which are never subscribed", () => {
    const test = setup();
    for (let i = 0; i < 1000; i++) test.channel.listen("event", { i });
    expect(test.internals.requests.size).toBe(0);
    expect(test.requests).toEqual([]);
  });

  it("removes every abandoned initialize wait and never subscribes it later", async () => {
    const test = setup();
    const event = test.channel.listen("event", { fixture: "payload" });
    for (let i = 0; i < 500; i++) event(() => {}).dispose();
    const pendingWaits = test.internals._onDidInitialize.listeners.size;
    test.server.ready();
    await Promise.resolve();
    expect(test.subscriptions()).toBe(0);
    expect(pendingWaits).toBe(0);
    expect(test.internals.requests.size).toBe(0);
    expect(test.requests).toEqual([]);
  });

  it("shares each live subscription, restores delivery on resubscribe and ignores the old id", () => {
    const test = setup();
    test.server.ready();
    const event = test.channel.listen<number>("event");
    const first: number[] = [];
    const second: number[] = [];
    const a = event((value) => first.push(value));
    const b = event((value) => second.push(value));
    expect(test.subscriptions()).toBe(1);
    test.source.fire(1);
    a.dispose();
    test.source.fire(2);
    b.dispose();
    expect(test.subscriptions()).toBe(0);
    const oldId = test.requests[0].header[1];
    const c = event((value) => first.push(value));
    test.source.fire(3);
    test.fireOld(oldId, 999);
    c.dispose();
    expect(first).toEqual([1, 3]);
    expect(second).toEqual([1, 2]);
    expect(test.subscriptions()).toBe(0);
    expect(test.internals.requests.size).toBe(0);
    expect(test.requests.map((request) => request.header[0])).toEqual([102, 103, 102, 103]);
  });

  it("terminates both waiting and active subscriptions on client dispose", async () => {
    const test = setup();
    const event = test.channel.listen("event");
    const subscription = event(() => {});
    test.client.dispose();
    test.server.ready();
    await Promise.resolve();
    event(() => {}).dispose();
    subscription.dispose();
    expect(test.subscriptions()).toBe(0);
    expect(test.internals.requests.size).toBe(0);
    expect(test.requests).toEqual([]);

    const active = setup();
    active.server.ready();
    const activeEvent = active.channel.listen("event");
    activeEvent(() => {});
    active.client.dispose();
    activeEvent(() => {}).dispose();
    expect(active.subscriptions()).toBe(0);
    expect(active.internals.requests.size).toBe(0);
    expect(active.requests.map((request) => request.header[0])).toEqual([102, 103]);
  });

  it("handles synchronous events and dispose during remote subscription setup", () => {
    let test: ReturnType<typeof setup>;
    test = setup(() => test.source.fire(7));
    test.server.ready();
    const values: number[] = [];
    test.channel.listen<number>("event")((value) => {
      values.push(value);
      test.client.dispose();
    });
    expect(values).toEqual([7]);
    expect(test.subscriptions()).toBe(0);
    expect(test.internals.requests.size).toBe(0);
  });

  it("drops cancelled Promise initialize listeners immediately and keeps valid calls ordered", async () => {
    const test = setup();
    const cancelled: Promise<unknown>[] = [];
    for (let i = 0; i < 300; i++) {
      const cancellation = new CancellationTokenSource();
      cancelled.push(
        test.channel.call("cancelled", { i }, cancellation.token).catch((e) => e.message),
      );
      cancellation.cancel();
      cancellation.dispose();
    }
    await Promise.all(cancelled);
    expect(test.internals._onDidInitialize.listeners.size).toBe(0);
    const first = test.channel.call("first", 1);
    const second = test.channel.call("second", 2);
    test.server.ready();
    expect(test.requests.filter((request) => request.header[0] === 100)).toHaveLength(0);
    await expect(first).resolves.toEqual({ command: "first", arg: 1 });
    await expect(second).resolves.toEqual({ command: "second", arg: 2 });
    expect(
      test.requests.filter((request) => request.header[0] === 100).map((r) => r.header[3]),
    ).toEqual(["first", "second"]);
  });

  it("does not revive a superseded pre-initialize subscription generation", async () => {
    const test = setup();
    const values: number[] = [];
    const event = test.channel.listen<number>("event");
    event(() => values.push(-1)).dispose();
    const subscription = event((value) => values.push(value));
    test.server.ready();
    await Promise.resolve();
    test.source.fire(5);
    subscription.dispose();
    expect(values).toEqual([5]);
    expect(test.subscriptions()).toBe(0);
    expect(test.requests.filter((request) => request.header[0] === 102)).toHaveLength(1);
  });

  it("drops an initialized subscription and Promise cancelled before their send microtask", async () => {
    const test = setup();
    const cancellation = new CancellationTokenSource();
    const call = test.channel
      .call("cancelled", undefined, cancellation.token)
      .catch((e) => e.message);
    const subscription = test.channel.listen("event")(() => {});
    test.server.ready();
    subscription.dispose();
    cancellation.cancel();
    await expect(call).resolves.toBe("Cancelled");
    expect(test.subscriptions()).toBe(0);
    expect(test.internals.requests.size).toBe(0);
    expect(test.requests.filter((request) => request.header[0] !== 101)).toEqual([]);
    cancellation.dispose();
  });
});
