import assert from "node:assert/strict";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  InMemorySessionEventStore,
  type Logger,
  type Model,
  type ModelStreamEvent,
  type ModelUsageRecord,
  type SessionEvent,
  type SessionStorePort,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  assertProjectPath,
  createProjectTestFixture,
} from "../../../../../scripts/ci/project-test-sandbox.mjs";
import { sessionInput } from "../../adapters/test/fixtures/native-context-store.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { compressNativeContext } from "../src/runtime/native-context-compression/controller.js";
import { kernelOf, nativeOwner } from "../src/runtime/native-context-compression/state.js";
import { projectNativeEntries } from "../src/runtime/native-context-compression/projection.js";
import { PARENT } from "./native-context-boundary-fixture.js";
import { maintenanceGoalFixture } from "./native-context-maintenance-goal-fixture.js";
import { summaryResult } from "./native-context-maintenance-fixture.js";

export const NATIVE_SUMMARY =
  "Synthetic durable native summary: preserve the completed decision and original constraints.";
export const COMPACT_SUMMARY = "Synthetic complete foreground answer.";

/** SQLite JSON 不保存显式 undefined；对账只规范序列化格式，不改变数字或内容。 */
export function persistedValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function compactPersistenceFixture(t: TestContext) {
  const base = await maintenanceGoalFixture(t, {
    plan: ({ request }) => ({ text: summaryResult(request.messages, NATIVE_SUMMARY) }),
  });
  const directory = await createProjectTestFixture("native-compact-persistence");
  const dbPath = await assertProjectPath(join(directory, "db.sqlite"));
  type Store = Awaited<ReturnType<typeof createSqliteSessionStore>>;
  const stores = new Set<Store>();
  const agents = new Set<AgentRuntime>();
  const events: SessionEvent[] = [];
  const usageRecords: ModelUsageRecord[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return logger;
    },
  };
  // Compact 的真实入口强制 stream-first；复用同一 fake Model 的物理 statusSink 与用量，
  // 仅把完整结果转换成真实 ModelStreamEvent，不 stub Runtime compact/reset/recover。
  const createModel = (options = base.model.options): Model => ({
    ...base.model,
    options,
    bind(patch) {
      return createModel({ ...options, ...patch });
    },
    async *streamText(request): AsyncGenerator<ModelStreamEvent> {
      const result = await base.model.generateText(request);
      yield { type: "start" };
      yield { type: "text_start", id: "compact-text" };
      yield { type: "text_delta", id: "compact-text", text: result.text };
      yield { type: "text_end", id: "compact-text" };
      yield { type: "finish", finishReason: result.finishReason, usage: result.usage };
    },
  });
  const model = createModel();
  const open = async () => {
    const store = await createSqliteSessionStore({ dbPath });
    stores.add(store);
    return store;
  };
  const createRuntime = (store: SessionStorePort) => {
    const agent = new AgentRuntime(
      PARENT,
      {
        workingDirectory: directory,
        mode: "build",
        taskType: "interactive",
        modelSelection: { providerId: model.providerId, modelId: model.modelId },
        modelStreaming: "off",
        memory: { enabled: false },
        subagents: { enabled: false },
        mcp: { enabled: false, servers: {} },
      },
      {
        eventStore: new InMemorySessionEventStore(),
        sessionStore: store,
        modelFactory: () => model,
        logger,
        eventSink: { onSessionEvent: (event) => void events.push(event) },
      },
    );
    agents.add(agent);
    const runtime = agent as unknown as AgentRuntimeInternal;
    return { agent, runtime, owner: nativeOwner(runtime) };
  };
  t.after(async () => {
    for (const agent of agents) agent.beginShutdown();
    for (const store of stores) await store.close();
  });
  const store = await open();
  await store.createSession({ ...sessionInput(PARENT), directory, path: directory });
  const originals = structuredClone(base.messages);
  for (const message of originals)
    if (message.info.role === "assistant") message.info.path = { cwd: directory, root: directory };
  await store.commitMessageBundle({ sessionID: PARENT, messages: originals });
  await store.commitNativeContext(PARENT, {
    expectedRevision: null,
    expectedGeneration: 0,
    state: structuredClone(base.owner.state!),
  });
  await store.setTarget({
    sessionID: PARENT,
    objective: "Synthetic complete compact persistence Goal.",
    tokenBudget: 1000,
  });
  const port = new Proxy(store, {
    get(target, key) {
      if (key === "recordModelUsage")
        return async (record: ModelUsageRecord) => {
          await store.recordModelUsage(record);
          usageRecords.push(structuredClone(record));
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const live = createRuntime(port);
  await live.agent.resumeFromStore();
  assert.equal(live.owner.state?.policy.mode, "manual");
  live.runtime.runtimeCommandDrainActive = true;
  let receipt;
  try {
    receipt = await compressNativeContext.call(live.runtime, {
      model: { providerId: model.providerId, modelId: model.modelId },
      commandId: "seed-real-manual-native-view",
      abortSignal: new AbortController().signal,
      traceContext: live.runtime.rootTraceContext,
    });
  } finally {
    live.runtime.runtimeCommandDrainActive = false;
    await live.runtime.drainRuntimeCommandQueue();
  }
  assert.ok(receipt.operation);
  const operation = await store.getNativeContextOperation(PARENT, receipt.operation.operationId);
  assert.equal(operation?.status, "completed");
  assert.equal(base.calls.length, 1);
  const seeded = await store.getNativeContextForkBundle(PARENT);
  assert.ok(seeded);
  assert.ok(kernelOf(seeded.state).compression.blocks.some((block) => block.active));
  assert.ok(
    Object.values(kernelOf(seeded.state).projectionOperations!.blocks).includes(
      operation!.operationId,
    ),
  );
  const view = (runtime: AgentRuntimeInternal) =>
    projectNativeEntries(
      runtime.messageHistory.borrowReadOnlyRuntimeEntries(),
      nativeOwner(runtime).state!,
    );
  assert.equal(JSON.stringify(view(live.runtime)).includes(NATIVE_SUMMARY), true);
  const rawText = originals[0]!.parts.find((part) => part.type === "text");
  assert.ok(rawText?.type === "text");
  assert.equal(JSON.stringify(view(live.runtime)).includes(rawText.text), false);
  const sourceTexts = new Map<string, string>();
  for (const source of seeded.state.sources.filter((item) => item.kind !== "image")) {
    const page = await live.agent.readNativeContextSource({ ref: source.ref, limitTokens: 25_000 });
    assert.equal(page.originalAvailable, true);
    assert.equal(page.nextOffset, null);
    sourceTexts.set(source.ref, page.text);
  }
  const snapshot = async () => {
    const native = await store.getNativeContextForkBundle(PARENT);
    assert.ok(native);
    return {
      native,
      entries: structuredClone(live.runtime.messageHistory.borrowReadOnlyRuntimeEntries()),
      projection: structuredClone(view(live.runtime)),
      usage: await store.queryTaskUsage({ sessionID: PARENT }),
    };
  };
  const coldRestart = async () => {
    live.agent.beginShutdown();
    await store.close();
    stores.delete(store);
    const reopened = await open();
    const cold = createRuntime(reopened);
    assert.equal(cold.owner.state, null);
    assert.notEqual(cold.owner, live.owner);
    await cold.agent.resumeFromStore();
    return { ...cold, store: reopened };
  };
  return {
    ...live,
    store,
    port,
    model,
    events,
    usageRecords,
    originals,
    rawText: rawText.text,
    calls: base.calls,
    invocations: base.invocations,
    seeded,
    sourceTexts,
    snapshot,
    view,
    coldRestart,
    dbPath,
  };
}
