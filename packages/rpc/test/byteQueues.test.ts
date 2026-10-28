import { afterEach, describe, expect, it } from "vitest";
import { VSBuffer } from "../src/buffer.js";
import { Emitter } from "../src/foundation.js";
import { FifoQueue } from "../src/fifoQueue.js";
import { PersistentProtocol } from "../src/persistent-protocol.js";
import {
  ChunkStream,
  ProtocolMessage,
  ProtocolMessageType,
  SocketProtocol,
  writeProtocolMessage,
  type ISocket,
} from "../src/protocol.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function socket() {
  const data = new Emitter<VSBuffer>();
  const close = new Emitter<void>();
  const writes: VSBuffer[] = [];
  const value: ISocket = {
    onData: data.event,
    onClose: close.event,
    onEnd: close.event,
    write: (buffer) => writes.push(buffer),
    end() {},
    async drain() {},
    dispose() {
      data.dispose();
      close.dispose();
    },
  };
  cleanups.push(() => value.dispose());
  return { data, close, writes, value };
}

function frame(type: ProtocolMessageType, id = 0, ack = 0, body = VSBuffer.alloc(0)) {
  return writeProtocolMessage(new ProtocolMessage(type, id, ack, body));
}

/** Logical suffix moves / compacted references, separately from copied payload bytes. */
function measureQueueWork(run: () => void) {
  const splice = Array.prototype.splice;
  const shift = Array.prototype.shift;
  const slice = Array.prototype.slice;
  const byteSlice = Uint8Array.prototype.slice;
  const byteSet = Uint8Array.prototype.set;
  const work = { references: 0, bytes: 0 };
  const isQueue = (items: unknown[]) =>
    items.some(
      (item) =>
        item instanceof VSBuffer ||
        (item as { msg?: unknown } | undefined)?.msg instanceof ProtocolMessage,
    );
  Array.prototype.splice = function (
    this: unknown[],
    ...args: [start: number, deleteCount?: number, ...items: unknown[]]
  ) {
    if (args[0] === 0 && isQueue(this)) {
      work.references += Math.max(0, this.length - (args[1] ?? this.length));
    }
    return Reflect.apply(splice, this, args);
  };
  Array.prototype.shift = function (this: unknown[]) {
    if (isQueue(this)) work.references += Math.max(0, this.length - 1);
    return shift.call(this);
  };
  Array.prototype.slice = function (this: unknown[], start?: number, end?: number) {
    const result = slice.call(this, start, end);
    if (isQueue(this)) work.references += result.length;
    return result;
  };
  Uint8Array.prototype.slice = function (this: Uint8Array, start?: number, end?: number) {
    const result = byteSlice.call(this, start, end);
    work.bytes += result.byteLength;
    return result;
  };
  Uint8Array.prototype.set = function (
    this: Uint8Array,
    source: ArrayLike<number>,
    offset?: number,
  ) {
    work.bytes += source.length;
    byteSet.call(this, source, offset);
  };
  try {
    run();
  } finally {
    Array.prototype.splice = splice;
    Array.prototype.shift = shift;
    Array.prototype.slice = slice;
    Uint8Array.prototype.slice = byteSlice;
    Uint8Array.prototype.set = byteSet;
  }
  return work;
}

function retainedBuffers(value: unknown, seen = new Set<unknown>()): VSBuffer[] {
  if (value instanceof VSBuffer) return [value];
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  return Object.values(value).flatMap((child) => retainedBuffers(child, seen));
}

describe("single internal FIFO", () => {
  it("matches a plain queue through compaction, mixed operations and clear", () => {
    const queue = new FifoQueue<VSBuffer>();
    const expected: VSBuffer[] = [];
    const values = Array.from({ length: 5000 }, (_, index) => VSBuffer.fromString(String(index)));
    for (const value of values) {
      queue.push(value);
      expected.push(value);
    }
    for (let index = 0; index < 4500; index += 1) {
      expect(queue.shift()).toBe(expected.shift());
      if (index % 3 === 0) {
        queue.push(values[index]!);
        expected.push(values[index]!);
      }
      expect(queue.length).toBe(expected.length);
      expect(queue.peek()).toBe(expected[0]);
      expect(queue.at(-1)).toBeUndefined();
      expect(queue.at(queue.length)).toBeUndefined();
    }
    expect(queue.toArray()).toEqual(expected);
    queue.clear();
    expect(queue.length).toBe(0);
    expect(queue.peek()).toBeUndefined();
    expect(queue.shift()).toBeUndefined();
    expect(retainedBuffers(queue)).toEqual([]);
    queue.push(values[0]!);
    expect(queue.shift()).toBe(values[0]);
    expect(queue.toArray()).toEqual([]);
  });

  it("releases each consumed reference immediately and bounds backing storage and compaction", () => {
    const queue = new FifoQueue<VSBuffer>();
    const values = Array.from({ length: 4096 }, (_, index) => VSBuffer.fromString(String(index)));
    for (const value of values) queue.push(value);
    const work = measureQueueWork(() => {
      for (let index = 0; index < values.length; index += 1) {
        expect(queue.shift()).toBe(values[index]);
        const internal = queue as unknown as { entries: Array<VSBuffer | undefined> };
        expect(internal.entries.includes(values[index])).toBe(false);
        expect(internal.entries.length).toBeLessThanOrEqual(queue.length * 2 + 1024);
      }
    });
    expect(work.references).toBeLessThanOrEqual(values.length * 2);
    expect(retainedBuffers(queue)).toEqual([]);
  });
});

describe("byte queue complexity across calls", () => {
  it("keeps repeated one-block reads linear instead of moving the suffix on every call", () => {
    for (const count of [256, 512, 1024, 4096]) {
      const stream = new ChunkStream();
      for (let index = 0; index < count; index += 1) {
        stream.acceptChunk(VSBuffer.wrap(Uint8Array.of(index % 251)));
      }
      const output: number[] = [];
      const work = measureQueueWork(() => {
        for (let index = 0; index < count; index += 1) output.push(stream.read(1)!.readUInt8(0));
      });
      expect(output).toEqual(Array.from({ length: count }, (_, index) => index % 251));
      expect(work.references, `N=${count}`).toBeLessThanOrEqual(count * 6);
      expect(work.bytes).toBeLessThanOrEqual(count);
      expect(stream.byteLength).toBe(0);
    }
  });

  it("keeps a sequence of individual ACKs linear and clears the correct outstanding prefix", () => {
    for (const count of [256, 512, 1024, 4096]) {
      const source = socket();
      const protocol = new PersistentProtocol(source.value);
      cleanups.push(() => protocol.dispose());
      for (let index = 0; index < count; index += 1) protocol.send(VSBuffer.alloc(1));
      const acknowledgements = Array.from({ length: count }, (_, index) =>
        frame(ProtocolMessageType.Ack, 0, index + 1),
      );
      const work = measureQueueWork(() => {
        for (const ack of acknowledgements) source.data.fire(ack);
      });
      expect(work.references, `N=${count}`).toBeLessThanOrEqual(count * 6);
      expect(protocol.unacknowledgedBytes).toBe(0);
    }
  });

  it.each(["frames", "bytes", "coalesced", "fragmented-body"])(
    "SocketProtocol production onData parsing has bounded copy and reference work: %s",
    (mode) => {
      const source = socket();
      const protocol = new SocketProtocol(source.value);
      cleanups.push(() => protocol.dispose());
      const payloads =
        mode === "fragmented-body"
          ? [VSBuffer.alloc(4096)]
          : Array.from({ length: 256 }, (_, i) => VSBuffer.fromString(String(i)));
      const frames = payloads.map((body, index) =>
        frame(ProtocolMessageType.Regular, index + 1, 0, body),
      );
      const combined = VSBuffer.concat(frames);
      const received: VSBuffer[] = [];
      protocol.onMessage((body) => received.push(body));
      const chunks =
        mode === "coalesced"
          ? [combined]
          : mode === "frames"
            ? frames
            : Array.from(combined.buffer, (byte) => VSBuffer.wrap(Uint8Array.of(byte)));
      const work = measureQueueWork(() => {
        for (const chunk of chunks) source.data.fire(chunk);
      });
      expect(received.map((buffer) => buffer.toString())).toEqual(
        payloads.map((buffer) => buffer.toString()),
      );
      expect(work.references).toBeLessThanOrEqual(chunks.length * 8 + frames.length * 8);
      expect(work.bytes).toBeLessThanOrEqual(combined.byteLength * 20);
    },
  );
});

describe("deferred SocketProtocol activation", () => {
  it("keeps complete and partial frames in the existing stream until one activation", () => {
    const source = socket();
    const protocol = new SocketProtocol(source.value, { deferMessages: true });
    cleanups.push(() => protocol.dispose());
    const first = frame(ProtocolMessageType.Regular, 0, 0, VSBuffer.fromString("first"));
    const second = frame(ProtocolMessageType.Regular, 0, 0, VSBuffer.fromString("second"));
    source.data.fire(VSBuffer.concat([first, second.slice(0, 15)]));
    const received: string[] = [];
    protocol.onMessage((body) => received.push(body.toString()));
    expect(received).toEqual([]);
    protocol.activate();
    protocol.activate();
    expect(received).toEqual(["first"]);
    source.data.fire(second.slice(15));
    expect(received).toEqual(["first", "second"]);
    expect((protocol as unknown as { chunkStream: ChunkStream }).chunkStream.byteLength).toBe(0);
  });

  it("clears deferred bytes on dispose and cannot reactivate or accept late data", () => {
    const source = socket();
    const protocol = new SocketProtocol(source.value, { deferMessages: true });
    const received: string[] = [];
    protocol.onMessage((body) => received.push(body.toString()));
    const input = frame(ProtocolMessageType.Regular, 0, 0, VSBuffer.fromString("late"));
    source.data.fire(input);
    const stream = (protocol as unknown as { chunkStream: ChunkStream }).chunkStream;
    expect(stream.byteLength).toBe(input.byteLength);
    protocol.dispose();
    protocol.activate();
    source.data.fire(input);
    expect(received).toEqual([]);
    expect(stream.byteLength).toBe(0);
    expect(retainedBuffers(stream)).toEqual([]);
  });

  it("continues immediate delivery without the opt-in activation boundary", () => {
    const source = socket();
    const protocol = new SocketProtocol(source.value);
    cleanups.push(() => protocol.dispose());
    const received: string[] = [];
    protocol.onMessage((body) => received.push(body.toString()));
    source.data.fire(frame(ProtocolMessageType.Regular, 0, 0, VSBuffer.fromString("default")));
    expect(received).toEqual(["default"]);
    protocol.activate();
    expect(received).toEqual(["default"]);
  });
});

describe("protocol queue ownership on disposal", () => {
  it("clears a partially consumed stream and permits reuse without the old byte offset", () => {
    const stream = new ChunkStream();
    stream.acceptChunk(VSBuffer.fromString("old bytes"));
    expect(stream.read(4)!.toString()).toBe("old ");
    stream.clear();
    expect(stream.byteLength).toBe(0);
    expect(retainedBuffers(stream)).toEqual([]);
    const next = VSBuffer.fromString("next");
    stream.acceptChunk(next);
    expect(stream.read(4)).toBe(next);
    expect(stream.byteLength).toBe(0);
  });
  it.each(["socket", "persistent"])(
    "%s clears incomplete input and prevents new writes after dispose",
    (kind) => {
      const source = socket();
      const protocol =
        kind === "socket" ? new SocketProtocol(source.value) : new PersistentProtocol(source.value);
      cleanups.push(() => protocol.dispose());
      const incomplete = frame(ProtocolMessageType.Regular, 1, 0, VSBuffer.alloc(2 * 1024 * 1024));
      source.data.fire(incomplete.slice(0, 1024 * 1024));
      const internal = protocol as unknown as {
        chunkStream: ChunkStream;
        outgoingUnackMsg?: unknown;
      };
      expect(internal.chunkStream.byteLength).toBe(1024 * 1024);
      protocol.send(VSBuffer.alloc(1024));
      protocol.dispose();
      expect(internal.chunkStream.byteLength).toBe(0);
      expect(retainedBuffers(internal.chunkStream)).toEqual([]);
      expect(retainedBuffers(internal.outgoingUnackMsg)).toEqual([]);
      if (protocol instanceof PersistentProtocol) expect(protocol.unacknowledgedBytes).toBe(0);
      const writes = source.writes.length;
      protocol.send(VSBuffer.fromString("late"));
      source.data.fire(incomplete);
      expect(source.writes).toHaveLength(writes);
      expect(internal.chunkStream.byteLength).toBe(0);
      protocol.dispose();
    },
  );

  it.each(["socket", "persistent"])(
    "%s stops same-batch delivery when a listener disposes synchronously",
    (kind) => {
      const source = socket();
      const protocol =
        kind === "socket" ? new SocketProtocol(source.value) : new PersistentProtocol(source.value);
      cleanups.push(() => protocol.dispose());
      const received: string[] = [];
      protocol.onMessage((body) => {
        received.push(body.toString());
        protocol.dispose();
        protocol.send(VSBuffer.fromString("late"));
      });
      source.data.fire(
        VSBuffer.concat([
          frame(ProtocolMessageType.Regular, 1, 0, VSBuffer.fromString("first")),
          frame(ProtocolMessageType.Regular, 2, 0, VSBuffer.fromString("second")),
        ]),
      );
      expect(received).toEqual(["first"]);
      expect(source.writes).toEqual([]);
      expect(
        retainedBuffers((protocol as unknown as { chunkStream: unknown }).chunkStream),
      ).toEqual([]);
    },
  );

  it("does not skip unacknowledged frames when replay writes synchronously ACK and compact", () => {
    const source = socket();
    const protocol = new PersistentProtocol(source.value);
    cleanups.push(() => protocol.dispose());
    for (let index = 0; index < 4096; index += 1) protocol.send(VSBuffer.alloc(1));
    const replacement = socket();
    const replayed: number[] = [];
    replacement.value.write = (buffer) => {
      const id = buffer.readUInt32BE(1);
      replayed.push(id);
      replacement.data.fire(frame(ProtocolMessageType.Ack, 0, id));
    };
    protocol.replaceSocket(replacement.value);
    expect(replayed).toEqual(Array.from({ length: 4096 }, (_, index) => index + 1));
    expect(protocol.unacknowledgedBytes).toBe(0);
  });

  it("stops replay immediately when socket write synchronously disposes", () => {
    const source = socket();
    const protocol = new PersistentProtocol(source.value);
    cleanups.push(() => protocol.dispose());
    protocol.send(VSBuffer.fromString("a"));
    protocol.send(VSBuffer.fromString("b"));
    const replacement = socket();
    let writes = 0;
    replacement.value.write = () => {
      writes += 1;
      protocol.dispose();
    };
    protocol.replaceSocket(replacement.value);
    expect(writes).toBe(1);
    expect(protocol.unacknowledgedBytes).toBe(0);
    expect(
      retainedBuffers((protocol as unknown as { outgoingUnackMsg: unknown }).outgoingUnackMsg),
    ).toEqual([]);
  });
});
