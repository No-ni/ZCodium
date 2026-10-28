import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { createToolExecutor } from "../src/tool/executor.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import { toolSearchToolEntry } from "../src/tool/handlers/tool-search.js";
import { deferredToolCallEntry } from "../src/tool/handlers/deferred-tool-call.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import {
  serializeOutput,
  appendHookAdditionalContexts,
} from "../src/tool/executor/result-serialization.js";

const target = "FixtureWrite";
function fixture(deny = false) {
  const registry = createToolRegistry();
  const events: any[] = [];
  const seen: any[] = [];
  const hooks: any[] = [];
  registry.register(toolSearchToolEntry);
  registry.register(deferredToolCallEntry);
  registry.register({
    ...toolSearchToolEntry,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    runtimeInputSchema: undefined,
    outputSchema: {},
    runtimeOutputSchema: undefined,
    metadata: {
      ...toolSearchToolEntry.metadata,
      name: target,
      shouldDefer: true,
      readOnly: false,
      needsApproval: true,
      concurrentSafe: false,
      sideEffectScope: "workspace",
    },
    permission: {
      ...toolSearchToolEntry.permission,
      permission: "fixture.write",
      needsApproval: true,
      sideEffectScope: "workspace",
    },
    formatModelContent: undefined,
    handler: async (input, context) => {
      seen.push({ input, callId: context.toolCallId });
      return { written: true };
    },
  } as any);
  const executor = createToolExecutor({
    registry,
    emitEvent: async (event) => {
      events.push(event);
    },
    sessionId: "fixture-session" as any,
    permissionService: new PermissionService({
      ...defaultPermissionConfig,
      allowedTools: new Set(deny ? [] : [target]),
      disallowedTools: new Set(deny ? [target] : []),
    }),
    hookRunner: {
      run: async (event: any, context: any) => {
        hooks.push({ event, context });
        return {
          additionalContexts: [],
          permissionBehavior: "default",
          preventContinuation: false,
        };
      },
    } as any,
  });
  const search = {
    mode: "local",
    enabled: true,
    discovered: new Set<string>(),
    catalog: [
      { name: "ToolSearch", deferred: false },
      { name: "DeferredToolCall", deferred: false },
      { name: target, deferred: true },
    ],
  } as any;
  return { registry, executor, events, seen, hooks, search };
}

test("default built-in registration has no ToolSearch controls; explicit experiment enables both", () => {
  const registry = createToolRegistry();
  registerBuiltInTools(registry);
  assert.equal(registry.has("ToolSearch"), false);
  assert.equal(registry.has("DeferredToolCall"), false);
  const enabled = createToolRegistry();
  registerBuiltInTools(enabled, { includeToolSearch: true } as any);
  assert.equal(enabled.has("ToolSearch"), true);
  assert.equal(enabled.has("DeferredToolCall"), true);
});

test("ToolSearch produces discovery references without target execution or permission changes", async () => {
  const { executor, seen, search } = fixture();
  const result = await executor.execute(
    { id: "search", name: "ToolSearch", input: { query: `select:${target}` } },
    { toolSearch: search } as any,
  );
  assert.equal(result.success, true);
  assert.deepEqual(result.modelContent, [{ type: "tool_reference", toolName: target }]);
  assert.equal(seen.length, 0);
  assert.equal(search.discovered.size, 0);
  assert.deepEqual(result.display, {
    kind: "tool_search",
    query: `select:${target}`,
    matches: [target],
    totalMatches: 1,
    totalDeferredTools: 1,
  });
  const direct = await executor.execute(
    { id: "direct", name: target, input: { value: "direct" } },
    { toolSearch: search } as any,
  );
  assert.equal(direct.success, true);
  assert.equal(seen.length, 1);
});

test("DeferredToolCall uses the same executor target/schema/hooks/callId", async () => {
  const { executor, seen, events, hooks, search } = fixture();
  const result = await executor.execute(
    {
      id: "wrapper",
      name: "DeferredToolCall",
      input: { name: target, input: { value: "wrapped" } },
    },
    { toolSearch: search } as any,
  );
  assert.equal(result.success, true);
  assert.equal(result.toolName, target);
  assert.equal(result.toolCallId, "wrapper");
  assert.deepEqual(seen, [{ input: { value: "wrapped" }, callId: "wrapper" }]);
  assert.ok(events.some((event) => event.payload?.toolName === target));
  assert.ok(!events.some((event) => event.payload?.toolName === "DeferredToolCall"));
  assert.deepEqual(
    hooks.map(({ event, context }) => ({
      event: event.hookEventName,
      name: event.toolName,
      input: event.toolInput,
      callId: event.toolCallId,
      matcher: context.matchValue,
    })),
    [
      {
        event: "PreToolUse",
        name: target,
        input: { value: "wrapped" },
        callId: "wrapper",
        matcher: target,
      },
      {
        event: "PostToolUse",
        name: target,
        input: { value: "wrapped" },
        callId: "wrapper",
        matcher: target,
      },
    ],
  );
});

test("discovery does not bypass deny or add an undiscovered-call authorization gate", async () => {
  const { executor, search, seen } = fixture(true);
  const direct = await executor.execute(
    { id: "direct-denied", name: target, input: { value: "valid" } },
    { toolSearch: search } as any,
  );
  const wrapped = await executor.execute(
    {
      id: "wrapped-denied",
      name: "DeferredToolCall",
      input: { name: target, input: { value: "valid" } },
    },
    { toolSearch: search } as any,
  );
  assert.equal(direct.success, false);
  assert.equal(wrapped.success, false);
  assert.match(wrapped.error!.message, /denied|disallowed|blocked/i);
  assert.equal(seen.length, 0);
});

test("invalid/unavailable wrapper and cancellation never enter target execution", async () => {
  const { executor, search, seen, hooks } = fixture();
  for (const call of [
    { id: "invalid", name: "DeferredToolCall", input: { name: target, input: {} } },
    { id: "excluded", name: "DeferredToolCall", input: { name: "Excluded", input: {} } },
    { id: "recursive", name: "DeferredToolCall", input: { name: "ToolSearch", input: {} } },
  ]) {
    const result = await executor.execute(call, { toolSearch: search } as any);
    assert.equal(result.success, false);
  }
  assert.equal(hooks.length, 0, "invalid targets fail before hooks or permission");
  const cancelled = await executor.execute(
    { id: "cancelled", name: "ToolSearch", input: { query: `select:${target}` } },
    { toolSearch: search, signal: AbortSignal.abort() } as any,
  );
  assert.equal(cancelled.success, false);
  assert.ok(!JSON.stringify(cancelled).includes("tool_reference"));
  const off = await executor.execute({ id: "off", name: "ToolSearch", input: { query: "lookup" } });
  assert.equal(off.success, false);
  assert.equal(seen.length, 0);
});

test("target defaults, resolveInput, hook rewrite and permission payload share one real input/callId", async () => {
  const { registry, search } = fixture();
  const observations: any[] = [];
  const requests: any[] = [];
  const entry = registry.get(target)!;
  registry.register({
    ...entry,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { value: { type: "string", default: "default-value" } },
    },
    runtimeInputSchema: z.object({ value: z.string().default("default-value") }).strict(),
    resolveInput: (input: any) => {
      observations.push({ stage: "resolve", input });
      return { result: true, input: { value: `${input.value}-resolved` } };
    },
    handler: async (input, context) => {
      observations.push({ stage: "handler", input, callId: context.toolCallId });
      return {};
    },
  });
  const executor = createToolExecutor({
    registry,
    sessionId: "fixture-session" as any,
    emitEvent: async () => {},
    permissionService: new PermissionService(defaultPermissionConfig),
    permissionBroker: {
      requestPermission: async (request: any) => {
        requests.push(request);
        return { decision: "allow" };
      },
    } as any,
    hookRunner: {
      run: async (event: any) => {
        if (event.hookEventName === "PreToolUse") {
          observations.push({
            stage: "hook",
            name: event.toolName,
            input: event.toolInput,
            callId: event.toolCallId,
          });
          return { additionalContexts: [], updatedInput: { value: "hook-value" } };
        }
        return { additionalContexts: [] };
      },
    } as any,
  });
  const result = await executor.execute(
    { id: "single-call", name: "DeferredToolCall", input: { name: target, input: {} } },
    { toolSearch: search },
  );
  assert.equal(result.success, true, JSON.stringify(result.error));
  assert.deepEqual(observations, [
    { stage: "resolve", input: { value: "default-value" } },
    {
      stage: "hook",
      name: target,
      input: { value: "default-value-resolved" },
      callId: "single-call",
    },
    { stage: "handler", input: { value: "hook-value" }, callId: "single-call" },
  ]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].toolName, target);
  assert.equal(requests[0].toolCallId, "single-call");
  assert.deepEqual(requests[0].input, { value: "hook-value" });
});

test("reference lists survive result budget and large hook text without reordering or textification", async () => {
  const references = Array.from({ length: 5_000 }, (_, index) => ({
    type: "tool_reference" as const,
    toolName: `fixture_tool_${index}`,
  }));
  const entry = {
    ...toolSearchToolEntry,
    resultBudget: { maxInlineBytes: 64, maxModelBytes: 64, strategy: "truncate" as const },
  };
  const serialized = await serializeOutput(
    {} as any,
    {
      matches: references.map((block) => block.toolName),
      query: "fixture",
      total_deferred_tools: references.length,
    },
    entry,
    { traceId: "fixture" } as any,
    "search-budget",
    new AbortController().signal,
  );
  assert.deepEqual(serialized.modelContent, references);
  assert.equal(serialized.truncated, false);
  const augmented = appendHookAdditionalContexts(serialized, ["中文".repeat(10_000)], entry);
  assert.ok(Array.isArray(augmented.modelContent));
  assert.deepEqual(
    augmented.modelContent.filter((block) => block.type === "tool_reference"),
    references,
  );
  assert.equal(augmented.truncated, true);
  assert.ok(
    augmented.modelContent
      .filter((block) => block.type === "text")
      .reduce((bytes, block) => bytes + Buffer.byteLength(block.text), 0) <= 64,
  );
});
