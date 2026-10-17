import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readModelTrajectory } from "../../services/src/zcode-agent/modelTrajectory.js";
import type { TrajectoryFileTail } from "../../services/src/zcode-agent/modelTrajectoryFileTail.js";

const observed = vi.hoisted(() => ({
  dirs: [] as string[],
  listed: [] as unknown[],
  read: [] as string[],
  tailOverride: undefined as undefined | ((path: string) => Promise<TrajectoryFileTail>),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readdir: (...args: Parameters<typeof original.readdir>) => {
      observed.listed.push(args[0]);
      return original.readdir(...args);
    },
  };
});
vi.mock("../../services/src/zcode-agent/modelTrajectoryFileTail.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../services/src/zcode-agent/modelTrajectoryFileTail.js")
    >();
  return {
    ...original,
    resolveModelIODirs: () => observed.dirs,
    readTrajectoryFileTail: (path: string) => {
      observed.read.push(path);
      return observed.tailOverride?.(path) ?? original.readTrajectoryFileTail(path);
    },
  };
});

const roots: string[] = [];
beforeEach(() => {
  observed.dirs = [];
  observed.listed = [];
  observed.read = [];
  observed.tailOverride = undefined;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createDirectories() {
  const root = await mkdtemp(join(tmpdir(), "zcodium-trajectory-performance-"));
  roots.push(root);
  const debug = join(root, "debug");
  const rollout = join(root, "rollout");
  await mkdir(debug);
  observed.dirs = [debug, rollout];
  return { debug, rollout };
}

function record(requestId: string, sessionId = "target", request?: Record<string, unknown>) {
  return {
    type: "model_io",
    sessionId,
    requestId,
    startedAt: "2026-01-01T00:00:00Z",
    request: request ?? { messages: [{ role: "user", content: requestId }] },
  };
}

async function writeRecords(dir: string, records: unknown[], filename = "model-io-target.jsonl") {
  const path = join(dir, filename);
  await writeFile(path, records.map((value) => JSON.stringify(value)).join("\n"));
  return path;
}

it("reads only the exact candidate among unrelated sessions and skips a missing directory", async () => {
  const { debug, rollout } = await createDirectories();
  await Promise.all(
    Array.from({ length: 1000 }, (_, index) =>
      writeFile(join(debug, `model-io-unrelated-${index}.jsonl`), ""),
    ),
  );
  const path = await writeRecords(debug, [record("r1")]);

  const result = await readModelTrajectory("target");

  expect(result.records.map((item) => item.requestId)).toEqual(["r1"]);
  expect(result.sourceFiles).toEqual([path]);
  expect(result.truncated).toBe(false);
  expect(observed.listed).toEqual([debug, rollout]);
  expect(observed.read).toEqual([path]);
});

it("does not read a filename that differs only in session-name casing", async () => {
  const { debug } = await createDirectories();
  await writeRecords(debug, [record("r1", "target")], "model-io-TARGET.jsonl");

  const result = await readModelTrajectory("target");

  expect(result.records).toEqual([]);
  expect(result.sourceFiles).toEqual([]);
  expect(observed.read).toEqual([]);
});

it("maps tool output only for the recent returned window after stable sorting", async () => {
  const { debug } = await createDirectories();
  const payloads = Array.from({ length: 250 }, (_, index) =>
    JSON.stringify({ retainedToolOutput: index }),
  );
  const rows = payloads.map((content, index) =>
    record(`r${index.toString().padStart(3, "0")}`, "target", {
      messages: [{ role: "tool", content, toolCallId: `call-${index}`, toolName: "read" }],
    }),
  );
  await writeRecords(debug, rows.reverse());
  const parse = vi.spyOn(JSON, "parse");

  const result = await readModelTrajectory("target", 3);
  const toolOutputParses = parse.mock.calls.filter(([text]) => payloads.includes(text));

  expect(result.records.map((item) => item.requestId)).toEqual(["r247", "r248", "r249"]);
  expect(result.records[2]?.request.messages[0]?.parts).toEqual([
    {
      kind: "tool-result",
      toolCallId: "call-249",
      toolName: "read",
      output: { retainedToolOutput: 249 },
    },
  ]);
  expect(result.truncated).toBe(true);
  expect(toolOutputParses).toHaveLength(3);
});

it("expands delta from excluded history and treats tail records as a fresh baseline", async () => {
  const { debug } = await createDirectories();
  await writeRecords(debug, [
    record("r1", "target", { messages: [{ role: "system", content: "baseline" }] }),
    record("r2", "target", {
      messagesKind: "delta",
      messageOffset: 1,
      messages: [{ role: "user", content: "delta" }],
    }),
  ]);
  const delta = await readModelTrajectory("target", 1);
  expect(delta.records.map((item) => item.requestId)).toEqual(["r2"]);
  expect(delta.records[0]?.request.messages.map((message) => message.parts)).toEqual([
    [{ kind: "text", text: "baseline" }],
    [{ kind: "text", text: "delta" }],
  ]);

  await writeRecords(debug, [
    record("r1", "target", { messages: [{ role: "system", content: "old history" }] }),
    record("r2", "target", {
      messagesKind: "tail",
      messages: [{ role: "system", content: "new baseline" }],
    }),
    record("r3", "target", {
      messagesKind: "delta",
      messageOffset: 1,
      messages: [{ role: "user", content: "latest delta" }],
    }),
  ]);
  const tail = await readModelTrajectory("target", 1);
  expect(tail.records[0]?.request.messages.map((message) => message.parts)).toEqual([
    [{ kind: "text", text: "new baseline" }],
    [{ kind: "text", text: "latest delta" }],
  ]);
});

it("preserves source order, exact session filtering after sanitization, and corrupt-line tolerance", async () => {
  const { debug, rollout } = await createDirectories();
  await mkdir(rollout);
  const sessionId = "../same session";
  const filename = "model-io-same-session.jsonl";
  const debugPath = await writeRecords(
    debug,
    [
      record("r3", "same-session"),
      record("r2", sessionId),
      { type: "other", sessionId, requestId: "ignored" },
    ],
    filename,
  );
  const rolloutPath = await writeRecords(rollout, [record("r1", sessionId)], filename);
  await writeFile(debugPath, "invalid json\n" + (await readFile(debugPath, "utf8")));

  const result = await readModelTrajectory(sessionId, 1);

  expect(result.records.map((item) => item.requestId)).toEqual(["r2"]);
  expect(result.sourceFiles).toEqual([debugPath, rolloutPath]);
  expect(result.truncated).toBe(true);
  expect(observed.read).toEqual([debugPath, rolloutPath]);
});

it("selects the latest by timestamp before requestId and falls back for invalid timestamps", async () => {
  const { debug } = await createDirectories();
  await writeRecords(debug, [
    { ...record("z"), startedAt: "2026-01-01T00:00:00Z" },
    { ...record("a"), startedAt: "2026-01-02T00:00:00Z" },
    { ...record("b"), startedAt: "invalid date" },
    { ...record("c"), startedAt: undefined },
  ]);
  expect((await readModelTrajectory("target", 1)).records.map((item) => item.requestId)).toEqual([
    "a",
  ]);
  expect((await readModelTrajectory("target", 10)).records.map((item) => item.requestId)).toEqual([
    "b",
    "c",
    "z",
    "a",
  ]);
});

it("omits missing, unreadable, empty and unmatched sources while reading later candidates", async () => {
  const { debug, rollout } = await createDirectories();
  await mkdir(rollout);
  const directoryInsteadOfFile = join(debug, "model-io-target.jsonl");
  await mkdir(directoryInsteadOfFile);
  const rolloutPath = await writeRecords(rollout, [record("r1")]);
  expect((await readModelTrajectory("target")).sourceFiles).toEqual([rolloutPath]);
  await writeRecords(rollout, []);
  expect((await readModelTrajectory("target")).sourceFiles).toEqual([]);
  await writeRecords(rollout, [record("other", "other-session")]);
  expect((await readModelTrajectory("target")).records).toEqual([]);
});

it("retains input truncation and current default/invalid limit semantics", async () => {
  const { debug, rollout } = await createDirectories();
  await mkdir(rollout);
  await writeRecords(debug, [record("r1")]);
  await writeRecords(rollout, [record("r2")]);
  observed.tailOverride = async (path) => {
    if (path.startsWith(debug)) throw Object.assign(new Error("unreadable"), { code: "EACCES" });
    return { text: JSON.stringify(record("r2")), bytesRead: 10, truncated: true };
  };
  const truncated = await readModelTrajectory("target", 10);
  expect(truncated.records.map((item) => item.requestId)).toEqual(["r2"]);
  expect(truncated.sourceFiles).toEqual([join(rollout, "model-io-target.jsonl")]);
  expect(truncated.truncated).toBe(true);

  observed.tailOverride = undefined;
  await writeRecords(
    debug,
    Array.from({ length: 205 }, (_, index) => record(`r${index.toString().padStart(3, "0")}`)),
  );
  await writeRecords(rollout, []);
  for (const limit of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = await readModelTrajectory("target", limit);
    expect(result.records).toHaveLength(200);
    expect(result.records[0]?.requestId).toBe("r005");
    expect(result.truncated).toBe(true);
  }
  expect((await readModelTrajectory("target", 2.9)).records).toHaveLength(2);
  expect((await readModelTrajectory("target", 0.5)).records).toHaveLength(0);
});
