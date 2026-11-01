import assert from "node:assert/strict";
import test from "node:test";
import { Emitter, Event, type IDisposable } from "../src/foundation.js";
import { IpcConnectionScope } from "../src/ipcLifecycle.js";
import { BufferWriter, serialize } from "../src/serialization.js";
import type { VSBuffer } from "../src/buffer.js";
import type { ChannelClient, ChannelServer } from "../src/channels.js";

function source<T>(initial: T[] = []) {
  const listeners = new Set<(value: T) => void>();
  let disposals = 0;
  let lastListener: ((value: T) => void) | undefined;
  const event: Event<T> = (listener) => {
    listeners.add(listener);
    lastListener = listener;
    for (const value of initial) listener(value);
    return {
      dispose() {
        disposals += 1;
        listeners.delete(listener);
      },
    };
  };
  return {
    event,
    get live() {
      return listeners.size;
    },
    get disposals() {
      return disposals;
    },
    fire(value: T) {
      for (const listener of Array.from(listeners)) listener(value);
    },
    late(value: T) {
      lastListener?.(value);
    },
  };
}

test("once delivers a synchronous registration event and releases its late handle", () => {
  const input = source([7]);
  const values: number[] = [];
  let returned = false;
  const subscription = Event.once(input.event)((value) => {
    assert.equal(returned, false, "synchronous source delivery stays synchronous");
    values.push(value);
  });
  returned = true;
  assert.deepEqual(values, [7]);
  assert.equal(input.live, 0);
  assert.equal(input.disposals, 1);
  subscription.dispose();
  assert.equal(input.disposals, 1);
});

test("once accepts only the first synchronous value and ignores queued delivery", () => {
  const input = source([1, 2, 3]);
  const values: number[] = [];
  Event.once(input.event)((value) => values.push(value));
  input.late(4);
  assert.deepEqual(values, [1]);
  assert.equal(input.live, 0);
  assert.equal(input.disposals, 1);
});

test("toPromise resolves the first synchronous value and leaves no subscription", async () => {
  const input = source(["first", "second"]);
  assert.equal(await Event.toPromise(input.event), "first");
  assert.equal(input.live, 0);
  assert.equal(input.disposals, 1);
});

test("asynchronous once releases upstream before notification and blocks reentrant fire", () => {
  const input = source<number>();
  const values: number[] = [];
  const subscription = Event.once(input.event)((value) => {
    assert.equal(input.live, 0);
    values.push(value);
    input.fire(8);
    input.late(9);
  });
  assert.equal(input.live, 1);
  input.fire(7);
  subscription.dispose();
  subscription.dispose();
  assert.deepEqual(values, [7]);
  assert.equal(input.disposals, 1);
});

test("manual disposal before the first event suppresses a queued callback", () => {
  const input = source<number>();
  const values: number[] = [];
  const subscription = Event.once(input.event)((value) => values.push(value));
  subscription.dispose();
  subscription.dispose();
  input.fire(1);
  input.late(2);
  assert.deepEqual(values, []);
  assert.equal(input.live, 0);
  assert.equal(input.disposals, 1);
});

test("independent once listeners each finish on the same emitter value", () => {
  const emitter = new Emitter<number>();
  const values: string[] = [];
  Event.once(emitter.event)((value) => values.push(`a:${value}`));
  Event.once(emitter.event)((value) => values.push(`b:${value}`));
  emitter.fire(4);
  emitter.fire(5);
  assert.deepEqual(values, ["a:4", "b:4"]);
  emitter.dispose();
});

test("IPC scope accepts identity delivered synchronously during registration", () => {
  const writer = new BufferWriter();
  serialize(writer, "fixture-context");
  const input = source<VSBuffer>([writer.buffer]);
  const disconnect = source<void>();
  const steps: string[] = [];
  let owned = true;
  const channelServer = { dispose: () => steps.push("server-dispose") } as ChannelServer<string>;
  const channelClient = { dispose: () => steps.push("client-dispose") } as ChannelClient;
  const scope = new IpcConnectionScope<string>(
    { onMessage: input.event, send() {} },
    {
      createChannelServer(_protocol, ctx) {
        assert.equal(ctx, "fixture-context");
        steps.push("server-create");
        return channelServer;
      },
      createChannelClient() {
        steps.push("client-create");
        return channelClient;
      },
      forEachRegisteredChannel() {},
      acceptConnection(connection) {
        assert.equal(connection.ctx, "fixture-context");
        steps.push("accepted");
      },
      notifyRemoved() {
        steps.push("removed");
      },
      removeScope() {
        owned = false;
      },
    },
  );
  scope.initialize(disconnect.event);
  assert.equal(scope.connection?.ctx, "fixture-context");
  assert.equal(input.live, 0, "temporary identity listener is detached immediately");
  assert.equal(input.disposals, 1);
  assert.equal(disconnect.live, 1);
  assert.equal(owned, true);
  scope.dispose();
  scope.dispose();
  assert.equal(owned, false);
  assert.equal(disconnect.live, 0);
  assert.equal(input.disposals, 1);
  assert.deepEqual(steps, [
    "server-create",
    "client-create",
    "accepted",
    "server-dispose",
    "client-dispose",
    "removed",
  ]);
});

test("once preserves listener exceptions after releasing an asynchronous subscription", () => {
  const input = source<number>();
  const failure = new Error("FIXTURE_LISTENER_FAILURE");
  const subscription: IDisposable = Event.once(input.event)(() => {
    throw failure;
  });
  assert.throws(
    () => input.fire(1),
    (error) => error === failure,
  );
  assert.equal(input.live, 0);
  subscription.dispose();
  assert.equal(input.disposals, 1);
});
