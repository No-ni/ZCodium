import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryJournalStore } from "@zcode/dynamic-workflow";
import { createDynamicWorkflowRunService } from "../src/app/dynamic-workflow-run-service.js";
import { ConversationV4Gateway, type V4GatewayHost } from "../src/zcode-protocol-v4/v4-gateway.js";

test("artifact and transcript queries expose the frozen run cwd after cold recovery, only to its owner", async () => {
  const journal = new InMemoryJournalStore();
  journal.createRun({
    runId: "run",
    parentSessionId: "parent",
    cwd: "/workspace/session/nested",
    status: "completed",
    spentTokens: 0,
    caps: { maxConcurrency: 1 },
  });
  const service = (parentSessionId: string) =>
    createDynamicWorkflowRunService({
      journal,
      parentSessionId,
      fileSystemPort: {} as never,
      executionPort: {} as never,
      createActorRuntime: () => {
        throw new Error("unexpected execution");
      },
    });
  const owner = service("parent");
  const foreign = service("foreign");
  const active = new Set<string>();
  const resumed: string[] = [];
  const gateway = new ConversationV4Gateway({
    sessionExists: (id) => active.has(id),
    resumePersistedSession: async (id) => {
      resumed.push(id);
      active.add(id);
      return { status: "resumed" };
    },
    listDynamicWorkflowRunArtifacts: async () => [],
    listDynamicWorkflowRunWorkspaceNodes: async () => [],
    getDynamicWorkflowRunExecutionWorkspacePath: (id, { runId }) =>
      (id === "parent" ? owner : foreign).getExecutionWorkspacePath!(runId),
  } as V4GatewayHost);
  try {
    const params = { sessionId: "parent", runId: "run" };
    assert.equal(
      (await gateway.workflowRunArtifacts(params)).executionWorkspacePath,
      "/workspace/session/nested",
    );
    assert.equal(
      (await gateway.workflowRunWorkspace(params)).executionWorkspacePath,
      "/workspace/session/nested",
    );
    assert.deepEqual(resumed, ["parent"]);
    assert.equal(
      (await gateway.workflowRunArtifacts({ ...params, sessionId: "foreign" }))
        .executionWorkspacePath,
      undefined,
    );
    assert.equal(
      (await gateway.workflowRunWorkspace({ ...params, sessionId: "foreign" }))
        .executionWorkspacePath,
      undefined,
    );
    assert.equal(await owner.getExecutionWorkspacePath!("missing"), undefined);
    assert.equal(await foreign.listArtifacts!("run"), undefined);
  } finally {
    gateway.dispose();
    await owner.close();
    await foreign.close();
  }
});

test("older hosts omit execution root without breaking either existing query", async () => {
  const gateway = new ConversationV4Gateway({
    sessionExists: () => true,
    listDynamicWorkflowRunArtifacts: async () => [],
    listDynamicWorkflowRunWorkspaceNodes: async () => [],
  } as unknown as V4GatewayHost);
  try {
    assert.deepEqual(await gateway.workflowRunArtifacts({ sessionId: "parent", runId: "old" }), {
      artifacts: [],
    });
    assert.deepEqual(await gateway.workflowRunWorkspace({ sessionId: "parent", runId: "old" }), {
      nodes: [],
    });
  } finally {
    gateway.dispose();
  }
});
