import { afterEach, describe, expect, it } from "vitest";
import {
  ChunkStream,
  Emitter,
  PersistentProtocol,
  ProtocolMessage,
  ProtocolMessageType,
  SocketProtocol,
  VSBuffer,
  type ISocket,
} from "@zcode/rpc";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

// 只统计目标队列删除前缀时的逻辑后缀长度，不假定 JS 引擎实际移动字节数。
function observeRemovals(run: () => void) {
  const shift = Array.prototype.shift;
  const splice = Array.prototype.splice;
  const counts = { operations: 0, suffixReferences: 0 };
  const isQueue = (items: unknown[]) =>
    items[0] instanceof VSBuffer ||
    (items[0] as { msg?: unknown } | undefined)?.msg instanceof ProtocolMessage;
  Array.prototype.shift = function (this: unknown[]) {
    if (isQueue(this)) {
      counts.operations += 1;
      counts.suffixReferences += Math.max(this.length - 1, 0);
    }
    return shift.call(this);
  };
  Array.prototype.splice = function (
    this: unknown[],
    ...args: [start: number, deleteCount?: number, ...items: unknown[]]
  ) {
    if (args[0] === 0 && isQueue(this)) {
      counts.operations += 1;
      counts.suffixReferences += Math.max(this.length - (args[1] ?? this.length), 0);
    }
    return Reflect.apply(splice, this, args);
  };
  try {
    run();
  } finally {
    Array.prototype.shift = shift;
    Array.prototype.splice = splice;
  }
  return counts;
}

function frame(type: ProtocolMessageType, id = 0, ack = 0, body = VSBuffer.alloc(0)) {
  const encoded = VSBuffer.alloc(13 + body.byteLength);
  encoded.writeUInt8(type, 0);
  encoded.writeUInt32BE(id, 1);
  encoded.writeUInt32BE(ack, 5);
  encoded.writeUInt32BE(body.byteLength, 9);
  encoded.set(body, 13);
  return encoded;
}

function socket() {
  const data = new Emitter<VSBuffer>();
  const close = new Emitter<void>();
  const end = new Emitter<void>();
  const writes: VSBuffer[] = [];
  const value: ISocket = {
    onData: data.event,
    onClose: close.event,
    onEnd: end.event,
    write: (buffer) => writes.push(buffer),
    end() {},
    async drain() {},
    dispose() {
      data.dispose();
      close.dispose();
      end.dispose();
    },
  };
  cleanups.push(() => value.dispose());
  return { value, data, writes };
}

describe("RPC batch prefix consumption", () => {
  it("reads thousands of fragments with one prefix cleanup and preserves the suffix", () => {
    const stream = new ChunkStream();
    const count = 2048;
    const bytes = Array.from({ length: count + 8 }, (_, i) => i % 251);
    const chunks = bytes.map((byte) => Object.freeze(VSBuffer.wrap(Uint8Array.of(byte))));
    for (const chunk of chunks) stream.acceptChunk(chunk);
    let result: VSBuffer | null = null;
    const work = observeRemovals(() => {
      result = stream.read(count);
    });
    expect(Array.from(result!.buffer)).toEqual(bytes.slice(0, count));
    expect(stream.byteLength).toBe(8);
    expect(Array.from(stream.peek(8)!.buffer)).toEqual(bytes.slice(count));
    expect(Array.from(stream.read(8)!.buffer)).toEqual(bytes.slice(count));
    expect(chunks.map((chunk) => chunk.readUInt8(0))).toEqual(bytes);
    expect(work.suffixReferences).toBeLessThanOrEqual(count * 2);
    expect(work.operations).toBeLessThanOrEqual(1);
  });

  it("preserves fast-path references, failed reads, partial peeks and skip boundaries", () => {
    const stream = new ChunkStream();
    const exact = Object.freeze(VSBuffer.fromString("abc"));
    stream.acceptChunk(exact);
    expect(stream.read(4)).toBeNull();
    expect(stream.peek(4)).toBeNull();
    expect(() => stream.skip(4)).toThrow("超出可读范围");
    expect(stream.byteLength).toBe(3);
    expect(stream.peek(2)?.toString()).toBe("ab");
    expect(stream.read(3)).toBe(exact);
    stream.acceptChunk(Object.freeze(VSBuffer.fromString("one")));
    stream.acceptChunk(Object.freeze(VSBuffer.fromString("two")));
    stream.acceptChunk(Object.freeze(VSBuffer.fromString("three")));
    expect(stream.peek(5)?.toString()).toBe("onetw");
    stream.skip(4);
    expect(stream.byteLength).toBe(7);
    expect(stream.read(3)?.toString()).toBe("wot");
    expect(stream.read(4)?.toString()).toBe("hree");
    expect(stream.byteLength).toBe(0);
    expect(exact.toString()).toBe("abc");
  });

  it("matches a byte queue over deterministic mixed fragment/peek/read/skip operations", () => {
    let seed = 731;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let trial = 0; trial < 20; trial += 1) {
      const stream = new ChunkStream();
      const expected: number[] = [];
      for (let step = 0; step < 200; step += 1) {
        const operation = random() % 4;
        const count = 1 + (random() % 19);
        if (operation === 0 || expected.length === 0) {
          const bytes = Array.from({ length: count }, () => random() % 256);
          stream.acceptChunk(Object.freeze(VSBuffer.wrap(Uint8Array.from(bytes))));
          expected.push(...bytes);
        } else if (operation === 1) {
          const actual = stream.peek(count);
          expect(actual && Array.from(actual.buffer)).toEqual(
            expected.length < count ? null : expected.slice(0, count),
          );
        } else if (operation === 2) {
          const actual = stream.read(count);
          expect(actual && Array.from(actual.buffer)).toEqual(
            expected.length < count ? null : expected.splice(0, count),
          );
        } else if (expected.length >= count) {
          stream.skip(count);
          expected.splice(0, count);
        } else {
          expect(() => stream.skip(count)).toThrow("超出可读范围");
        }
        expect(stream.byteLength).toBe(expected.length);
      }
      if (expected.length > 0)
        expect(Array.from(stream.read(expected.length)!.buffer)).toEqual(expected);
    }
  });

  it("consumes empty fragments between data without losing partial suffixes", () => {
    const stream = new ChunkStream();
    for (const text of ["", "abc", "", "defg", "", "hi", ""]) {
      stream.acceptChunk(Object.freeze(VSBuffer.fromString(text)));
    }
    expect(stream.read(5)?.toString()).toBe("abcde");
    expect(stream.peek(4)?.toString()).toBe("fghi");
    expect(stream.read(2)?.toString()).toBe("fg");
    expect(stream.read(2)?.toString()).toBe("hi");
    expect(stream.byteLength).toBe(0);
    expect(stream.read(1)).toBeNull();
    stream.acceptChunk(Object.freeze(VSBuffer.fromString("next")));
    expect(stream.read(4)?.toString()).toBe("next");
    expect(stream.byteLength).toBe(0);
  });

  it("clears a cumulative ACK in one batch and replays only the remaining frames", () => {
    const first = socket();
    const protocol = new PersistentProtocol(first.value, {
      saturationHighWaterMarkBytes: 1000,
      saturationLowWaterMarkBytes: 300,
    });
    cleanups.push(() => protocol.dispose());
    const events: string[] = [];
    protocol.onSaturated(() => events.push(`saturated:${protocol.unacknowledgedBytes}`));
    protocol.onDrained(() => events.push(`drained:${protocol.unacknowledgedBytes}`));
    protocol.onMessage((data) => events.push(`message:${data.toString()}`));
    for (let i = 0; i < 2000; i += 1) protocol.send(VSBuffer.fromString("x"));
    const work = observeRemovals(() => {
      first.data.fire(frame(ProtocolMessageType.Ack, 0, 1600));
    });
    expect(protocol.unacknowledgedBytes).toBe(400);
    first.data.fire(frame(ProtocolMessageType.Ack, 0, 1600));
    first.data.fire(frame(ProtocolMessageType.Ack, 0, 100));
    expect(protocol.unacknowledgedBytes).toBe(400);
    const replacement = socket();
    protocol.replaceSocket(replacement.value);
    expect(replacement.writes.map((buffer) => buffer.readUInt32BE(1))).toEqual(
      Array.from({ length: 400 }, (_, i) => 1601 + i),
    );
    first.data.fire(frame(ProtocolMessageType.Ack, 0, 2000));
    expect(protocol.unacknowledgedBytes).toBe(400);
    replacement.data.fire(
      frame(ProtocolMessageType.Regular, 1, 1800, VSBuffer.fromString("reply")),
    );
    expect(protocol.unacknowledgedBytes).toBe(200);
    expect(events).toEqual(["saturated:1001", "drained:200", "message:reply"]);
    replacement.data.fire(frame(ProtocolMessageType.Ack, 0, 2000));
    replacement.data.fire(frame(ProtocolMessageType.Ack, 0, 2000));
    expect(protocol.unacknowledgedBytes).toBe(0);
    expect(events).toHaveLength(3);
    const empty = socket();
    protocol.replaceSocket(empty.value);
    expect(empty.writes).toHaveLength(0);
    expect(work.suffixReferences).toBeLessThanOrEqual(4000);
    expect(work.operations).toBeLessThanOrEqual(3);
  });

  it("exposes the cleaned queue when drained synchronously sends, reconnects and ACKs again", () => {
    const first = socket();
    const replacement = socket();
    const protocol = new PersistentProtocol(first.value, {
      saturationHighWaterMarkBytes: 2,
      saturationLowWaterMarkBytes: 1,
    });
    cleanups.push(() => protocol.dispose());
    const watermarks: number[] = [];
    protocol.onDrained(() => {
      watermarks.push(protocol.unacknowledgedBytes);
      protocol.send(VSBuffer.fromString("d"));
      protocol.replaceSocket(replacement.value);
      replacement.data.fire(frame(ProtocolMessageType.Ack, 0, 3));
      watermarks.push(protocol.unacknowledgedBytes);
    });
    for (const text of ["a", "b", "c"]) protocol.send(VSBuffer.fromString(text));
    first.data.fire(frame(ProtocolMessageType.Ack, 0, 2));
    expect(watermarks).toEqual([1, 1]);
    expect(replacement.writes.map((buffer) => buffer.readUInt32BE(1))).toEqual([3, 4]);
    expect(replacement.writes.map((buffer) => buffer.slice(13).toString())).toEqual(["c", "d"]);
    replacement.data.fire(frame(ProtocolMessageType.Ack, 0, 4));
    expect(protocol.unacknowledgedBytes).toBe(0);
    expect(watermarks).toEqual([1, 1]);
  });

  it.each(["socket", "persistent"])(
    "%s protocol preserves messages across fragmented headers, empty payloads and adjacent frames",
    (kind) => {
      const source = socket();
      const protocol =
        kind === "socket" ? new SocketProtocol(source.value) : new PersistentProtocol(source.value);
      cleanups.push(() => protocol.dispose());
      const received: string[] = [];
      protocol.onMessage((data) => received.push(data.toString()));
      const frames = VSBuffer.concat([
        frame(ProtocolMessageType.Regular, 1, 0, VSBuffer.fromString("你好✅")),
        frame(ProtocolMessageType.Regular, 2),
        frame(ProtocolMessageType.KeepAlive),
        frame(ProtocolMessageType.Regular, 3, 0, VSBuffer.fromString("tail")),
      ]);
      for (let i = 0; i < 13 + VSBuffer.fromString("你好✅").byteLength - 1; i += 1) {
        source.data.fire(frames.slice(i, i + 1));
        expect(received).toEqual([]);
      }
      const split = 13 + VSBuffer.fromString("你好✅").byteLength - 1;
      source.data.fire(frames.slice(split, split + 1));
      expect(received).toEqual(["你好✅"]);
      source.data.fire(frames.slice(split + 1));
      expect(received).toEqual(["你好✅", "", "tail"]);
      protocol.dispose();
      source.data.fire(frame(ProtocolMessageType.Regular, 4, 0, VSBuffer.fromString("late")));
      expect(received).toEqual(["你好✅", "", "tail"]);
    },
  );
});
