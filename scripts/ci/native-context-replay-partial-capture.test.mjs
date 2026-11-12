import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { assertProjectPath, projectRoot } from "./project-test-sandbox.mjs";

assert.equal(process.version, "v24.14.0");
const directory = await assertProjectPath(join(process.env.TEMP, "native-replay-partial-capture"));
await mkdir(directory, { recursive: true });
const source = join(projectRoot, "packages/desktop/test/e2e/helpers/upstream-replay-server.ts");
const compiled = await build({
  entryPoints: [source],
  bundle: true,
  write: false,
  metafile: true,
  platform: "node",
  format: "esm",
  logLevel: "silent",
  alias: {
    "@zcode/shared": join(projectRoot, "packages/shared/src/index.ts"),
    "@zcode/shared/native-context-compression": join(
      projectRoot,
      "packages/shared/src/native-context-compression/index.ts",
    ),
  },
});
assert.ok(
  Object.keys(compiled.metafile.inputs).some((input) =>
    input.endsWith("upstream-replay-server.ts"),
  ),
);
assert.equal(
  Object.keys(compiled.metafile.inputs).some((input) => /packages\/shared\/dist\//u.test(input)),
  false,
);
const target = await assertProjectPath(join(directory, "source.mjs"));
await writeFile(target, compiled.outputFiles[0].text);
const { handleE2EReplayRequest } = await import(pathToFileURL(target).href);

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

class MemoryResponse extends EventEmitter {
  headersSent = false;
  destroyed = false;
  writableEnded = false;
  written = [];
  constructor(failAt) {
    super();
    this.failAt = failAt;
  }
  writeHead(statusCode, statusMessage, headers) {
    this.headersSent = true;
    this.statusCode = statusCode;
    this.statusMessage = statusMessage;
    this.headers = headers;
    return this;
  }
  write(chunk, callback) {
    if (this.written.length === this.failAt) {
      queueMicrotask(() => callback(new Error("synthetic write rejection")));
      return false;
    }
    this.written.push(Buffer.from(chunk));
    queueMicrotask(() => callback());
    return true;
  }
  end(chunk) {
    if (chunk) this.written.push(Buffer.from(chunk));
    this.writableEnded = true;
  }
  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
}

const frames = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4800}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"never-sent-suffix"}}}\n\n',
];

function fixture(options = {}) {
  const response = new MemoryResponse(options.failAt);
  const request = Object.assign(Readable.from([Buffer.from('{"messages":[],"stream":true}')]), {
    method: "POST",
    url: "/v1/messages",
    headers: { "content-type": "application/json" },
  });
  const reached = deferred();
  const gate = deferred();
  const artifacts = [];
  const records = [];
  const context = {
    baseUrl: "http://127.0.0.1:1",
    records,
    fixtureMatchCounts: new Map(),
    fixtures: [
      {
        id: "synthetic-partial-maintenance",
        metadata: { timingPolicy: "controlled-stream" },
        match: { method: "POST", pathIncludes: "/v1/messages" },
        response: {
          statusCode: 200,
          statusMessage: "OK",
          ...(options.kind === "body"
            ? { body: frames.join("") }
            : options.kind === "events"
              ? {
                  events: frames.map((text, sequence) => ({
                    text,
                    sequence,
                    byteLength: Buffer.byteLength(text),
                    offsetMs: 0,
                  })),
                }
              : { body: "unused-template", chunks: frames.map((text) => ({ text, offsetMs: 0 })) }),
          headers: { "content-type": "text/event-stream" },
          ...(options.hold ? { releaseAfterChunks: 2 } : {}),
          ...(options.destroy ? { closeMode: "destroy" } : {}),
        },
      },
    ],
    async writeArtifact() {
      artifacts.push(structuredClone(records));
      if (options.rejectFinalArtifact && records[0]?.status === "complete")
        throw new Error("synthetic artifact rejection");
    },
    holdStream() {
      response.once("close", () => gate.reject(new Error("synthetic client closed")));
      reached.resolve();
      return gate.promise;
    },
  };
  return {
    response,
    request,
    context,
    reached,
    artifacts,
    records,
    kind: options.kind ?? "chunks",
  };
}

function assertWrittenPrefix(f, count, status) {
  const row = f.artifacts.at(-1)[0];
  const body = Buffer.concat(f.response.written);
  assert.equal(f.response.statusCode, 200);
  assert.equal(row.statusCode, 200);
  assert.equal(row.status, status);
  assert.equal(row.responseHeaders["content-type"], "text/event-stream");
  assert.equal(row.responseBodyBytes, body.length);
  assert.equal(row.responseBodyBytes, Buffer.byteLength(frames.slice(0, count).join("")));
  if (f.kind === "chunks") {
    assert.equal(row.responseChunkTimeline.length, count);
    assert.deepEqual(
      row.responseChunkTimeline.map((chunk) => Buffer.from(chunk.base64, "base64").toString()),
      frames.slice(0, count),
    );
  } else if (f.kind === "events") {
    assert.equal(row.responseEvents.length, count);
    assert.deepEqual(
      row.responseEvents.map((event) => event.text),
      frames.slice(0, count),
    );
    assert.deepEqual(
      row.responseEvents.map((event) => event.sequence),
      Array.from({ length: count }, (_, index) => index),
    );
    assert.equal(row.responseChunkTimeline, undefined);
  } else {
    assert.equal(row.responseEvents, undefined);
    assert.equal(row.responseChunkTimeline, undefined);
  }
  assert.ok(Number.isFinite(Date.parse(row.completedAt)));
  assert.ok(row.durationMs >= 0);
  if (status === "error") assert.equal(typeof row.error, "string");
  if (count < frames.length)
    assert.equal(row.responseTextPreview.includes("never-sent-suffix"), false);
}

test("normally completed chunk response records the exact written body and HTTP 200", async () => {
  const f = fixture();
  await handleE2EReplayRequest(f.request, f.response, f.context);
  assertWrittenPrefix(f, 3, "complete");
  assert.equal(f.response.writableEnded, true);
});

test("maintenance cancelled at the real two-frame gate persists HTTP 200 and only the already written usage prefix", async () => {
  const f = fixture({ hold: true });
  const pending = handleE2EReplayRequest(f.request, f.response, f.context);
  await f.reached.promise;
  assert.equal(f.response.written.length, 2);
  assert.ok(Buffer.concat(f.response.written).toString().includes('"input_tokens":4800'));
  f.response.destroy();
  await assert.rejects(pending, /synthetic client closed/u);
  assertWrittenPrefix(f, 2, "error");
  assert.equal(f.response.writableEnded, false);
});

test("a rejected later write does not count unsent suffix bytes and still finalizes the same capture owner", async () => {
  const f = fixture({ failAt: 2 });
  await assert.rejects(
    handleE2EReplayRequest(f.request, f.response, f.context),
    /synthetic write rejection/u,
  );
  assertWrittenPrefix(f, 2, "error");
});

test("explicit fixture destruction remains an error after all actual written chunks", async () => {
  const f = fixture({ destroy: true });
  await handleE2EReplayRequest(f.request, f.response, f.context);
  assertWrittenPrefix(f, 3, "error");
  assert.equal(f.response.destroyed, true);
});

test("final artifact failure is propagated rather than silently marking the evidence channel successful", async () => {
  const f = fixture({ rejectFinalArtifact: true });
  await assert.rejects(
    handleE2EReplayRequest(f.request, f.response, f.context),
    /synthetic artifact rejection/u,
  );
  assert.equal(f.response.statusCode, 200);
  assert.equal(f.records[0].status, "complete");
});

for (const kind of ["body", "events"]) {
  test(`normal ${kind} EOF retains the full accepted body and genuine HTTP headers`, async () => {
    const f = fixture({ kind });
    await handleE2EReplayRequest(f.request, f.response, f.context);
    assertWrittenPrefix(f, 3, "complete");
    assert.equal(f.response.writableEnded, true);
    assert.equal(
      f.response.headers["content-length"],
      kind === "body" ? String(Buffer.byteLength(frames.join(""))) : undefined,
    );
  });

  test(`explicit ${kind} destruction preserves every accepted byte while remaining an error`, async () => {
    const f = fixture({ kind, destroy: true });
    await handleE2EReplayRequest(f.request, f.response, f.context);
    assertWrittenPrefix(f, 3, "error");
    assert.equal(f.response.destroyed, true);
    assert.equal(f.response.writableEnded, false);
    assert.equal(f.response.headers["content-length"], undefined);
  });
}

test("a failed ordinary body write preserves the genuine head without claiming any body bytes", async () => {
  const f = fixture({ kind: "body", failAt: 0 });
  await assert.rejects(
    handleE2EReplayRequest(f.request, f.response, f.context),
    /synthetic write rejection/u,
  );
  assertWrittenPrefix(f, 0, "error");
});

test("a failed events write captures the actual preceding events without changing their fault boundary", async () => {
  const f = fixture({ kind: "events", failAt: 2 });
  await assert.rejects(
    handleE2EReplayRequest(f.request, f.response, f.context),
    /synthetic write rejection/u,
  );
  assertWrittenPrefix(f, 2, "error");
});
