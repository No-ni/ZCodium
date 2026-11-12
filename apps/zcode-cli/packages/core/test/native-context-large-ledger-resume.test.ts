import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { InMemorySessionEventStore, createSessionId } from "@zcode/contracts";
import { createProjectTestFixture } from "../../../../../scripts/ci/project-test-sandbox.mjs";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { seedNativeContextLargeLedger } from "./native-context-large-ledger-seed.js";
import {
  calculateNativeContextLedgerResumeExpected,
  createNativeContextLedgerResumeRecipe,
  readNativeContextLedgerSnapshot,
} from "./native-context-ledger-resume-context.js";

test("NCTX-58 actual fresh resume reconciles one exact full-input version and preserves every seed fact", async (t) => {
  const sandboxRoot = await createProjectTestFixture("nctx-ledger-real-resume");
  const homeDir = join(sandboxRoot, "home");
  const { manifest } = await seedNativeContextLargeLedger({
    sandboxRoot,
    homeDir,
    model: { providerId: "nctx-ledger", modelId: "ledger-model" },
    version: "3.17.1",
  });
  const sessionId = createSessionId(manifest.namespace);
  assert.equal(sessionId, manifest.sessionId);
  const original = await readNativeContextLedgerSnapshot(manifest.dbPath, sessionId);
  const recipe = await createNativeContextLedgerResumeRecipe({
    ...manifest,
    hostPreferences: { memoryEnabled: false },
  });
  const independent = await calculateNativeContextLedgerResumeExpected(original.messages, recipe);
  assert.notEqual(independent.historyVersion, manifest.historyVersion);
  assert.deepEqual(
    manifest.resumeExpected,
    independent,
    "manifest expected must come from the independent input recipe before any owner resume",
  );
  assert.deepEqual(original.facts, manifest.seedFacts);
  assert.deepEqual(
    [
      original.bundle.state.revision,
      original.bundle.state.generation,
      original.bundle.state.historyVersion,
    ],
    [manifest.revision, manifest.generation, manifest.historyVersion],
  );
  const store = await createSqliteSessionStore({ dbPath: manifest.dbPath });
  let nativeWrites = 0;
  const sessionStore = new Proxy(store, {
    get(target, property) {
      if (property === "commitNativeContext")
        return async (...args: Parameters<typeof store.commitNativeContext>) => {
          nativeWrites++;
          return store.commitNativeContext(...args);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  t.after(() => store.close());
  const fresh = () =>
    new AgentRuntime(
      sessionId,
      {
        workingDirectory: manifest.workspacePath,
        workspacePath: manifest.workspacePath,
        mode: "build",
        taskType: "interactive",
        presentationSurface: "zcode_desktop",
        envInfo: recipe.contextConfig.envInfo,
        genUiOutputRoot: recipe.genUiOutputRoot,
        bashShellSelection: recipe.shellSelection,
        memory: { enabled: false },
        mcp: { enabled: false, servers: {} },
        subagents: { enabled: false },
        dynamicWorkflowEnabled: recipe.dynamicWorkflow.enabled,
      },
      {
        sessionStore,
        eventStore: new InMemorySessionEventStore(),
        fileSystemPort: createNodeFileSystemAdapter(),
        skillPort: recipe.skillPort,
        modelFactory: () => {
          throw new Error("NCTX_LEDGER_RESUME_MUST_NOT_CALL_MODEL");
        },
      },
    );
  const first = fresh();
  t.after(() => first.close());
  await first.resumeFromStore();
  assert.equal(nativeWrites, 1);
  const actual = await readNativeContextLedgerSnapshot(manifest.dbPath, sessionId);
  const state = actual.bundle.state;
  // 旧 helper 错把 canonical seed 版本当成含系统前缀的 resume 版本；红测必须走真实 Runtime。
  const expected = manifest.resumeExpected;
  assert.deepEqual(
    {
      revision: state.revision,
      generation: state.generation,
      historyVersion: state.historyVersion,
      policyVersion: state.policy.policyVersion,
      currentSegmentId: state.compactBoundaryId,
    },
    {
      revision: expected.revision,
      generation: expected.generation,
      historyVersion: expected.historyVersion,
      policyVersion: expected.policyVersion,
      currentSegmentId: expected.currentSegmentId,
    },
  );
  assert.deepEqual(actual.facts, original.facts);
  assert.deepEqual(actual.messages, original.messages);
  assert.deepEqual(actual.bundle.observations, original.bundle.observations);
  assert.deepEqual(actual.bundle.operations, original.bundle.operations);
  assert.deepEqual(state.sources, original.bundle.state.sources);
  assert.equal(actual.messages.length, 5940);
  assert.equal(actual.bundle.observations.length, 3000);
  assert.equal(actual.bundle.operations.length, 15);
  await first.close();
  const second = fresh();
  t.after(() => second.close());
  await second.resumeFromStore();
  assert.equal(
    nativeWrites,
    1,
    "a fresh owner cannot reconcile an already-identical full-input hash again",
  );
  const repeated = await readNativeContextLedgerSnapshot(manifest.dbPath, sessionId);
  assert.deepEqual(repeated, actual);
});
