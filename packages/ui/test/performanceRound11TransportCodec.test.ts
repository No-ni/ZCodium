import { describe, expect, it, vi } from "vitest";
import {
  BufferReader,
  BufferWriter,
  ChannelClient,
  ChannelServer,
  Emitter,
  Event,
  VSBuffer,
  deserialize,
  serialize,
  type IChannel,
  type IMessagePassingProtocol,
  type IReader,
  type IServerChannel,
} from "@zcode/rpc";

async function measureSliceCopies(run: () => Promise<unknown>): Promise<{
  value: unknown;
  copiedBytes: number;
}> {
  const originalSlice = Uint8Array.prototype.slice;
  let copiedBytes = 0;
  const sliceSpy = vi.spyOn(Uint8Array.prototype, "slice").mockImplementation(function (
    this: Uint8Array,
    start?: number,
    end?: number,
  ) {
    const result = originalSlice.call(this, start, end);
    copiedBytes += result.byteLength;
    return result;
  });
  try {
    return { value: await run(), copiedBytes };
  } finally {
    sliceSpy.mockRestore();
  }
}

function createProtocolPair(): {
  client: IMessagePassingProtocol;
  server: IMessagePassingProtocol;
  dispose(): void;
} {
  const toServer = new Emitter<VSBuffer>();
  const toClient = new Emitter<VSBuffer>();
  return {
    client: { onMessage: toClient.event, send: (message) => toServer.fire(message) },
    server: { onMessage: toServer.event, send: (message) => toClient.fire(message) },
    dispose() {
      toServer.dispose();
      toClient.dispose();
    },
  };
}

function roundTripChannel(): {
  client: ChannelClient;
  server: ChannelServer;
  transport: ReturnType<typeof createProtocolPair>;
  channel: IChannel;
} {
  const transport = createProtocolPair();
  const client = new ChannelClient(transport.client);
  const server = new ChannelServer(transport.server, "round11", 1000, true);
  const echo: IServerChannel = {
    async call<T>(_context, _command, arg) {
      return arg as T;
    },
    listen<T>() {
      return Event.None as Event<T>;
    },
  };
  server.registerChannel("round11", echo);
  server.ready();
  return { client, server, transport, channel: client.getChannel("round11") };
}

describe("RPC decoder single-byte work", () => {
  it("keeps decoder byte copies independent of a large small-integer payload", async () => {
    const rpc = roundTripChannel();
    const values = Array.from({ length: 1024 }, (_, index) => index % 128);
    try {
      const result = await measureSliceCopies(() => rpc.channel.call<number[]>("echo", values));
      expect(result.value).toEqual(values);
      expect(result.copiedBytes).toBeLessThanOrEqual(256);
    } finally {
      rpc.client.dispose();
      rpc.server.dispose();
      rpc.transport.dispose();
    }
  });

  it("preserves generic readers and BufferReader read-copy and truncation behavior", () => {
    const writer = new BufferWriter();
    serialize(writer, 128);
    const encoded = writer.buffer.buffer;
    let offset = 0;
    const genericReader: IReader = {
      read(byteCount) {
        const bytes = encoded.subarray(offset, offset + byteCount);
        offset += bytes.byteLength;
        return VSBuffer.wrap(bytes);
      },
    };
    expect(deserialize(genericReader)).toBe(128);

    const input = VSBuffer.fromString("abc");
    const reader = new BufferReader(input);
    const copied = reader.read(2);
    copied.writeUInt8(0, 0);
    expect(input.toString()).toBe("abc");
    expect(reader.read(1).toString()).toBe("c");
    expect(reader.read(1).byteLength).toBe(0);
    expect(reader.read(1).byteLength).toBe(0);

    expect(deserialize(new BufferReader(VSBuffer.alloc(0)))).toBeUndefined();
    expect(deserialize(new BufferReader(VSBuffer.wrap(new Uint8Array([6, 0x80]))))).toBe(0);
    expect(
      deserialize(
        new BufferReader(VSBuffer.wrap(new Uint8Array([6, 0x80, 0x80, 0x80, 0x80, 0x80, 1]))),
      ),
    ).toBe(8);
  });

  it("preserves integer, binary, and nested Uint8Array round trips", () => {
    const nestedBytes = new Uint8Array([4, 5, 6]);
    const values = [
      0,
      127,
      128,
      16_383,
      16_384,
      2_147_483_647,
      -2_147_483_648,
      4_294_967_295,
      new Uint8Array([1, 2, 3]),
      VSBuffer.wrap(new Uint8Array([7, 8, 9])),
      { nested: { bytes: nestedBytes } },
    ];
    const writer = new BufferWriter();
    serialize(writer, values);
    const result = deserialize(new BufferReader(writer.buffer)) as unknown[];

    expect(result.slice(0, 8)).toEqual(values.slice(0, 8));
    expect(result[8]).toEqual(values[8]);
    expect(result[9]).toBeInstanceOf(VSBuffer);
    expect([...(result[9] as VSBuffer).buffer]).toEqual([7, 8, 9]);
    expect(result[10]).toEqual({ nested: { bytes: nestedBytes } });
  });
});
