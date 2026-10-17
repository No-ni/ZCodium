import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChunkStream,
  Emitter,
  PersistentProtocol,
  ProtocolMessageType,
  SocketProtocol,
  VSBuffer,
  type ISocket,
} from "@zcode/rpc";

afterEach(() => vi.restoreAllMocks());

function copyWork(run: () => void): number {
  const original = Uint8Array.prototype.slice;
  const originalSet = Uint8Array.prototype.set;
  let bytes = 0;
  const spy = vi.spyOn(Uint8Array.prototype, "slice").mockImplementation(function (
    this: Uint8Array,
    start?: number,
    end?: number,
  ) {
    const result = original.call(this, start, end);
    bytes += result.byteLength;
    return result;
  });
  const setSpy = vi.spyOn(Uint8Array.prototype, "set").mockImplementation(function (
    this: Uint8Array,
    source: ArrayLike<number>,
    offset?: number,
  ) {
    bytes += source.length;
    originalSet.call(this, source, offset);
  });
  try {
    run();
  } finally {
    spy.mockRestore();
    setSpy.mockRestore();
  }
  return bytes;
}

function frames(count: number): VSBuffer {
  const result = VSBuffer.alloc(count * 17);
  for (let i = 0; i < count; i++) {
    const offset = i * 17;
    result.writeUInt8(ProtocolMessageType.Regular, offset);
    result.writeUInt32BE(i + 1, offset + 1);
    result.writeUInt32BE(0, offset + 5);
    result.writeUInt32BE(4, offset + 9);
    result.writeUInt32BE(i, offset + 13);
  }
  return result;
}

describe("RPC coalesced input copy budget", () => {
  it("copies only requested bytes while consuming many short prefixes", () => {
    const stream = new ChunkStream();
    const count = 1024;
    const input = VSBuffer.alloc(count * 32);
    for (let i = 0; i < count; i++) input.writeUInt32BE(i, i * 32);
    stream.acceptChunk(input);
    const bytes = copyWork(() => {
      for (let i = 0; i < count; i++) expect(stream.read(32)!.readUInt32BE(0)).toBe(i);
    });
    expect(stream.byteLength).toBe(0);
    expect(bytes).toBeLessThanOrEqual(input.byteLength);
  });

  it.each(["socket", "persistent"])(
    "%s parses adjacent frames within a linear copy budget",
    (kind) => {
      const data = new Emitter<VSBuffer>();
      const close = new Emitter<void>();
      const socket: ISocket = {
        onData: data.event,
        onClose: close.event,
        onEnd: close.event,
        write() {},
        end() {},
        async drain() {},
        dispose() {
          data.dispose();
          close.dispose();
        },
      };
      const protocol =
        kind === "socket" ? new SocketProtocol(socket) : new PersistentProtocol(socket);
      const input = frames(1024);
      const received: number[] = [];
      protocol.onMessage((body) => received.push(body.readUInt32BE(0)));
      try {
        const bytes = copyWork(() => data.fire(input));
        expect(received).toEqual(Array.from({ length: 1024 }, (_, i) => i));
        expect(bytes).toBeLessThanOrEqual(input.byteLength * 2);
      } finally {
        protocol.dispose();
        socket.dispose();
      }
    },
  );

  it("skips discarded bytes without copying them or the suffix", () => {
    const stream = new ChunkStream();
    stream.acceptChunk(VSBuffer.alloc(65536));
    const bytes = copyWork(() => {
      for (let i = 0; i < 1024; i++) stream.skip(32);
    });
    expect(stream.byteLength).toBe(32768);
    expect(bytes).toBe(0);
  });

  it("preserves byte queue semantics, output isolation and whole-block references", () => {
    const stream = new ChunkStream();
    const input = VSBuffer.fromString("abcdef");
    stream.acceptChunk(input);
    expect(stream.read(7)).toBeNull();
    const first = stream.read(2)!;
    const preview = stream.peek(3)!;
    first.writeUInt8(0, 0);
    preview.writeUInt8(0, 0);
    stream.acceptChunk(VSBuffer.fromString("ghij"));
    expect(stream.peek(9)).toBeNull();
    expect(stream.peek(6)!.toString()).toBe("cdefgh");
    expect(stream.read(5)!.toString()).toBe("cdefg");
    stream.skip(1);
    expect(stream.read(2)!.toString()).toBe("ij");
    expect(input.toString()).toBe("abcdef");
    expect(stream.byteLength).toBe(0);
    const exact = VSBuffer.fromString("next");
    stream.acceptChunk(exact);
    expect(stream.read(4)).toBe(exact);
    expect((stream as unknown as { chunks: { length: number } }).chunks.length).toBe(0);
  });

  it("does not retain empty inputs and handles empty operations", () => {
    const stream = new ChunkStream();
    for (let i = 0; i < 1000; i++) stream.acceptChunk(VSBuffer.alloc(0));
    expect((stream as unknown as { chunks: { length: number } }).chunks.length).toBe(0);
    expect(stream.peek(0)!.byteLength).toBe(0);
    expect(stream.read(0)!.byteLength).toBe(0);
    stream.skip(0);
    expect(stream.read(1)).toBeNull();
  });
});
