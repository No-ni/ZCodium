import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BufferReader,
  BufferWriter,
  ChannelServer,
  ChannelClient,
  CancellationTokenSource,
  deserialize,
  Emitter,
  serialize,
  ProxyChannel,
  type CancellationToken,
  type IServerChannel,
  type VSBuffer,
} from "../src/index.js";

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

function setup() {
  const incoming = new Emitter<VSBuffer>();
  const responses: Array<{ header: number[]; body: any }> = [];
  let failSend = false;
  const server = new ChannelServer(
    {
      onMessage: incoming.event,
      send(buffer) {
        if (failSend) throw new Error("fixture send failure");
        const reader = new BufferReader(buffer);
        responses.push({ header: deserialize(reader), body: deserialize(reader) });
      },
    },
    "fixture",
    100,
    true,
  );
  cleanups.push(
    () => server.dispose(),
    () => incoming.dispose(),
  );
  const request = (type: number, id: number, channelName = "fixture", name = "work") => {
    const writer = new BufferWriter();
    serialize(writer, [type, id, channelName, name]);
    serialize(writer, undefined);
    incoming.fire(writer.buffer);
  };
  const register = (value: Partial<IServerChannel>) =>
    server.registerChannel("fixture", {
      call: async <T>() => "ok" as T,
      listen: () => () => ({ dispose() {} }),
      ...value,
    });
  return {
    server,
    responses,
    request,
    register,
    fail() {
      failSend = true;
    },
  };
}

async function microtasks() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("ChannelServer request ownership", () => {
  it.each(["success", "error", "value-error"])(
    "completes %s without cancelling its token",
    async (kind) => {
      const test = setup();
      let token: CancellationToken | undefined;
      let cancelled = 0;
      const error = Object.assign(new Error("fixture"), {
        code: "fixture-code",
        details: { ok: true },
      });
      test.register({
        call: <T>(_ctx, _command, _arg, value) => {
          token = value;
          value!.onCancellationRequested(() => cancelled++);
          return kind === "success"
            ? Promise.resolve("ok" as T)
            : Promise.reject(kind === "error" ? error : { reason: "fixture" });
        },
      });
      test.request(100, 1);
      await microtasks();
      expect(cancelled).toBe(0);
      expect(token?.isCancellationRequested).toBe(false);
      expect(test.responses[0]?.header).toEqual([
        kind === "success" ? 201 : kind === "error" ? 202 : 203,
        1,
      ]);
      if (kind === "error")
        expect(test.responses[0]?.body).toMatchObject({
          name: "Error",
          message: "fixture",
          code: "fixture-code",
          details: { ok: true },
        });
      test.request(101, 1);
      test.server.dispose();
      expect(cancelled).toBe(0);
    },
  );

  it.each(["cancel", "dispose"])(
    "does not inspect or send late completion after %s",
    async (action) => {
      const test = setup();
      let resolve!: (value: unknown) => void;
      let cancelled = 0;
      let serialized = 0;
      test.register({
        call: <T>(_ctx, _name, _arg, token) => {
          token!.onCancellationRequested(() => cancelled++);
          return new Promise<T>((done) => (resolve = done));
        },
      });
      test.request(100, 1);
      if (action === "cancel") test.request(101, 1);
      else test.server.dispose();
      resolve({
        toJSON() {
          serialized++;
          return "late";
        },
      });
      await microtasks();
      expect(cancelled).toBe(1);
      expect(serialized).toBe(0);
      expect(test.responses).toEqual([]);
    },
  );

  it("does not inspect a late rejection after cancellation", async () => {
    const test = setup();
    let reject!: (value: unknown) => void;
    let inspected = 0;
    test.register({ call: <T>() => new Promise<T>((_resolve, done) => (reject = done)) });
    test.request(100, 1);
    test.request(101, 1);
    const error = new Error("late");
    Object.defineProperty(error, "message", {
      get() {
        inspected++;
        return "late";
      },
    });
    reject(error);
    await microtasks();
    expect(inspected).toBe(0);
    expect(test.responses).toEqual([]);
  });

  it("keeps a replacement request owned when an old completion arrives", async () => {
    const test = setup();
    let first!: (value: unknown) => void;
    let secondCancelled = 0;
    let calls = 0;
    test.register({
      call: <T>(_ctx, _name, _arg, token) => {
        if (calls++ === 0) return new Promise<T>((done) => (first = done));
        token!.onCancellationRequested(() => secondCancelled++);
        return new Promise<T>(() => {});
      },
    });
    test.request(100, 1);
    test.request(101, 1);
    test.request(100, 1);
    first("old");
    await microtasks();
    test.request(101, 1);
    expect(secondCancelled).toBe(1);
    expect(test.responses).toEqual([]);
  });

  it("releases an event subscription when sending fails, including a synchronous first event", () => {
    const test = setup();
    let disposed = 0;
    let listener: ((value: unknown) => void) | undefined;
    test.register({
      listen:
        <T>() =>
        (callback: (value: T) => void) => {
          listener = callback;
          callback("first" as T);
          return {
            dispose() {
              disposed++;
            },
          };
        },
    });
    test.fail();
    test.request(102, 1);
    listener?.("later");
    expect(disposed).toBe(1);
    test.server.dispose();
    expect(disposed).toBe(1);
  });

  it("continues connection cleanup after a subscription disposer throws", () => {
    const test = setup();
    const disposed: string[] = [];
    test.register({
      listen:
        <T>(_ctx: string, name: string) =>
        (_callback: (value: T) => void) => ({
          dispose() {
            disposed.push(name);
            if (name === "throws") throw new Error("fixture dispose failure");
          },
        }),
    });
    test.request(102, 1, "fixture", "throws");
    test.request(102, 2, "fixture", "other");
    expect(() => test.server.dispose()).not.toThrow();
    expect(disposed).toEqual(["throws", "other"]);
    test.server.dispose();
    expect(disposed).toHaveLength(2);
  });

  it("does not revive a disposed server through ready or channel registration", () => {
    const test = setup();
    test.server.dispose();
    test.server.ready();
    test.register({});
    test.request(100, 1);
    expect(test.responses).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps synchronous listen exceptions visible after releasing the request", () => {
    const test = setup();
    test.register({
      listen() {
        throw new Error("fixture listen failure");
      },
    });
    expect(() => test.request(102, 1)).toThrow("fixture listen failure");
    test.register({});
    test.request(102, 1);
    test.request(103, 1);
  });

  it.each(["success", "error", "value-error", "throwing-field"])(
    "returns the existing error wire shape when %s cannot be serialized",
    async (kind) => {
      const test = setup();
      const circular: { self?: unknown } = {};
      circular.self = circular;
      const error = Object.assign(new Error("fixture"), { details: circular });
      if (kind === "throwing-field")
        Object.defineProperty(error, "message", {
          get() {
            throw new Error("fixture getter");
          },
        });
      test.register({
        call: <T>() =>
          kind === "success"
            ? Promise.resolve(circular as T)
            : Promise.reject(kind === "value-error" ? circular : error),
      });
      test.request(100, 1);
      await microtasks();
      expect(test.responses).toEqual([
        {
          header: [202, 1],
          body: {
            name: "SerializationError",
            message: "RPC response could not be serialized",
          },
        },
      ]);
    },
  );

  it("finishes serialization errors even if sending their deterministic error also fails", async () => {
    const test = setup();
    let cancelled = 0;
    const circular: { self?: unknown } = {};
    circular.self = circular;
    test.register({
      call: <T>(_ctx, _name, _arg, token) => {
        token!.onCancellationRequested(() => cancelled++);
        return Promise.resolve(circular as T);
      },
    });
    test.fail();
    test.request(100, 1);
    await microtasks();
    test.request(101, 1);
    test.server.dispose();
    expect(cancelled).toBe(0);
    expect(test.responses).toEqual([]);
  });

  it("releases the late event handle when its synchronous first payload cannot be serialized", () => {
    const test = setup();
    let disposed = 0;
    const circular: { self?: unknown } = {};
    circular.self = circular;
    test.register({
      listen:
        <T>() =>
        (callback: (value: T) => void) => {
          callback(circular as T);
          return {
            dispose() {
              disposed++;
            },
          };
        },
    });
    expect(() => test.request(102, 1)).not.toThrow();
    expect(disposed).toBe(1);
    test.server.dispose();
    expect(disposed).toBe(1);
  });

  it("does not send a response if user serialization synchronously disposes the server", async () => {
    const test = setup();
    test.register({
      call: async <T>() =>
        ({
          toJSON() {
            test.server.dispose();
            return "finished";
          },
        }) as T,
    });
    test.request(100, 1);
    await microtasks();
    expect(test.responses).toEqual([]);
  });

  it("cleans all requests even if one cancellation listener throws", () => {
    const test = setup();
    const cancelled: string[] = [];
    test.register({
      call: <T>(_ctx, name, _arg, token) => {
        token!.onCancellationRequested(() => {
          cancelled.push(name);
          if (name === "throws") throw new Error("fixture cancellation");
        });
        return new Promise<T>(() => {});
      },
    });
    test.request(100, 1, "fixture", "throws");
    test.request(100, 2, "fixture", "other");
    expect(() => test.server.dispose()).not.toThrow();
    expect(cancelled).toEqual(["throws", "other"]);
  });

  it.each(["cancel", "dispose"])(
    "ends waiting requests before late channel registration after %s",
    async (action) => {
      const test = setup();
      const calls: string[] = [];
      test.request(100, 1);
      test.request(102, 2);
      if (action === "cancel") {
        test.request(101, 1);
        test.request(103, 2);
      } else test.server.dispose();
      test.register({
        call: async <T>() => {
          calls.push("called");
          return "ok" as T;
        },
        listen:
          <T>() =>
          (_listener: (value: T) => void) => {
            calls.push("listened");
            return { dispose() {} };
          },
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(calls).toEqual([]);
      expect(test.responses).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("expires waiting calls once and never dispatches them to a late channel", async () => {
    const test = setup();
    test.request(100, 1);
    test.request(102, 2);
    await vi.advanceTimersByTimeAsync(100);
    const calls: string[] = [];
    test.register({
      call: async <T>() => {
        calls.push("late");
        return "ok" as T;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([]);
    expect(test.responses).toEqual([
      {
        header: [202, 1],
        body: {
          name: "Unknown channel",
          message: "Channel name 'fixture' timed out after 100ms",
        },
      },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not publish an event cancelled synchronously by its serialization", () => {
    const test = setup();
    let disposed = 0;
    test.register({
      listen:
        <T>() =>
        (listener: (value: T) => void) => {
          listener({
            toJSON() {
              test.request(103, 1);
              return "cancelled";
            },
          } as T);
          return {
            dispose() {
              disposed++;
            },
          };
        },
    });
    test.request(102, 1);
    expect(test.responses).toEqual([]);
    expect(disposed).toBe(1);
  });

  it("uses real Client and service proxy cancellation without undoing an admitted action", async () => {
    const input = new Emitter<VSBuffer>();
    const output = new Emitter<VSBuffer>();
    const client = new ChannelClient({
      onMessage: output.event,
      send: (buffer) => input.fire(buffer),
    });
    const responses: VSBuffer[] = [];
    const server = new ChannelServer(
      {
        onMessage: input.event,
        send(buffer) {
          responses.push(buffer);
          output.fire(buffer);
        },
      },
      "fixture",
    );
    const cancellation = new CancellationTokenSource();
    cleanups.push(
      () => client.dispose(),
      () => server.dispose(),
      () => cancellation.dispose(),
      () => input.dispose(),
      () => output.dispose(),
    );
    let release!: () => void;
    let admitted = 0;
    let completed = 0;
    server.registerChannel(
      "fixture",
      ProxyChannel.fromService({
        async work() {
          admitted++;
          await new Promise<void>((resolve) => (release = resolve));
          completed++;
          return "accepted";
        },
      }),
    );
    const work = client
      .getChannel("fixture")
      .call("work", [], cancellation.token)
      .catch((error: Error) => error.message);
    await microtasks();
    expect(admitted).toBe(1);
    cancellation.cancel();
    expect(await work).toBe("Cancelled");
    const before = responses.length;
    release();
    await microtasks();
    expect(completed).toBe(1);
    expect(responses).toHaveLength(before);
  });
});
