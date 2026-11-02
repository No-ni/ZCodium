import assert from "node:assert/strict";
import test from "node:test";
import { loadComponentCallback } from "./fixtures/component-callback.mjs";
async function setup(prepare, opener) {
  const actions = [],
    state = { activeTabId: "origin" };
  const create = await loadComponentCallback(
    "packages/ui/src/root/useRootWorkspaceActions.ts",
    "startNewTaskFromActiveWorkspace",
    {
      remoteProjectOpener: { current: opener },
      navigationSequence: { current: 0 },
      tabStoreApi: { getState: () => state },
      activeWorkspacePath: "fixture",
      activeWorkspaceIdentity: null,
      useZCodeSessionStore: {
        getState: () => ({
          getWorkspaceState: () => ({ activeTaskId: null, draftFocusVersion: 0 }),
        }),
      },
      readProjectSidebarView: () => "projects",
      services: { windowProjectDirectory: { projectService: { prepareSession: prepare } } },
      projectService: { prepareSession: prepare },
      resolveNewTaskTargetFromRequest: () => null,
      resolveWorkbenchNewTaskTarget: () => null,
      useWorkbenchGroupStore: { getState: () => ({ activeGroupId: null }) },
      usePaneLayoutStore: { getState: () => ({}) },
      workbenchGroupClientMode: "desktop-continuous",
      composerClientNamespace: "fixture-client",
      openMobileProjectDraft: undefined,
      addTab: (...v) => actions.push(["tab", ...v]),
      startDraftInWorkspace: (...v) => actions.push(["draft", ...v]),
      setWorkspaceActionError: (v) => actions.push(["error", v]),
      logger: { debug() {}, info() {}, error() {} },
      toast() {},
      intl: { formatMessage: (v) => v.id },
    },
  );
  return { create, actions, state };
}
test("root new task uses the window project owner before publishing a local draft", async () => {
  let prepared;
  const fixture = await setup(async (input) => {
    prepared = input;
    return { workspacePath: "prepared", projectId: "project-a" };
  });
  await fixture.create("fixture", { projectId: "project-a", hostId: "local" });
  assert.deepEqual(prepared, { projectId: "project-a", hostId: "local" });
  assert.deepEqual(fixture.actions[0], ["tab", "prepared", { workspacePurpose: "project" }]);
  assert.equal(fixture.actions[1][3].projectId, "project-a");
});
test("a late directory result after navigation cannot replace the active draft", async () => {
  let release;
  const fixture = await setup(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  const flight = fixture.create("fixture", { projectId: "project-a" });
  fixture.state.activeTabId = "another";
  release({ workspacePath: "prepared", projectId: "project-a" });
  await flight;
  assert.deepEqual(fixture.actions, []);
});
test("remote prepared draft uses its existing navigation port before publishing", async () => {
  const opened = [];
  const fixture = await setup(
    async () => ({
      workspacePath: "remote",
      workspaceIdentity: "identity-remote",
      projectId: "project-a",
    }),
    async (value) => opened.push(value),
  );
  await fixture.create("fixture", {
    projectId: "project-a",
    hostId: "host-a",
    remoteProjectMembershipId: "member-a",
  });
  assert.equal(opened[0].expectedMembershipId, "member-a");
  assert.equal(opened[0].workspaceIdentity, "identity-remote");
  assert.equal(fixture.actions[0][0], "draft");
});
