import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { Logger } from "@zcode/contracts";
import { zcodeProtocolMessageSchema, type ZCodeProtocolMessage } from "@zcode/shared";
import { ZCodeProtocolNdjsonConnection } from "../src/zcode-protocol/transport.js";

type Options = ConstructorParameters<typeof ZCodeProtocolNdjsonConnection>[0];
type Chunk = Buffer | string;

function fixture(overrides: Partial<Options> = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: ZCodeProtocolMessage[] = [];
  const writes: string[] = [];
  const warnings: string[] = [];
  const closed: Error[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn(message) {
      warnings.push(message);
    },
    error() {},
    child() {
      return logger;
    },
  };
  output.on("data", (chunk: Buffer) => writes.push(chunk.toString("utf8")));
  const connection = new ZCodeProtocolNdjsonConnection({
    input,
    output,
    logger,
    onTransportClosed: (error) => closed.push(error),
    async handleMessage(message) {
      messages.push(message);
      return "method" in message && "id" in message
        ? { id: message.id, result: { accepted: true } }
        : undefined;
    },
    ...overrides,
  });
  connection.start();
  return {
    input,
    output,
    messages,
    writes,
    warnings,
    closed,
    connection,
    feed(chunks: readonly Chunk[]) {
      for (const chunk of chunks) input.emit("data", chunk);
    },
    async end() {
      input.end();
      await connection.waitForClose();
    },
  };
}

// 固定修改前的追加/截行算法，保留每个 Buffer 单独解码及 EOF trim 的语义。
function legacyLines(chunks: readonly Chunk[]): string[] {
  const lines: string[] = [];
  let buffer = "";
  for (const chunk of chunks) {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) lines.push(line);
      newline = buffer.indexOf("\n");
    }
  }
  const trailing = buffer.trim();
  if (trailing.length > 0) lines.push(trailing);
  return lines;
}

function legacyDecode(chunks: readonly Chunk[]) {
  const messages: ZCodeProtocolMessage[] = [];
  const errors: Array<{ id: string; code: number }> = [];
  for (const line of legacyLines(chunks)) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      errors.push({ id: "parse-error", code: -32700 });
      continue;
    }
    const parsed = zcodeProtocolMessageSchema.safeParse(value);
    if (parsed.success) messages.push(parsed.data);
    else errors.push({ id: "invalid-message", code: -32600 });
  }
  return { messages, errors };
}

function splitText(value: string, widths: readonly number[]): string[] {
  const chunks: string[] = [];
  let start = 0;
  let index = 0;
  while (start < value.length) {
    const width = widths[index++ % widths.length]!;
    chunks.push(value.slice(start, start + width));
    start += width;
  }
  return chunks;
}

function newlineWork(run: () => void): { calls: number; searchedCodeUnits: number } {
  const original = String.prototype.indexOf;
  const work = { calls: 0, searchedCodeUnits: 0 };
  String.prototype.indexOf = function (this: string, search: string, position?: number): number {
    const result = original.call(this, search, position);
    if (search === "\n") {
      const start = Math.max(0, Math.min(this.length, position ?? 0));
      work.calls += 1;
      work.searchedCodeUnits += (result >= 0 ? result + 1 : this.length) - start;
    }
    return result;
  };
  try {
    run();
    return work;
  } finally {
    String.prototype.indexOf = original;
  }
}

for (const widths of [[1], [2, 5, 3], [32], [1024]]) {
  test(`NDJSON framing matches the original with string chunks ${widths.join(",")}`, async () => {
    const wire =
      "\uFEFF \r\n" +
      [
        JSON.stringify({ id: 1, method: "session/read", params: "中文🙂\\n" }),
        "  ",
        "{broken-json}",
        JSON.stringify({ id: 2, method: "session/read", unexpected: true }),
        JSON.stringify({ method: "fixture/notification", params: { zero: 0 } }),
        "\t" + JSON.stringify({ id: "tail", method: "session/read", params: [1, 2] }) + " \t",
      ].join("\r\n");
    const chunks = splitText(wire, widths);
    const expected = legacyDecode(chunks);
    const harness = fixture();
    harness.feed(chunks);
    await harness.end();
    assert.deepEqual(harness.messages, expected.messages);
    const errors = harness.writes.map((write) => JSON.parse(write)).filter((write) => write.error);
    assert.deepEqual(
      errors.map((write) => ({ id: write.id, code: write.error.code })),
      expected.errors,
    );
    assert.equal(harness.warnings.length, 1);
    assert.equal(harness.closed.length, 1);
  });
}

test("Buffer boundaries preserve the original per-chunk UTF-8 decoding", async () => {
  const bytes = Buffer.from(
    JSON.stringify({ id: 1, method: "session/read", params: "中文🙂" }) + "\n",
  );
  const chunks = Array.from(bytes, (_, index) => bytes.subarray(index, index + 1));
  const harness = fixture();
  harness.feed(chunks);
  await harness.end();
  assert.deepEqual(harness.messages, legacyDecode(chunks).messages);
});

test("a synchronous parse-warning callback can reenter with complete and partial lines", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: ZCodeProtocolMessage[] = [];
  let reentered = false;
  const logger: Logger = {
    debug() {},
    info() {},
    error() {},
    child() {
      return logger;
    },
    warn() {
      if (reentered) return;
      reentered = true;
      input.emit("data", 'read"}\n{"id":3,"method":"session/');
    },
  };
  const connection = new ZCodeProtocolNdjsonConnection({
    input,
    output,
    logger,
    async handleMessage(message) {
      messages.push(message);
      return undefined;
    },
  });
  connection.start();
  input.emit("data", 'bad\n{"id":1,"method":"session/read"}\n{"id":2,"method":"session/');
  input.emit("data", 'read"}\n');
  input.end();
  await connection.waitForClose();
  assert.deepEqual(
    messages.map((message) => ("id" in message ? message.id : null)),
    [1, 2, 3],
  );
});

test("fragmented ordinary admission, control bypass and reverse responses retain their order", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const control = Promise.withResolvers<void>();
  const reverse = Promise.withResolvers<void>();
  const order: string[] = [];
  const harness = fixture({
    async handleMessage(message) {
      if (!("method" in message)) {
        order.push("reverse-response");
        reverse.resolve();
        return undefined;
      }
      order.push(message.method);
      if (message.method === "session/create") {
        entered.resolve();
        await release.promise;
      }
      if (message.method === "session/stop") control.resolve();
      return "id" in message ? { id: message.id, result: {} } : undefined;
    },
  });
  try {
    harness.feed(splitText('{"id":1,"method":"session/create"}\n', [3, 7]));
    await entered.promise;
    harness.feed(splitText('{"id":2,"method":"session/stop"}\n', [2, 9]));
    await control.promise;
    harness.feed(
      splitText('{"id":3,"method":"session/read"}\n{"id":"reverse","result":{}}\n', [1, 5]),
    );
    await reverse.promise;
    assert.deepEqual(order, ["session/create", "session/stop", "reverse-response"]);
    release.resolve();
    await harness.end();
    assert.deepEqual(order, ["session/create", "session/stop", "reverse-response", "session/read"]);
  } finally {
    release.resolve();
    harness.input.end();
    await harness.connection.waitForClose();
  }
});

test("response, initial notification and commit retain one contiguous output order", async () => {
  const order: string[] = [];
  const harness = fixture({
    takePostResponseBatch(id) {
      return {
        messages: [{ method: "fixture/initial", params: id }],
        commit() {
          order.push("commit");
          return true;
        },
      };
    },
  });
  harness.output.on("data", (chunk: Buffer) => {
    const message = JSON.parse(chunk.toString("utf8"));
    order.push(message.method ?? `response:${message.id}`);
  });
  harness.feed(
    splitText('{"id":1,"method":"session/read"}\n{"id":2,"method":"session/read"}', [4, 11]),
  );
  await harness.end();
  assert.deepEqual(order, [
    "response:1",
    "fixture/initial",
    "commit",
    "response:2",
    "fixture/initial",
    "commit",
  ]);
});

test("abort ignores unfinished and late input without dispatching another request", async () => {
  const controller = new AbortController();
  let cleared = 0;
  const harness = fixture({
    signal: controller.signal,
    clearPostResponseMessages() {
      cleared += 1;
    },
  });
  harness.feed(['{"id":1,"method":"session/']);
  controller.abort();
  harness.feed(['read"}\n{"id":2,"method":"session/read"}\n']);
  await harness.connection.waitForClose();
  assert.deepEqual(harness.messages, []);
  assert.equal(harness.closed.length, 1);
  assert.equal(cleared, 1);
  harness.input.end();
});

test("fragmented long NDJSON lines do not search the already checked prefix", async (context) => {
  const text = JSON.stringify({ id: 1, method: "session/read", params: "x".repeat(256 * 1024) });
  const chunks = [...splitText(text, [1024]), "\n"];
  const original = newlineWork(() => legacyLines(chunks));
  const harness = fixture();
  const current = newlineWork(() => harness.feed(chunks));
  await harness.end();
  assert.equal(harness.messages.length, 1);
  assert.ok(original.searchedCodeUnits > text.length * 100);
  assert.ok(current.searchedCodeUnits <= text.length + 1, JSON.stringify({ original, current }));
  context.diagnostic(JSON.stringify({ codeUnits: text.length + 1, original, current }));
});

test("each partial line starts a new search scope after earlier complete lines", async () => {
  const lines = Array.from({ length: 4 }, (_, index) =>
    JSON.stringify({ id: index, method: "session/read", params: "y".repeat(32 * 1024) }),
  );
  const wire = lines.join("\n");
  const chunks = splitText(wire, [511, 1024, 7]);
  const harness = fixture();
  const work = newlineWork(() => harness.feed(chunks));
  await harness.end();
  assert.equal(harness.messages.length, lines.length);
  assert.ok(work.searchedCodeUnits <= wire.length, JSON.stringify(work));
});

function scanWithCursor(chunks: readonly string[]): number {
  let buffer = "";
  let searched = 0;
  let total = 0;
  for (const chunk of chunks) {
    buffer += chunk;
    let newline = buffer.indexOf("\n", searched);
    while (newline >= 0) {
      total += buffer.slice(0, newline).trim().length;
      buffer = buffer.slice(newline + 1);
      searched = 0;
      newline = buffer.indexOf("\n", searched);
    }
    searched = buffer.length;
  }
  return total + buffer.trim().length;
}

const benchmarkRequested = process.execArgv.some(
  (value) => value.includes("test-name-pattern") && value.includes("benchmark"),
);
test(
  "benchmark: long-line newline search before and after",
  { skip: !benchmarkRequested },
  (context) => {
    for (const count of [256, 1024]) {
      const chunks = [...Array.from({ length: count }, () => "x".repeat(1024)), "\n"];
      const old = () => legacyLines(chunks).reduce((total, line) => total + line.length, 0);
      const current = () => scanWithCursor(chunks);
      const oldTimes: number[] = [];
      const newTimes: number[] = [];
      for (let index = 0; index < 4; index++) {
        old();
        current();
      }
      for (let index = 0; index < 15; index++) {
        const pair =
          index % 2
            ? ([
                [current, newTimes],
                [old, oldTimes],
              ] as const)
            : ([
                [old, oldTimes],
                [current, newTimes],
              ] as const);
        for (const [run, samples] of pair) {
          const start = performance.now();
          assert.equal(run(), count * 1024);
          samples.push(performance.now() - start);
        }
      }
      const median = (values: number[]) =>
        values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)]!;
      context.diagnostic(
        JSON.stringify({ chunks: count, oldMs: median(oldTimes), newMs: median(newTimes) }),
      );
    }
  },
);
