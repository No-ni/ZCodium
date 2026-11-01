/**
 * RPC 反序列化 String/Object 零拷贝即时解码回归（纯内存 node:test，直接导入真实 TS 导出）。
 *
 * 规格依据 docs/specs/rpc-serialization-decode-views.md：
 * - String/Object 负载经 BufferReader.readString 零拷贝子视图即时 TextDecoder 解码，
 *   视图不跨方法边界；普通 IReader 回退 read().toString()，行为不变；
 * - 游标推进与 read() 的 slice 归一规则一致：subarray(pos, pos+bytes) 后以
 *   view.byteLength 推进，越界/零长/负 bytes 边界同 read()；
 * - Buffer/VSBuffer 输出保持拷贝隔离：修改返回值不得影响原消息；
 * - 非零 byteOffset 子视图解码正确；UTF-8 多字节与多个连续值 roundtrip 等价；
 * - VSBuffer.slice / BufferReader.read 公开语义不变；
 * - 具备 readString 能力的 reader 被优先探测（duck-typing，不依赖具体类型）。
 *
 * 不使用真实 socket、不引入 Vitest（与既有 RPC 生命周期用例互补）。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { VSBuffer } from "../src/buffer.js";
import { BufferReader, BufferWriter, deserialize, serialize } from "../src/serialization.js";
import type { IReader } from "../src/serialization.js";

/** 以 Uint8Array.prototype.slice/set 的字节计量观察拷贝工作量（同 byteQueues.test.ts 模式）。 */
function measureCopyWork(run: () => void): number {
  const originalSlice = Uint8Array.prototype.slice;
  const originalSet = Uint8Array.prototype.set;
  let copied = 0;
  Uint8Array.prototype.slice = function (this: Uint8Array, start?: number, end?: number) {
    const result = originalSlice.call(this, start, end);
    copied += result.byteLength;
    return result;
  };
  Uint8Array.prototype.set = function (
    this: Uint8Array,
    source: ArrayLike<number>,
    offset?: number,
  ) {
    copied += source.length ?? 0;
    return originalSet.call(this, source, offset);
  };
  try {
    run();
  } finally {
    Uint8Array.prototype.slice = originalSlice;
    Uint8Array.prototype.set = originalSet;
  }
  return copied;
}

function frame(values: unknown[]): VSBuffer {
  const writer = new BufferWriter();
  serialize(writer, [100, 1, "channel", "method"]);
  for (const value of values) serialize(writer, value);
  return writer.buffer;
}

test("String/Object payload decode within a zero-copy budget", (t) => {
  // 载荷用 ASCII 恰 1MiB 字节（UTF-8 多字节场景由 roundtrip 用例覆盖）；
  // copied 只统计 JS 层 Uint8Array slice/set 字节，不含 TextDecoder/JSON.parse 的必要分配。
  const oneMiB = 1024 * 1024;
  const text = "a".repeat(oneMiB);
  const object = { payload: "y".repeat(oneMiB) };
  for (const value of [text, object]) {
    // string 的 wire payload 即其 UTF-8 字节；object 的 wire payload 是 JSON 文本。
    const payloadBytes =
      typeof value === "string"
        ? new TextEncoder().encode(value).byteLength
        : new TextEncoder().encode(JSON.stringify(value)).byteLength;
    const message = frame([value]);
    let copied = 0;
    let decoded: unknown;
    const reader = new BufferReader(message);
    copied = measureCopyWork(() => {
      deserialize(reader);
      decoded = deserialize(reader);
    });
    // 计数块外校验解码内容：防止“丢了大 payload 仍满足预算”的假绿。
    assert.deepEqual(decoded, value);
    assert.ok(copied <= 64, "decode of " + typeof value + " copied " + copied + " bytes");
    t.diagnostic(
      typeof value +
        " payload " +
        payloadBytes +
        " bytes: frame " +
        message.byteLength +
        " bytes, JS slice/set copied " +
        copied +
        " bytes",
    );
  }
});

test("keeps Buffer and VSBuffer outputs isolated from the frame", () => {
  const payload = new Uint8Array(4096).map((_, index) => index % 251);
  const message = frame([payload, VSBuffer.wrap(payload)]);
  const snapshot = message.buffer.slice();
  const reader = new BufferReader(message);
  deserialize(reader);
  const asBuffer = deserialize(reader) as Uint8Array;
  const asVsBuffer = deserialize(reader) as VSBuffer;
  asBuffer.fill(0xff);
  asVsBuffer.buffer.fill(0xff);
  assert.deepEqual(Array.from(message.buffer), Array.from(snapshot));
});

test("advances the cursor with legacy slice normalization", () => {
  const message = VSBuffer.fromString("abcdef");
  const viaRead = new BufferReader(message);
  const viaString = new BufferReader(message);
  for (const size of [2, 0, 100, -1, 3]) {
    const expected = viaRead.read(size);
    assert.equal(viaString.readString(size), expected.toString());
  }
  const readPos = (viaRead as unknown as { pos: number }).pos;
  const stringPos = (viaString as unknown as { pos: number }).pos;
  assert.equal(stringPos, readPos);
});

test("normalizes negative bytes against the tail like read()", () => {
  // 负 bytes 由 slice/subarray 相对末端归一（end = pos + bytes 仍可为负 → 折到 length 末端），
  // 与 EOF 后的负值（空结果）是不同路径；readString 必须与 read() 逐字节一致。
  const message = VSBuffer.fromString("abcdefghij");
  const viaRead = new BufferReader(message);
  const viaString = new BufferReader(message);
  for (const size of [2, -5, 0, -1, 4]) {
    const expected = viaRead.read(size);
    assert.equal(viaString.readString(size), expected.toString());
  }
  const readPos = (viaRead as unknown as { pos: number }).pos;
  const stringPos = (viaString as unknown as { pos: number }).pos;
  assert.equal(stringPos, readPos);
});

test("keeps readString consistent after readByte hits EOF", () => {
  // readByte 越界返回 undefined 且不推进 pos（既有容错）；其后的 readString 不得倒退游标，
  // 越界截断与 read() 一致。
  const message = VSBuffer.fromString("abc");
  const viaRead = new BufferReader(message);
  const viaString = new BufferReader(message);
  assert.equal(viaString.readString(2), "ab");
  assert.equal(viaRead.read(2).toString(), "ab");
  assert.equal(viaString.readByte(), 99); // 'c'
  assert.equal(viaRead.readByte(), 99);
  assert.equal(viaString.readByte(), undefined); // EOF：不推进
  assert.equal(viaRead.readByte(), undefined);
  assert.equal(viaString.readString(5), ""); // 越界截断为空，游标不倒退
  assert.equal(viaRead.read(5).toString(), "");
  assert.equal(viaString.readString(0), "");
  assert.equal(viaRead.read(0).toString(), "");
  const readPos = (viaRead as unknown as { pos: number }).pos;
  const stringPos = (viaString as unknown as { pos: number }).pos;
  assert.equal(stringPos, readPos);
});

test("decodes views with a non-zero byteOffset", () => {
  const values = ["偏移中文", { nested: { s: "值" } }];
  const inner = frame(values);
  const padded = VSBuffer.alloc(inner.byteLength + 16);
  padded.set(inner, 7);
  const shifted = VSBuffer.wrap(padded.buffer.subarray(7, 7 + inner.byteLength));
  const reader = new BufferReader(shifted);
  deserialize(reader);
  assert.equal(deserialize(reader), values[0]);
  assert.deepEqual(deserialize(reader), values[1]);
});

test("roundtrips UTF-8 multibyte and consecutive values", () => {
  const values: unknown[] = [
    "ascii",
    "中文内容",
    "emoji 😀🚀",
    42,
    undefined,
    [1, "二", null],
    { k: "值", n: 3 },
    new Uint8Array([9, 8, 7]),
    VSBuffer.wrap(new Uint8Array([5, 6])),
  ];
  const message = frame(values);
  const reader = new BufferReader(message);
  deserialize(reader);
  const decoded: unknown[] = [];
  for (let index = 0; index < values.length; index += 1) decoded.push(deserialize(reader));
  const normalize = (value: unknown): unknown =>
    value instanceof Uint8Array ? ["u8", ...value] : value;
  assert.deepEqual(decoded.map(normalize), values.map(normalize));
});

test("falls back to read().toString() for a plain IReader", () => {
  const message = frame(["fallback"]);
  const inner = new BufferReader(message);
  let readCalls = 0;
  const plain: IReader = {
    read(bytes: number): VSBuffer {
      readCalls += 1;
      return inner.read(bytes);
    },
  };
  deserialize(plain);
  assert.equal(deserialize(plain), "fallback");
  assert.ok(readCalls >= 1, "plain IReader read fallback not used (readCalls=" + readCalls + ")");
});

test("prefers readString when the reader exposes it", () => {
  const message = frame(["capability"]);
  const inner = new BufferReader(message);
  let readStringCalls = 0;
  let readCalls = 0;
  const capable = {
    readString(bytes: number): string {
      readStringCalls += 1;
      return inner.readString(bytes);
    },
    read(bytes: number): VSBuffer {
      readCalls += 1;
      return inner.read(bytes);
    },
    readByte(): number {
      return inner.readByte();
    },
  };
  deserialize(capable);
  assert.equal(deserialize(capable), "capability");
  assert.ok(readStringCalls >= 1, "readString not preferred (calls=" + readStringCalls + ")");
  assert.equal(
    readCalls,
    0,
    "copying read path used alongside readString (calls=" + readCalls + ")",
  );
});

test("keeps VSBuffer.slice and BufferReader.read copy isolation unchanged", () => {
  const base = VSBuffer.fromString("abcdef");
  const sliced = base.slice(1, 4);
  sliced.writeUInt8(0, 0);
  assert.equal(base.toString(), "abcdef");
  const reader = new BufferReader(base);
  const read = reader.read(2);
  read.writeUInt8(0, 0);
  assert.equal(base.toString(), "abcdef");
});
