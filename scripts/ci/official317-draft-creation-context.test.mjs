import assert from "node:assert/strict";
import test from "node:test";
import { loadComponentCallback } from "./fixtures/component-callback.mjs";

test("send freezes project and group before the configuration barrier", async () => {
  const workspace = {
    draftProjectId: "project-a",
    draftTaskGroupId: "group-a",
    draftCreateSource: "group",
  };
  let run, received;
  const send = await loadComponentCallback(
    "packages/ui/src/v4/SessionPane.tsx",
    "dispatchSendText",
    {
      useZCodeSessionStore: { getState: () => ({ getWorkspaceState: () => workspace }) },
      workspacePath: "fixture-workspace",
      workspaceIdentity: "fixture-identity",
      workspaceKey: "fixture-identity",
      sessionId: null,
      prewarmBindingRef: { current: null },
      createSubmissionFromComposer: () => ({ model: "fixture" }),
      configCommandBarrier: {
        enqueue: (callback) => {
          run = callback;
        },
      },
      dispatchSendTextAfterConfig: async (_text, _options, context) => {
        received = context;
      },
      isProviderNotReadyError: () => false,
      markDraftProviderNotReady() {},
    },
  );
  send("fixture prompt");
  workspace.draftProjectId = "project-b";
  workspace.draftTaskGroupId = "group-b";
  await run();
  assert.equal(received.projectId, "project-a");
  assert.equal(received.taskGroupId, "group-a");
  assert.equal(received.workspace.workspaceIdentity, "fixture-identity");
});

test("create dispatch forwards frozen project intent and records the same recovery context", async () => {
  let forwarded, recorded;
  const ack = { status: "accepted", result: { type: "createSession", sessionId: "created" } };
  const context = {
    workspace: { workspacePath: "fixture", workspaceIdentity: "identity-a" },
    projectId: "project-a",
    taskGroupId: "group-a",
    sessionCreateSource: "group",
  };
  const dispatch = await loadComponentCallback(
    "packages/ui/src/v4/SessionPane.tsx",
    "dispatchCommand",
    {
      sessionId: null,
      workspacePath: "fixture",
      workspaceIdentity: "identity-a",
      lease: null,
      useZCodeSessionStore: {
        getState: () => ({ getWorkspaceState: () => ({ draftProjectId: "project-b" }) }),
      },
      readGenUiModelContext: async () => "",
      submissionConfigFromCommand: () => null,
      captureComposerRecentSubmission() {},
      captureAcceptedModelSelection() {},
      createCommandEnvelope: (params) => ({ ...params, commandId: "creation-a" }),
      pendingCommandRegistry: {
        record: (_envelope, value) => {
          recorded = value;
        },
        applyAck() {},
      },
      measureOperation: (_kind, callback) => callback(),
      sendCommand: async (_envelope, value) => {
        forwarded = value;
        return ack;
      },
      recordV4CommandAck() {},
      shouldResyncForStaleAuthority: () => false,
    },
  );
  await dispatch(
    "createSession",
    { workspaceId: "identity-a" },
    null,
    undefined,
    undefined,
    undefined,
    undefined,
    context,
  );
  assert.equal(forwarded.projectId, "project-a");
  assert.equal(recorded.projectId, "project-a");
  assert.equal(recorded.taskGroupId, "group-a");
});

test("organization retries use the same creation identity without blocking directory promotion", async () => {
  const calls = [],
    retryActions = [];
  let organize,
    committed = false;
  const service = {
    admit: async (value) => {
      calls.push(value);
      if (calls.length === 1) throw Error("fixture failure");
    },
  };
  const created = await loadComponentCallback(
    "packages/ui/src/v4/SessionPane.tsx",
    "handleDraftSessionCreated",
    {
      organizationServices: { taskGroupService: service },
      workspacePath: "fixture",
      workspaceIdentity: undefined,
      remoteHostIdFromWorkspaceIdentity: () => null,
      promoteComposerDraft: () => true,
      newlyCreatedSessionIdRef: { current: null },
      onSessionCreated: () => {
        committed = true;
      },
      draftNavigation: { controller: new AbortController() },
      commitCreatedTask: async (_target, commit, _signal, action) => {
        organize = action;
        commit();
      },
      refreshTaskGroups() {},
      logger: { error() {} },
      intl: { formatMessage: (descriptor) => descriptor.id },
      toast: (_message, options) => {
        retryActions.push(options.onAction);
      },
    },
  );
  await created("created", { taskGroupId: "group-a" }, "creation-a");
  assert.equal(committed, true);
  assert.equal(calls.length, 0);
  await organize();
  assert.equal(calls.length, 1);
  await retryActions[0]();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(calls[1].placement.creationId, "creation-a");
});

test("a lost ACK completes creation through the existing resolution subscription with frozen placement", async () => {
  let resolution;
  const completed = [];
  const context = {
    workspace: { workspacePath: "fixture" },
    projectId: "project-a",
    taskGroupId: "group-a",
  };
  const entry = { sessionId: "created" };
  const dispatch = await loadComponentCallback(
    "packages/ui/src/v4/SessionPane.tsx",
    "dispatchCommand",
    {
      sessionId: null,
      workspacePath: "fixture",
      workspaceIdentity: undefined,
      lease: null,
      useZCodeSessionStore: {
        getState: () => ({ getWorkspaceState: () => ({ draftProjectId: "project-b" }) }),
      },
      readGenUiModelContext: async () => "",
      submissionConfigFromCommand: () => null,
      captureComposerRecentSubmission() {},
      captureAcceptedModelSelection() {},
      createCommandEnvelope: (params) => ({ ...params, commandId: "creation-a" }),
      pendingCommandRegistry: {
        record: () => entry,
        subscribeResolution: (_id, callback) => {
          resolution = callback;
        },
        findCommand: () => entry,
      },
      handleDraftSessionCreated: async (...values) => {
        completed.push(values);
      },
      measureOperation: (_kind, callback) => callback(),
      sendCommand: async () => {
        throw Error("fixture transport");
      },
      recordV4CommandAck() {},
      isProviderNotReadyError: () => false,
      logger: { warn() {} },
    },
  );
  await assert.rejects(
    dispatch(
      "createSession",
      { firstInput: { text: "fixture" } },
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      context,
    ),
  );
  assert.equal(completed.length, 0);
  resolution("authoritative");
  assert.equal(completed.length, 1);
  assert.equal(completed[0][0], "created");
  assert.deepEqual(completed[0][1], context);
  assert.equal(completed[0][2], "creation-a");
});

test("prewarm replacement during the barrier cannot receive the old draft submission", async () => {
  const calls = [];
  const oldBinding = { sessionId: "old-prewarm" };
  const newerBinding = {
    sessionId: "new-prewarm",
    beginPromotion() {
      throw Error("new generation must not receive old input");
    },
  };
  const send = await loadComponentCallback(
    "packages/ui/src/v4/SessionPane.tsx",
    "dispatchSendTextAfterConfig",
    {
      sessionId: null,
      prewarmBindingRef: { current: newerBinding },
      snapshotRef: { current: null },
      parseV4VisibleSlashCommand: () => null,
      ensureDraftModelReadyForSend: async () => true,
      appSlashCommands: [],
      appFollowupMode: "queue",
      draftConfigRef: { current: {} },
      workspaceKey: "fixture",
      buildDraftCreateConfigPayload: () => ({}),
      dispatchCommand: async (...values) => {
        calls.push(values);
        return { status: "accepted", result: { type: "createSession", sessionId: "created" } };
      },
    },
  );
  await send(
    "fixture",
    { submission: { modelSelection: { providerId: "fixture", modelId: "fixture" } } },
    { workspace: { workspacePath: "fixture" } },
    oldBinding,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "createSession");
  assert.equal(calls[0][2], null);
});

test("navigation cancellation retains group placement while suppressing stale promotion", async () => {
  const pendingCommits = { current: new Set() };
  const commitCreatedTask = await loadComponentCallback(
    "packages/ui/src/project-sidebar/useProjectTree.ts",
    "commitCreatedTask",
    {
      pendingCommits,
      refresh: async () => {},
    },
  );
  const controller = new AbortController();
  let promoted = 0,
    organized = 0;
  const created = await loadComponentCallback(
    "packages/ui/src/v4/SessionPane.tsx",
    "handleDraftSessionCreated",
    {
      organizationServices: {
        taskGroupService: {
          admit: async () => {
            organized++;
          },
        },
      },
      workspacePath: "fixture",
      workspaceIdentity: undefined,
      remoteHostIdFromWorkspaceIdentity: () => null,
      promoteComposerDraft: () => {
        promoted++;
        return true;
      },
      newlyCreatedSessionIdRef: { current: null },
      onSessionCreated() {},
      draftNavigation: { controller },
      commitCreatedTask,
      refreshTaskGroups() {},
      logger: { error() {} },
      intl: { formatMessage: (d) => d.id },
      toast() {},
    },
  );
  const flight = created("created", { taskGroupId: "group-a" }, "creation-a");
  controller.abort();
  await flight;
  const [pending] = pendingCommits.current;
  assert.ok(pending, "accepted placement must survive navigation cancellation");
  await pending.organize();
  pending.commit();
  pending.finish();
  assert.equal(organized, 1);
  assert.equal(promoted, 0);
});

test("without a directory provider an aborted draft must also suppress promotion", async () => {
  const controller = new AbortController();
  controller.abort();
  let promoted = 0;
  const created = await loadComponentCallback(
    "packages/ui/src/v4/SessionPane.tsx",
    "handleDraftSessionCreated",
    {
      organizationServices: {},
      workspacePath: "fixture",
      workspaceIdentity: undefined,
      promoteComposerDraft: () => {
        promoted++;
        return true;
      },
      newlyCreatedSessionIdRef: { current: null },
      onSessionCreated() {},
      draftNavigation: { controller },
      commitCreatedTask: undefined,
    },
  );
  await created("created");
  assert.equal(promoted, 0);
});
