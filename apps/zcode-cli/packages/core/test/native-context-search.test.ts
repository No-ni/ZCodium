import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { FileSystemPort } from "@zcode/contracts";
import { fixture, message, commit } from "./native-context-boundary-fixture.js";
import { nativeOwner, writeNativeState } from "../src/runtime/native-context-compression/state.js";
import { NativeContextRuntimeError } from "../src/runtime/native-context-compression/contract.js";
import { searchNativeContext } from "../src/runtime/native-context-compression/search.js";

async function searchFixture(t: TestContext, texts: string[]) {
  const messages = texts.map((text, index) => {
    const source = message(`search-${index}`);
    const part = source.parts.find((item) => item.type === "text")!;
    if (part.type === "text") part.text = text;
    return source;
  });
  const result = await fixture(t, messages);
  result.state.policy.parameters.retrieval.planAware = false;
  await commit(result.host, result.state);
  nativeOwner(result.host).state = structuredClone(result.state);
  return result;
}
test("plan hints reorder query matches and never admit sources missing the query", async (t) => {
  const { host, state } = await searchFixture(t, [
    "keyword planfocus",
    "planfocus unrelated",
    "keyword ordinary",
  ]);
  const older = state.sources.find((source) => source.messageId.endsWith("search-0"))!.ref;
  const newest = state.sources.find((source) => source.messageId.endsWith("search-2"))!.ref;
  assert.deepEqual(
    (await searchNativeContext(host, { query: "KEYWORD" })).results.map((result) => result.ref),
    [newest, older],
  );
  const unused = async () => {
    throw new Error("Synthetic unused filesystem operation");
  };
  host.fileSystemPort = {
    readTextFile: async (request) => ({
      path: request.path,
      content: "planfocus",
      encoding: "utf8",
      bytesRead: 9,
      sizeBytes: 9,
      truncated: false,
    }),
    createDirectory: unused,
    stat: unused,
    readBinaryFile: unused,
    readTextFileRange: unused,
    writeTextFile: unused,
    removeFile: unused,
    listDirectory: unused,
    searchFiles: unused,
    searchText: unused,
  } satisfies FileSystemPort;
  await writeNativeState(nativeOwner(host), (next) => {
    next.policy.parameters.retrieval.planAware = true;
  });
  const result = await searchNativeContext(host, { query: "keyword" });
  assert.deepEqual(
    result.results.map((item) => item.ref),
    [older, newest],
  );
  assert.ok(result.results.every((item) => item.preview.includes("keyword")));
});
test("configured and per-query hit limits remain bounded and report truncation", async (t) => {
  const { host } = await searchFixture(t, ["needle first", "needle second", "needle third"]);
  await writeNativeState(nativeOwner(host), (next) => {
    next.policy.parameters.retrieval.maxHits = 2;
  });
  const result = await searchNativeContext(host, { query: "needle", maxHits: 100 });
  assert.equal(result.results.length, 2);
  assert.equal(result.searchedSources, 3);
  assert.equal(result.totalSources, 3);
  assert.equal(result.truncated, true);
  assert.equal(
    (await searchNativeContext(host, { query: "needle", maxHits: 1 })).results.length,
    1,
  );
});
test("the source scan is bounded and excludes old sources beyond its declared window", async (t) => {
  const { host } = await searchFixture(
    t,
    Array.from({ length: 1002 }, (_, index) => `needle bounded ${index}`),
  );
  const result = await searchNativeContext(host, { query: "needle" });
  assert.equal(result.searchedSources, 1000);
  assert.equal(result.totalSources, 1002);
  assert.equal(result.truncated, true);
});
test("cancellation during source IO rejects the whole result without issuing later reads", async (t) => {
  const { host, store } = await searchFixture(t, ["needle first", "needle second"]);
  const signal = new AbortController();
  const original = store.messageWithParts.bind(store);
  let reads = 0;
  store.messageWithParts = async (input) => {
    reads++;
    const result = await original(input);
    signal.abort(new Error("synthetic search cancelled"));
    return result;
  };
  await assert.rejects(
    searchNativeContext(host, { query: "needle" }, signal.signal),
    /synthetic search cancelled/u,
  );
  assert.equal(reads, 1);
});
test("a committed revision change during source IO rejects a mixed view", async (t) => {
  const { host, store } = await searchFixture(t, ["needle first", "needle second"]);
  const original = store.messageWithParts.bind(store);
  let reads = 0;
  store.messageWithParts = async (input) => {
    reads++;
    const result = await original(input);
    await writeNativeState(nativeOwner(host), () => {});
    return result;
  };
  await assert.rejects(
    searchNativeContext(host, { query: "needle" }),
    (error: unknown) => error instanceof NativeContextRuntimeError && error.code === "stale-view",
  );
  assert.equal(reads, 1);
});
