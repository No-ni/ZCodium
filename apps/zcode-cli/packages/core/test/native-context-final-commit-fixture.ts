import assert from "node:assert/strict";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { InMemorySessionEventStore, type Logger, type SessionStorePort } from "@zcode/contracts";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type { NativeContextCommit } from "@zcode/shared/native-context-compression";
import {
  assertProjectPath,
  createProjectTestFixture,
} from "../../../../../scripts/ci/project-test-sandbox.mjs";
import { sessionInput } from "../../adapters/test/fixtures/native-context-store.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { hydrateMessageHistoryFromSession } from "../src/agent/session-history-hydrator.js";
import { recoverNativeContext } from "../src/runtime/native-context-compression/index.js";
import { runNativeMaintenance } from "../src/runtime/native-context-compression/maintenance.js";
import {
  kernelOf,
  nativeOwner,
  writeNativeState,
} from "../src/runtime/native-context-compression/state.js";
import { syncNativeSources } from "../src/runtime/native-context-compression/sources.js";
import { nativeCountTokens } from "../src/runtime/native-context-compression/measurements.js";
import { maintenanceGoalFixture } from "./native-context-maintenance-goal-fixture.js";
import { message, PARENT } from "./native-context-boundary-fixture.js";
import { summaryResult } from "./native-context-maintenance-fixture.js";

export const OLD_SUMMARY =
  "Synthetic committed old summary: preserve the earlier decision and its constraints.";
export const NEW_SUMMARY =
  "Synthetic candidate new summary: preserve the later observation and completed action.";
export const APPENDED_TEXT =
  "Synthetic later complete history: observed result and preserved constraint. ".repeat(180);

export async function finalCommitFixture(t: TestContext, settlementFails = false) {
  let summary = OLD_SUMMARY;
  const base = await maintenanceGoalFixture(t, {
    plan: ({ request }) => ({ text: summaryResult(request.messages, summary) }),
  });
  const directory = await createProjectTestFixture("native-final-commit");
  const dbPath = await assertProjectPath(join(directory, "db.sqlite"));
  const stores = new Set<Awaited<ReturnType<typeof createSqliteSessionStore>>>();
  const agents = new Set<AgentRuntime>();
  const logger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return logger;
    },
  };
  const openStore = async () => {
    const store = await createSqliteSessionStore({ dbPath });
    stores.add(store);
    return store;
  };
  t.after(async () => {
    for (const agent of agents) agent.beginShutdown();
    for (const store of stores) await store.close();
  });
  const createRuntime = async (store: SessionStorePort) => {
    const agent = new AgentRuntime(
      PARENT,
      {
        workingDirectory: directory,
        mode: "build",
        taskType: "interactive",
        modelSelection: { providerId: base.model.providerId, modelId: base.model.modelId },
        modelStreaming: "off",
        memory: { enabled: false },
        subagents: { enabled: false },
        mcp: { enabled: false, servers: {} },
      },
      {
        eventStore: new InMemorySessionEventStore(),
        sessionStore: store,
        modelFactory: () => base.model,
        logger,
      },
    );
    agents.add(agent);
    const runtime = agent as unknown as AgentRuntimeInternal;
    runtime.sessionPersisted = true;
    runtime.turnNumber = 1;
    const messages = await store.messages({ sessionID: PARENT });
    await hydrateMessageHistoryFromSession({ history: runtime.messageHistory, messages });
    runtime.latestConversationMessageId = messages.at(-1)!.info.id;
    return { agent, runtime, owner: nativeOwner(runtime), messages };
  };
  const store = await openStore();
  await store.createSession(sessionInput(PARENT));
  await store.commitMessageBundle({ sessionID: PARENT, messages: base.messages });
  const state = structuredClone(base.owner.state!);
  state.policy.parameters.trigger.start = { kind: "percent", value: 90 };
  state.policy.parameters.trigger.target = { kind: "percent", value: 1 };
  state.policy.parameters.trigger.opportunisticPercent = 1;
  await store.commitNativeContext(PARENT, {
    expectedRevision: null,
    expectedGeneration: 0,
    state,
  });
  const goal = await store.setTarget({
    sessionID: PARENT,
    objective: "Synthetic final native commit Goal.",
    tokenBudget: 1000,
  });
  const live = await createRuntime(store);
  live.owner.state = await store.getNativeContextState(PARENT);
  const safePoint = () => ({
    entries: live.runtime.messageHistory.borrowReadOnlyRuntimeEntries(),
    model: base.model,
    tools: [],
    traceContext: live.runtime.rootTraceContext,
  });
  const seeded = await runNativeMaintenance(live.runtime, safePoint(), "manual");
  assert.equal(seeded.operation?.status, "completed", "seed a genuinely committed earlier view");
  assert.ok(kernelOf(live.owner.state!).compression.blocks.some((block) => block.active));
  const added = [
    message("later-user"),
    message("later-assistant", "assistant"),
    message("new-current-user"),
  ];
  for (const item of added.slice(0, 2)) {
    const text = item.parts.find((part) => part.type === "text");
    assert.ok(text?.type === "text");
    text.text = APPENDED_TEXT;
  }
  const messages = [...live.messages, ...added];
  await store.commitMessageBundle({ sessionID: PARENT, messages: added });
  live.runtime.messageHistory.reset();
  await hydrateMessageHistoryFromSession({ history: live.runtime.messageHistory, messages });
  live.runtime.latestConversationMessageId = added.at(-1)!.info.id;
  await writeNativeState(live.owner, (next) =>
    syncNativeSources(next, safePoint().entries, nativeCountTokens),
  );
  const before = structuredClone(live.owner.state!);
  const canonicalBefore = await store.messages({ sessionID: PARENT });
  const candidateWrites: NativeContextCommit[] = [];
  const rejectedOperationIds = new Set<string>();
  let settlementRejections = 0;
  summary = NEW_SUMMARY;
  const port = new Proxy(store, {
    get(target, key) {
      if (key === "commitNativeContext")
        return async (sessionId: typeof PARENT, commit: NativeContextCommit) => {
          const completed = commit.operations?.find(
            (operation) => operation.kind === "summary" && operation.status === "completed",
          );
          if (completed && !rejectedOperationIds.size) {
            assert.equal(
              base.calls.length,
              2,
              "the paid model must have returned success before final commit injection",
            );
            const rows = (
              await store.listNativeContextObservations(PARENT, {
                purpose: "maintenance",
                limit: 200,
              })
            ).items;
            assert.equal(rows.filter((row) => row.status === "completed").length, 2);
            assert.notDeepEqual(
              commit.state.kernel,
              before.kernel,
              "reject the actual new candidate, not a preliminary write",
            );
            candidateWrites.push(structuredClone(commit));
            rejectedOperationIds.add(completed.operationId);
            throw new Error("Synthetic final candidate commit rejection.");
          }
          if (
            settlementFails &&
            commit.operations?.some((operation) => rejectedOperationIds.has(operation.operationId))
          ) {
            settlementRejections++;
            throw new Error("Synthetic subsequent terminal settlement rejection.");
          }
          await store.commitNativeContext(sessionId, commit);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  live.runtime.sessionStore = port;
  const coldRestart = async () => {
    live.agent.beginShutdown();
    await store.close();
    stores.delete(store);
    const reopened = await openStore();
    const cold = await createRuntime(reopened);
    await recoverNativeContext(cold.runtime);
    return { ...cold, store: reopened };
  };
  return {
    ...live,
    store,
    goal,
    calls: base.calls,
    before,
    canonicalBefore,
    safePoint,
    candidateWrites,
    rejectedOperationIds,
    coldRestart,
    settlementRejections: () => settlementRejections,
  };
}
