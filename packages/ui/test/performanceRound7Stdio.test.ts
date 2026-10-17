import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { expect, it, vi } from "vitest";
import { zcodeProtocolMessageSchema, type ZCodeProtocolMessage } from "@zcode/shared";
import { ZCodeStdioTransport } from "../../services/src/zcode-agent/zcodeStdioTransport.js";
import type { ZCodeProtocolTransportClosedEvent } from "../../services/src/zcode-agent/zcodeProtocolTransport.js";

type Input = { kind: "data"; chunk: Buffer | string } | { kind: "end" | "close" | "exit" };
type Output =
  | { kind: "message"; message: ZCodeProtocolMessage }
  | { kind: "close"; event: ZCodeProtocolTransportClosedEvent };

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    exitCode: null as number | null,
    signalCode: null,
  });
  const transport = new ZCodeStdioTransport(child as unknown as ChildProcessWithoutNullStreams);
  const output: Output[] = [];
  transport.onMessage((message) => output.push({ kind: "message", message }));
  transport.onClose((event) => output.push({ kind: "close", event }));
  return {
    output,
    feed(input: Input) {
      if (input.kind === "data") child.stdout.emit("data", input.chunk);
      else if (input.kind === "exit") {
        child.exitCode = 0;
        child.emit("exit", 0, null);
      } else child.stdout.emit(input.kind);
    },
    dispose() {
      child.exitCode = 0;
      child.stderr.emit("close");
      transport.dispose();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    },
  };
}

function runTransport(inputs: Input[]): Output[] {
  const target = fixture();
  try {
    for (const input of inputs) target.feed(input);
    return target.output;
  } finally {
    target.dispose();
  }
}

// 保留修改前的完整 LF 缓冲算法作行为对照，避免用新偏移逻辑生成自己的期望。
function runReference(inputs: Input[]): Output[] {
  const decoder = new StringDecoder("utf8");
  const output: Output[] = [];
  let buffer = "";
  let closed = false;
  let flushed = false;
  let readersDisposed = false;
  const close = (event: ZCodeProtocolTransportClosedEvent) => {
    if (closed) return;
    closed = true;
    output.push({ kind: "close", event });
  };
  const frame = (value: string) => {
    const line = value.endsWith("\r") ? value.slice(0, -1) : value;
    if (line.trim().length === 0) return;
    try {
      output.push({ kind: "message", message: zcodeProtocolMessageSchema.parse(JSON.parse(line)) });
    } catch (error) {
      close({
        reason: `protocol_parse_error: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };
  for (const input of inputs) {
    if (input.kind === "exit") {
      close({ code: 0, signal: null });
      readersDisposed = true;
    } else if (readersDisposed) continue;
    else if (input.kind === "data") {
      if (closed) continue;
      buffer += typeof input.chunk === "string" ? input.chunk : decoder.write(input.chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const value = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        frame(value);
        if (closed) break;
        newline = buffer.indexOf("\n");
      }
    } else if (!flushed) {
      flushed = true;
      buffer += decoder.end();
      const trailing = buffer;
      buffer = "";
      if (trailing.length > 0 && !closed) frame(trailing);
      close({ reason: "stdout_closed" });
    }
  }
  return output;
}

function splitBytes(value: string, initialSeed: number): Input[] {
  const bytes = Buffer.from(value);
  const inputs: Input[] = [];
  let seed = initialSeed;
  let offset = 0;
  while (offset < bytes.length) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const end = Math.min(offset + 1 + (seed % 47), bytes.length);
    inputs.push({ kind: "data", chunk: bytes.subarray(offset, end) });
    offset = end;
  }
  return inputs;
}

it("scans each newly decoded character once while receiving a fragmented 2 MiB frame", () => {
  const target = fixture();
  const message = { id: "large-response", result: "x".repeat(2 * 1024 * 1024) };
  const wire = `${JSON.stringify(message)}\n`;
  const indexOf = String.prototype.indexOf;
  let scanned = 0;
  const spy = vi.spyOn(String.prototype, "indexOf").mockImplementation(function (
    this: string,
    needle: string,
    position?: number,
  ) {
    const result = indexOf.call(this, needle, position);
    if (needle === "\n") {
      const start = Math.min(this.length, Math.max(position ?? 0, 0));
      scanned += (result < 0 ? this.length : result + 1) - start;
    }
    return result;
  });
  try {
    for (let offset = 0; offset < wire.length; offset += 1024) {
      target.feed({ kind: "data", chunk: wire.slice(offset, offset + 1024) });
    }
  } finally {
    spy.mockRestore();
    target.dispose();
  }
  expect(target.output).toEqual([{ kind: "message", message }]);
  expect(scanned).toBe(wire.length);
});

it("matches the original parser across deterministic UTF-8 fragmentation and EOF boundaries", () => {
  const messages = Array.from({ length: 12 }, (_, index) => ({
    id: `response-${index}`,
    result: `汉字😀 U+2028:\u2028 U+2029:\u2029 escaped LF:\n index:${index}`,
  }));
  const wire = messages
    .map((message, index) => `${JSON.stringify(message)}${index % 2 ? "\r\n" : "\n"}`)
    .join(" \t\r\n");
  for (let seed = 1; seed <= 48; seed++) {
    const inputs: Input[] = [
      ...splitBytes(wire, seed),
      { kind: "end" },
      { kind: "close" },
      { kind: "exit" },
      { kind: "data", chunk: `${JSON.stringify({ id: "late", result: 0 })}\n` },
    ];
    const actual = runTransport(inputs);
    expect(actual).toEqual(runReference(inputs));
    expect(actual).toEqual([
      ...messages.map((message) => ({ kind: "message", message })),
      { kind: "close", event: { reason: "stdout_closed" } },
    ]);
  }
});

it("retains multiple same-chunk frames, split CRLF, empty chunks and a valid tail without LF", () => {
  const messages = [
    { id: 1, result: 1 },
    { id: 2, result: "😀" },
    { id: 3, result: 3 },
  ];
  const [first, second, third] = messages.map((message) => JSON.stringify(message));
  const inputs: Input[] = [
    { kind: "data", chunk: ` \r\n${first}\n${second}\r` },
    { kind: "data", chunk: "" },
    { kind: "data", chunk: `\n${third}` },
    { kind: "close" },
    { kind: "end" },
  ];
  expect(runTransport(inputs)).toEqual(runReference(inputs));
  expect(runTransport(inputs)).toEqual([
    ...messages.map((message) => ({ kind: "message", message })),
    { kind: "close", event: { reason: "stdout_closed" } },
  ]);
});

it("preserves parse failure order and suppresses the later frame in the same chunk", () => {
  for (const invalid of ["{invalid}", JSON.stringify({ unknown: true })]) {
    for (let seed = 1; seed <= 12; seed++) {
      const inputs: Input[] = [
        ...splitBytes(`${JSON.stringify({ id: "ok", result: 1 })}\n${invalid}\n`, seed),
        { kind: "data", chunk: `${JSON.stringify({ id: "late", result: 2 })}\n` },
        { kind: "end" },
        { kind: "close" },
        { kind: "exit" },
      ];
      const actual = runTransport(inputs);
      expect(actual).toEqual(runReference(inputs));
      expect(actual).toHaveLength(2);
      expect(actual[0]).toEqual({ kind: "message", message: { id: "ok", result: 1 } });
      expect(actual[1]).toMatchObject({
        kind: "close",
        event: { reason: expect.stringMatching(/^protocol_parse_error:/) },
      });
    }
    const sameChunk: Input[] = [
      { kind: "data", chunk: `${invalid}\n${JSON.stringify({ id: "late", result: 2 })}\n` },
      { kind: "end" },
    ];
    expect(runTransport(sameChunk)).toEqual(runReference(sameChunk));
    expect(runTransport(sameChunk)).toHaveLength(1);
  }
});

it("stops an incomplete frame on child exit and gives a later transport independent scan state", () => {
  const inputs: Input[] = [
    { kind: "data", chunk: '{"id":"incomplete"' },
    { kind: "exit" },
    { kind: "data", chunk: ',"result":1}\n' },
    { kind: "end" },
  ];
  expect(runTransport(inputs)).toEqual(runReference(inputs));
  expect(runTransport(inputs)).toEqual([{ kind: "close", event: { code: 0, signal: null } }]);
  const fresh: Input[] = [
    { kind: "data", chunk: '{"id":1,' },
    { kind: "data", chunk: '"result":2}\n' },
    { kind: "end" },
  ];
  expect(runTransport(fresh)).toEqual(runReference(fresh));
  expect(runTransport(fresh)[0]).toEqual({ kind: "message", message: { id: 1, result: 2 } });
});

it("retains decoder flush and malformed trailing frame behavior at EOF", () => {
  const valid = JSON.stringify({ id: "unicode", result: "😀汉字" });
  const byteInputs: Input[] = [...Buffer.from(valid)].map((byte) => ({
    kind: "data",
    chunk: Buffer.from([byte]),
  }));
  byteInputs.push({ kind: "end" });
  expect(runTransport(byteInputs)).toEqual(runReference(byteInputs));
  expect(runTransport(byteInputs)[0]).toEqual({
    kind: "message",
    message: { id: "unicode", result: "😀汉字" },
  });
  for (const tail of [Buffer.from('{"id":1,"result":'), Buffer.from([0xf0, 0x9f])]) {
    const inputs: Input[] = [{ kind: "data", chunk: tail }, { kind: "end" }, { kind: "close" }];
    expect(runTransport(inputs)).toEqual(runReference(inputs));
    expect(runTransport(inputs)).toHaveLength(1);
    expect(runTransport(inputs)[0]).toMatchObject({
      kind: "close",
      event: { reason: expect.stringMatching(/^protocol_parse_error:/) },
    });
  }
});
