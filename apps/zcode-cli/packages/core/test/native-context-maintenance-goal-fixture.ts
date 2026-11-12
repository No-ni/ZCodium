import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import {
  getCurrentModelInvocationContext,
  InMemorySessionEventStore,
  type Logger,
  type ModelUsage,
  type SessionEvent,
} from "@zcode/contracts";
import { createProjectTestFixture } from "../../../../../scripts/ci/project-test-sandbox.mjs";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { NativeContextStoredState } from "@zcode/shared/native-context-compression";
import { hydrateMessageHistoryFromSession } from "../src/agent/session-history-hydrator.js";
import { compressNativeContext } from "../src/runtime/native-context-compression/controller.js";
import { nativeOwner } from "../src/runtime/native-context-compression/state.js";
import { PARENT } from "./native-context-boundary-fixture.js";
import {
  maintenanceFixture,
  summaryResult,
  type MaintenanceCall,
  type MaintenancePlan,
} from "./native-context-maintenance-fixture.js";

export const MAIN_USAGE: ModelUsage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 };

export async function maintenanceGoalFixture(
  t: TestContext,
  options: {
    automatic?: boolean;
    status?: "active" | "paused" | "budget_limited";
    tokenBudget?: number;
    plan?: MaintenancePlan;
    decisionPlan?: MaintenancePlan;
    configure?: (state: NativeContextStoredState) => void;
  } = {},
) {
  const invocations: { call: MaintenanceCall; querySource: string }[] = [];
  const base = await maintenanceFixture(
    t,
    async (call) => {
      const source = getCurrentModelInvocationContext()?.metadata?.querySource;
      const querySource = typeof source === "string" ? source : "unknown";
      invocations.push({ call, querySource });
      return querySource === "native_context_maintenance"
        ? await (options.plan?.(call) ?? { text: summaryResult(call.request.messages) })
        : querySource === "native_context_decision"
          ? await (options.decisionPlan?.(call) ?? { text: '{"compress":true}' })
          : { text: "Synthetic complete foreground answer.", usage: MAIN_USAGE };
    },
    (state) => {
      if (options.automatic) {
        state.policy.mode = "auto";
        state.policy.parameters.trigger.start = { kind: "percent", value: 10 };
        state.policy.parameters.trigger.target = { kind: "percent", value: 5 };
        state.policy.parameters.trigger.opportunisticPercent = 5;
        state.policy.parameters.trigger.waitForUsageSample = false;
      }
      options.configure?.(state);
    },
  );
  const directory = await createProjectTestFixture("native-maintenance-goal");
  const events: SessionEvent[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return logger;
    },
  };
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
      sessionStore: base.store,
      modelFactory: () => base.model,
      logger,
      eventSink: { onSessionEvent: (event) => void events.push(event) },
    },
  );
  const runtime = agent as unknown as AgentRuntimeInternal;
  t.after(() => agent.beginShutdown());
  runtime.sessionPersisted = true;
  runtime.turnNumber = 1;
  await hydrateMessageHistoryFromSession({
    history: runtime.messageHistory,
    messages: base.messages,
  });
  runtime.latestConversationMessageId = base.messages.at(-1)!.info.id;
  const owner = nativeOwner(runtime);
  owner.state = await base.store.getNativeContextState(PARENT);
  assert.ok(owner.state);
  const created = await base.store.setTarget({
    objective: "Synthetic native maintenance Goal.",
    sessionID: PARENT,
    tokenBudget: options.tokenBudget ?? 1000,
  });
  if (options.status === "paused")
    await base.store.updateTargetStatus({ sessionID: PARENT, status: "paused" });
  if (options.status === "budget_limited")
    await base.store.accountTargetUsage({
      sessionID: PARENT,
      targetID: created.targetID,
      tokensUsedDelta: created.tokenBudget!,
    });
  const goal = await runtime.readSessionTargetForContext(runtime.rootTraceContext);
  assert.ok(goal);
  assert.equal(goal.status, options.status ?? "active");
  const input = (commandId: string, abort = new AbortController()) => ({
    model: { providerId: base.model.providerId, modelId: base.model.modelId },
    commandId,
    abortSignal: abort.signal,
    traceContext: runtime.rootTraceContext,
  });
  const manual = async (commandId: string) => {
    runtime.runtimeCommandDrainActive = true;
    try {
      return await compressNativeContext.call(runtime, input(commandId));
    } finally {
      runtime.runtimeCommandDrainActive = false;
      await runtime.drainRuntimeCommandQueue();
    }
  };
  const replayManual = async (commandId: string) => {
    owner.commandResults?.clear();
    return await manual(commandId);
  };
  return {
    ...base,
    runtime,
    owner,
    goal,
    events,
    invocations,
    input,
    manual,
    replayManual,
    safePoint: () => ({
      entries: runtime.messageHistory.borrowReadOnlyRuntimeEntries(),
      model: base.model,
      tools: [],
      traceContext: runtime.rootTraceContext,
    }),
  };
}
