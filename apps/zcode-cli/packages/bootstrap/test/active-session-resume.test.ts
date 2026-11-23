import assert from "node:assert/strict";
import test from "node:test";
import { createRootTraceContext, type SessionEventStorePort } from "@zcode/contracts";
import type { ZCodeApp } from "../src/app/types.js";
import { activateSessionForResume } from "../src/zcode-protocol/server-operations.js";
import { buildWorkspaceRef } from "../src/zcode-protocol/workspace.js";
import type {
  ZCodeProtocolAgentResolvedDependencies,
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "../src/zcode-protocol/server-types.js";
import { SessionLifecycleController } from "../src/session-lifecycle/index.js";
import type { ZCodeSessionPersistence, ZCodeSessionResumeParams } from "@zcode/shared";
import type { V4InteractionRegistry } from "../src/zcode-protocol-v4/interaction-registry.js";

test("waits for the lifecycle release and reuses the available resident without cold restoration", async () => {
  const sessionId = "active-session-resume";
  const calls = {
    appResume: 0,
    createSessionEventStore: 0,
    createZCodeApp: 0,
    persistedSessionRead: 0,
    waitForDeactivation: [] as string[],
  };
  const eventStore: SessionEventStorePort = {
    append: async (event) => event,
    deleteSession: async () => undefined,
    getEvents: async () => [],
    getEventsAfter: async () => [],
    getLatestSequenceNumber: async () => 0,
  };
  const resident: ZCodeProtocolSessionRecord = {
    app: {
      resume: async () => {
        calls.appResume += 1;
        throw new Error("resident resume must not resume the existing app again");
      },
    } as unknown as ZCodeApp,
    createdAt: 1,
    eventStore,
    memoryEnabled: false,
    modelContextBudgetStrategy: "legacy",
    nativeSearchEnhancementsEnabled: false,
    persistence: {} as unknown as ZCodeSessionPersistence,
    protocolEventSequences: new Map(),
    protocolToolInputTransmissions: new Map(),
    stateRevision: 0,
    traceContext: createRootTraceContext({ sessionId }),
    updatedAt: 1,
    workspace: buildWorkspaceRef({ workspacePath: "C:\\workspace" }),
  };

  const deactivationEntered = Promise.withResolvers<void>();
  const finishDeactivation = Promise.withResolvers<void>();
  const deps = {
    createSessionEventStore: () => {
      calls.createSessionEventStore += 1;
      return eventStore;
    },
    createZCodeApp: () => {
      calls.createZCodeApp += 1;
      throw new Error("resident resume must not create another app");
    },
    sessionStore: {
      getSession: async () => {
        calls.persistedSessionRead += 1;
        throw new Error("resident resume must not read persistence");
      },
    },
  } as unknown as ZCodeProtocolAgentResolvedDependencies;
  const context: ZCodeProtocolAgentServerContext = {
    appRuntimePreferences: {
      askUserQuestionAutoResolutionEnabled: false,
      dynamicWorkflowEnabled: false,
    },
    deps,
    notify: () => undefined,
    requestClient: async <T>() => {
      throw new Error("resident resume must not request client data");
    },
    sessions: new Map([[sessionId, resident]]),
    v4Interactions: {} as unknown as V4InteractionRegistry,
  };
  const params: ZCodeSessionResumeParams = { sessionId, workspace: resident.workspace };

  // 上游已由 Lifecycle owner 统一串行释放与恢复，旧 resident-pool 替身不再是准入入口。
  const lifecycle = new SessionLifecycleController({
    exists: async () => true,
    hasRuntime: () => context.sessions.has(sessionId),
    validateActivation: async () => {},
    activate: async () => assert.fail("available resident does not need cold activation"),
    assertCanStop: () => {},
    release: async (requestedSessionId) => {
      calls.waitForDeactivation.push(requestedSessionId);
      deactivationEntered.resolve();
      await finishDeactivation.promise;
    },
  });
  context.sessionLifecycle = lifecycle;
  const release = lifecycle.dispose(sessionId);
  await deactivationEntered.promise;

  const activation = activateSessionForResume(context, params);
  let settled = false;
  void activation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.resolve();

  assert.equal(settled, false, "resume stays behind the deactivation barrier");
  assert.deepEqual(calls.waitForDeactivation, [sessionId]);

  finishDeactivation.resolve();
  await release;
  const activated = await activation;

  assert.strictEqual(activated.record, resident);
  assert.equal(calls.persistedSessionRead, 0);
  assert.equal(calls.createZCodeApp, 0);
  assert.equal(calls.createSessionEventStore, 0);
  assert.equal(calls.appResume, 0);
});
