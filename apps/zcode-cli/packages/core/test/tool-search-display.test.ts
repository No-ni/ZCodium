import assert from "node:assert/strict";
import test from "node:test";
import { parseToolResultDisplayPayload } from "@zcode/contracts";
import { createToolResultDisplay } from "../src/tool/executor/result-display.js";

const MAX_QUERY_BYTES = 4096;
const MAX_NAME_BYTES = 512;
const MAX_MATCHES = 100;

test("ToolSearch display is bounded independently of complete discovery results", () => {
  const query = "中文😀".repeat(5000);
  const matches = Array.from({ length: 150 }, (_, index) => `${index}-${"工具😀".repeat(200)}`);
  const output = { query, matches, total_deferred_tools: 150 };
  const before = structuredClone(output);
  const display = createToolResultDisplay("ToolSearch", output);
  assert.equal(display?.kind, "tool_search");
  if (display?.kind !== "tool_search") return;
  assert.equal(display.totalMatches, 150);
  assert.equal(display.totalDeferredTools, 150);
  assert.equal(display.truncated, true);
  assert.equal(display.matches.length, MAX_MATCHES);
  assert.ok(Buffer.byteLength(display.query, "utf8") <= MAX_QUERY_BYTES);
  assert.ok(display.matches.every((name) => Buffer.byteLength(name, "utf8") <= MAX_NAME_BYTES));
  assert.ok(display.matches.every((name, index) => name.startsWith(`${index}-`)));
  assert.deepEqual(parseToolResultDisplayPayload(display), display);
  assert.equal(parseToolResultDisplayPayload({ ...display, fullSchema: {} }), undefined);
  assert.deepEqual(output, before, "display truncation never changes canonical references");
});

test("ToolSearch zero matches stays a valid display and malformed output produces none", () => {
  assert.deepEqual(
    createToolResultDisplay("ToolSearch", {
      query: "absent",
      matches: [],
      total_deferred_tools: 2,
    }),
    { kind: "tool_search", query: "absent", matches: [], totalMatches: 0, totalDeferredTools: 2 },
  );
  for (const output of [null, {}, { query: "invalid", matches: [3], total_deferred_tools: 2 }]) {
    assert.equal(createToolResultDisplay("ToolSearch", output), undefined);
  }
});
