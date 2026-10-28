import assert from "node:assert/strict";
import test from "node:test";
import { buildToolExposure, resolveToolSearchMode } from "../src/tool/search/exposure.js";
import { collectDiscoveredTools, projectToolReferences } from "../src/tool/search/history.js";
import { resolveDeferredToolCall } from "../src/tool/deferred-call.js";
import { searchTools } from "../src/tool/search/search.js";
import { toolSearchToolEntry } from "../src/tool/handlers/tool-search.js";
import { deferredToolCallEntry } from "../src/tool/handlers/deferred-tool-call.js";
import { createToolRegistry } from "../src/tool/registry.js";
import {
  createMessageHistory,
  createRuntimeAssistantEntry,
  createRuntimeToolResultEntry,
} from "../src/agent/message-history.js";

const schema = {
  type: "object",
  additionalProperties: false,
  properties: { value: { $ref: "#/$defs/value" } },
  required: ["value"],
  $defs: { value: { oneOf: [{ type: "string", minLength: 1 }, { type: "integer" }] } },
};
const input = { value: "fixture" };
const model = (
  capability?: { protocolSupported: boolean; defaultEnabled: boolean },
  supports = true,
) =>
  ({
    properties: { supportsToolCall: supports },
    requestCapabilities: capability ? { toolSearch: capability } : undefined,
  }) as any;
function fixture() {
  const registry = createToolRegistry();
  registry.register(toolSearchToolEntry);
  registry.register(deferredToolCallEntry);
  registry.register({
    ...toolSearchToolEntry,
    inputSchema: schema,
    metadata: {
      ...toolSearchToolEntry.metadata,
      name: "mcp__fixture__lookup",
      alwaysLoad: false,
      description: "Fixture lookup",
      mcpPresentation: { serverName: "fixture", toolName: "lookup" },
    },
    aliases: ["Lookup"],
  });
  registry.register({
    ...toolSearchToolEntry,
    metadata: { ...toolSearchToolEntry.metadata, name: "Read", alwaysLoad: true },
  });
  return registry;
}
const searchEntries = () => [
  createRuntimeAssistantEntry("", [
    { id: "search", name: "ToolSearch", input: { query: "select:Lookup" } },
  ]),
  createRuntimeToolResultEntry(
    "search",
    "ToolSearch",
    [{ type: "tool_reference", toolName: "mcp__fixture__lookup" }] as any,
    false,
  ),
];

test("ToolSearch defaults off; Auto uses Local unless native default capability explicitly opts in", () => {
  assert.equal(resolveToolSearchMode(model()), "off");
  assert.equal(
    resolveToolSearchMode(model({ protocolSupported: true, defaultEnabled: false }), "auto"),
    "local",
  );
  assert.equal(
    resolveToolSearchMode(model({ protocolSupported: true, defaultEnabled: true }), "auto"),
    "native",
  );
  assert.equal(resolveToolSearchMode(model(undefined, false), "auto"), "off");
  assert.throws(() => resolveToolSearchMode(model(), "native"), /native|Anthropic/i);
  assert.throws(() => resolveToolSearchMode(model(undefined, false), "local"), /tool call/i);
});

test("Off hides control tools and strips references only from request copies", () => {
  const registry = fixture();
  const entries = searchEntries();
  const before = structuredClone(entries);
  const exposure = buildToolExposure({
    model: model(),
    tools: registry.toContracts(),
    registry,
    entries,
  });
  assert.deepEqual(
    exposure.tools.map((tool) => tool.name),
    ["mcp__fixture__lookup", "Read"],
  );
  assert.equal(exposure.enabled, false);
  assert.ok(!JSON.stringify(exposure.entries).includes("tool_reference"));
  assert.deepEqual(entries, before);
});

test("Local emits complete JSONSchema and a wrapper instruction, not deferred wire descriptors", () => {
  const registry = fixture();
  const entries = searchEntries();
  const before = structuredClone(entries);
  const exposure = buildToolExposure({
    model: model(),
    mode: "local",
    tools: registry.toContracts(),
    registry,
    entries,
  });
  assert.deepEqual(
    exposure.tools.map((tool) => tool.name),
    ["ToolSearch", "DeferredToolCall", "Read"],
  );
  const result = exposure.entries[1] as any;
  const text = result.message.content.map((block: any) => block.text ?? "").join("\n");
  const definition = JSON.parse(/<function>(.*)<\/function>/.exec(text)![1]!);
  assert.deepEqual(definition.parameters, schema);
  assert.match(text, /DeferredToolCall/);
  assert.deepEqual(entries, before);
  assert.ok(exposure.tools.every((tool) => !tool.deferLoading));
});

test("large Local schemas are never truncated and removed tools cannot be resurrected by history", () => {
  const registry = fixture();
  const entry = registry.get("mcp__fixture__lookup")!;
  const longSchema = { ...schema, description: "fixture".repeat(50_000) };
  registry.register({ ...entry, inputSchema: longSchema });
  const entries = searchEntries();
  const local = buildToolExposure({
    model: model(),
    mode: "local",
    tools: registry.toContracts(),
    registry,
    entries,
  });
  const text = (local.entries[1] as any).message.content
    .map((block: any) => block.text ?? "")
    .join("\n");
  assert.deepEqual(JSON.parse(/<function>(.*)<\/function>/.exec(text)![1]!).parameters, longSchema);
  registry.unregister("mcp__fixture__lookup");
  const removed = buildToolExposure({
    model: model(),
    mode: "local",
    tools: registry.toContracts(),
    registry,
    entries,
  });
  assert.ok(!JSON.stringify(removed.entries).includes('"type":"tool_reference"'));
  assert.ok(!JSON.stringify(removed.tools).includes("mcp__fixture__lookup"));
});

test("Native only exposes discovered targets with deferLoading and preserves current references", () => {
  const registry = fixture();
  const nativeModel = model({ protocolSupported: true, defaultEnabled: false });
  const initial = buildToolExposure({
    model: nativeModel,
    mode: "native",
    tools: registry.toContracts(),
    registry,
    entries: [],
  });
  assert.deepEqual(
    initial.tools.map((tool) => tool.name),
    ["ToolSearch", "Read"],
  );
  const exposure = buildToolExposure({
    model: nativeModel,
    mode: "native",
    tools: registry.toContracts(),
    registry,
    entries: searchEntries(),
  });
  assert.equal(
    exposure.tools.find((tool) => tool.name === "mcp__fixture__lookup")?.deferLoading,
    true,
  );
  assert.match(JSON.stringify(exposure.entries), /tool_reference/);
});

test("discovery only follows successful search facts and the kept compact/branch context", () => {
  const entries = searchEntries();
  assert.deepEqual([...collectDiscoveredTools(entries)], ["mcp__fixture__lookup"]);
  assert.equal(
    collectDiscoveredTools([
      { ...(entries[1] as any), message: { ...(entries[1] as any).message, isError: true } },
    ]).size,
    0,
  );
  assert.equal(
    collectDiscoveredTools([
      createRuntimeAssistantEntry("", [{ id: "direct", name: "mcp__fixture__lookup", input }]),
    ]).size,
    0,
  );
  assert.equal(collectDiscoveredTools(entries.slice(0, 1)).size, 0);
  const compact = [
    {
      message: { role: "user", content: "summary" },
      metadata: {
        source: "legacy_synthetic",
        compactBoundary: {
          boundaryId: "compact",
          preCompactDiscoveredTools: ["mcp__fixture__lookup"],
        },
      },
    },
  ] as any;
  assert.deepEqual([...collectDiscoveredTools(compact)], ["mcp__fixture__lookup"]);
  const registry = fixture();
  const exposure = buildToolExposure({
    model: model(),
    mode: "local",
    tools: registry.toContracts(),
    registry,
    entries: compact,
  });
  assert.ok(exposure.tools.some((tool) => tool.name === "mcp__fixture__lookup"));
});

test("parallel search results both carry complete schema; next-round repeated search has no duplicate schema", () => {
  const registry = fixture();
  const entries = searchEntries();
  entries.push(
    createRuntimeToolResultEntry(
      "sibling",
      "ToolSearch",
      [{ type: "tool_reference", toolName: "mcp__fixture__lookup" }] as any,
      false,
    ),
  );
  entries.push(createRuntimeAssistantEntry("next"));
  entries.push(
    createRuntimeToolResultEntry(
      "repeat",
      "ToolSearch",
      [{ type: "tool_reference", toolName: "mcp__fixture__lookup" }] as any,
      false,
    ),
  );
  const projection = projectToolReferences(
    entries,
    "local",
    registry.toContracts(),
    new Set(["mcp__fixture__lookup"]),
  );
  assert.match(JSON.stringify(projection.entries[1]), /<function>/);
  assert.match(JSON.stringify(projection.entries[2]), /<function>/);
  assert.ok(!JSON.stringify(projection.entries[4]).includes("<function>"));
});

test("wrapper resolves before scheduling without requiring a prior discovery grant", () => {
  const registry = fixture();
  const search = buildToolExposure({
    model: model(),
    mode: "local",
    tools: registry.toContracts(),
    registry,
    entries: [],
  }).context;
  const original = {
    id: "wrapper-call",
    name: "DeferredToolCall",
    input: { name: "mcp__fixture__lookup", input },
    providerOptions: { google: { thoughtSignature: "fixture-signature" } },
  };
  const resolved = resolveDeferredToolCall(original, search, registry);
  assert.equal(resolved.error, undefined);
  assert.deepEqual(resolved.call, {
    ...original,
    name: "mcp__fixture__lookup",
    input,
    modelCallWrapper: "DeferredToolCall",
  });
  assert.deepEqual(original.input, { name: "mcp__fixture__lookup", input });
  for (const name of ["ToolSearch", "DeferredToolCall", "Read", "missing"]) {
    assert.ok(
      resolveDeferredToolCall({ ...original, input: { name, input } }, search, registry).error,
    );
  }
  assert.ok(
    resolveDeferredToolCall(original, { ...search, mode: "off", enabled: false }, registry).error,
  );
});

test("canonical target/wrapper/per-call Gemini metadata survive Local and Off request projection", () => {
  const registry = fixture();
  const history = createMessageHistory();
  const calls = ["one", "two"].map((id) => ({
    id,
    name: "mcp__fixture__lookup",
    input,
    modelCallWrapper: "DeferredToolCall",
    providerOptions: { google: { thoughtSignature: `fixture-${id}` } },
  }));
  history.addAssistant("", calls as any);
  history.addToolResult("one", "mcp__fixture__lookup", "done", true);
  const canonical = history.toRuntimeEntries();
  const before = structuredClone(canonical);
  const local = buildToolExposure({
    model: model(),
    mode: "local",
    tools: registry.toContracts(),
    registry,
    entries: canonical,
  });
  const localCalls = (local.entries[0] as any).message.toolCalls;
  assert.equal(localCalls[0].name, "DeferredToolCall");
  assert.deepEqual(localCalls[0].input, { name: "mcp__fixture__lookup", input });
  assert.equal((local.entries[1] as any).message.toolName, "DeferredToolCall");
  assert.deepEqual(
    localCalls.map((call: any) => call.providerOptions),
    calls.map((call) => call.providerOptions),
  );
  const off = buildToolExposure({
    model: model(),
    mode: "off",
    tools: registry.toContracts(),
    registry,
    entries: canonical,
  });
  assert.equal((off.entries[0] as any).message.toolCalls[0].name, "mcp__fixture__lookup");
  assert.equal((off.entries[0] as any).message.toolCalls[0].modelCallWrapper, undefined);
  assert.deepEqual(canonical, before);
});

test("search stays in the current catalog, respects aliases, exact names, required terms and stable ranking", () => {
  const catalog = [
    {
      name: "mcp__fixture__lookup",
      aliases: ["Lookup"],
      deferred: true,
      description: "Find a record",
      mcp: { serverName: "fixture", toolName: "lookup" },
    },
    { name: "mcp__other__send", deferred: true, description: "Send a record" },
    { name: "Read", deferred: false },
  ];
  assert.deepEqual(searchTools("select:Lookup,Read,missing", catalog), [
    "mcp__fixture__lookup",
    "Read",
  ]);
  assert.deepEqual(searchTools("+fixture lookup", catalog), ["mcp__fixture__lookup"]);
  assert.deepEqual(searchTools("send", catalog), ["mcp__other__send"]);
  assert.deepEqual(searchTools("select:deleted", catalog), []);
});
