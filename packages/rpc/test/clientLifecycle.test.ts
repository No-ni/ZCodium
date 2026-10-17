import { afterEach, describe, expect, it } from "vitest";
import {
  BufferReader,
  BufferWriter,
  CancellationTokenSource,
  ChannelClient,
  deserialize,
  Emitter,
  serialize,
  type VSBuffer,
} from "../src/index.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

function encoded(header: number[], body?: unknown) {
  const writer = new BufferWriter();
  serialize(writer, header);
  serialize(writer, body);
  return writer.buffer;
}

function fixture(send: (data: VSBuffer, input: Emitter<VSBuffer>) => void = () => {}) {
  const input = new Emitter<VSBuffer>();
  const client = new ChannelClient({ onMessage: input.event, send: (data) => send(data, input) });
  cleanup.push(
    () => client.dispose(),
    () => input.dispose(),
  );
  return { client, input, channel: client.getChannel("fixture") };
}

function ownedRequests(client: ChannelClient): number {
  return (client as unknown as { requests: Map<number, unknown> }).requests.size;
}

describe("client request termination", () => {
  it("rejects a failed transport send and releases the request without waiting for close", async () => {
    const boom = new Error("transport rejected send");
    const test = fixture(() => {
      throw boom;
    });
    test.input.fire(encoded([200]));
    const outcomes: unknown[] = [];
    test.channel.call("work").then(
      (value) => outcomes.push(value),
      (error) => outcomes.push(error),
    );
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(outcomes).toEqual([boom]);
    expect(ownedRequests(test.client)).toBe(0);
  });

  it("releases an encoding failure and still accepts a later serializable call", async () => {
    const test = fixture((data, input) => {
      const reader = new BufferReader(data);
      const header = deserialize(reader);
      if (header[0] === 100) input.fire(encoded([201, header[1]], "ok"));
    });
    test.input.fire(encoded([200]));
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    await expect(test.channel.call("broken", cyclic)).rejects.toThrow();
    expect(ownedRequests(test.client)).toBe(0);
    await expect(test.channel.call("valid")).resolves.toBe("ok");
    expect(ownedRequests(test.client)).toBe(0);
  });

  it("makes cancellation terminal before its wire notification can synchronously reply", async () => {
    const test = fixture((data, input) => {
      const reader = new BufferReader(data);
      const header = deserialize(reader);
      if (header[0] === 101) input.fire(encoded([201, header[1]], "late success"));
    });
    test.input.fire(encoded([200]));
    const source = new CancellationTokenSource();
    cleanup.push(() => source.dispose());
    const result = test.channel
      .call("work", undefined, source.token)
      .catch((error: Error) => error.message);
    source.cancel();
    await expect(result).resolves.toBe("Cancelled");
    expect(ownedRequests(test.client)).toBe(0);
  });

  it("releases a cancellation handle returned after synchronous cancellation", async () => {
    let released = 0;
    const test = fixture();
    const result = test.channel.call("work", undefined, {
      isCancellationRequested: false,
      onCancellationRequested(listener) {
        listener();
        return {
          dispose() {
            released++;
          },
        };
      },
    });
    await expect(result).rejects.toThrow("Cancelled");
    expect(released).toBe(1);
    expect(ownedRequests(test.client)).toBe(0);
  });

  it("does not send a request cancelled by user code during encoding", async () => {
    const sent: unknown[] = [];
    const test = fixture((data) => sent.push(data));
    test.input.fire(encoded([200]));
    const source = new CancellationTokenSource();
    cleanup.push(() => source.dispose());
    const result = test.channel.call(
      "work",
      {
        toJSON() {
          source.cancel();
          return "data";
        },
      },
      source.token,
    );
    await expect(result).rejects.toThrow("Cancelled");
    expect(sent).toEqual([]);
    expect(ownedRequests(test.client)).toBe(0);
  });

  it("settles and drains every request when external cancellation disposers throw", async () => {
    const test = fixture();
    let released = 0;
    const calls = Array.from({ length: 20 }, () =>
      test.channel
        .call("work", undefined, {
          isCancellationRequested: false,
          onCancellationRequested() {
            return {
              dispose() {
                released++;
                throw new Error("cleanup failed");
              },
            };
          },
        })
        .catch((error: Error) => error.name),
    );
    test.client.dispose();
    expect(await Promise.all(calls)).toEqual(Array(20).fill("ConnectionClosed"));
    expect(released).toBe(20);
    expect(ownedRequests(test.client)).toBe(0);
  });
});
