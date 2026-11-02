import assert from "node:assert/strict";
import test from "node:test";
import { loadComponentCallback } from "./fixtures/component-callback.mjs";
import { findTaskNavigationWorkspaceTab } from "../../packages/ui/src/app-shell/taskNavigationWorkspace.ts";

const shell = "packages/ui/src/app-shell/WorkspaceShellLayout.tsx";
const local = { kind: "workspace", id: "local", workspacePath: "fixture", purpose: "project" };
const remote = {
  ...local,
  id: "remote",
  workspaceIdentity: "remote-fixture",
  remoteSessionId: "remote-session",
};

for (const name of ["handleOpenSavedWorkflowRun", "handleOpenSavedWorkflowArtifact"]) {
  test(`${name} preserves explicit local source and run cwd`, async () => {
    const opened = [],
      selected = [];
    const callback = await loadComponentCallback(shell, name, {
      workspaceTabs: [remote, local],
      workspaceAbsPath: "fixture",
      workspaceIdentity: remote.workspaceIdentity,
      findTaskNavigationWorkspaceTab,
      handleSelectTaskInChat: (...args) => selected.push(args),
      handleOpenWorkflowRun: (request) => opened.push(request),
      handleOpenWorkflowArtifact: (request) => opened.push(request),
    });
    callback({
      workspacePath: "fixture",
      sessionId: "parent",
      runId: "run",
      toolCallId: "tool",
      artifactId: "artifact",
      fileReferenceRootPath: "fixture/session-cwd",
    });
    assert.equal(opened.length, 1);
    assert.equal(opened[0].fileReferenceRootPath, "fixture/session-cwd");
    assert.equal(opened[0].workspaceIdentity, undefined);
    assert.equal(opened[0].remoteSessionId, undefined);
    assert.deepEqual(selected[0], ["fixture", "parent", undefined, undefined]);
  });
}

for (const mode of ["local", "remote", "offline", "stale"]) {
  test(`actual sidebar callback resolves ${mode} session without ambient fallback`, async () => {
    const opened = [],
      queries = [],
      resolutions = [];
    const generation = { current: 0 };
    const baseServices = {},
      exactServices = {};
    const callback = await loadComponentCallback(shell, "handleOpenSidebarWorkflowRun", {
      sidebarWorkflowRunOpenGenerationRef: generation,
      workspaceTabs: [remote, local],
      baseServices,
      findTaskNavigationWorkspaceTab,
      handleSelectTaskInChat() {},
      resolveTaskExecutionWorkspaceServices: (scope) => {
        resolutions.push(scope);
        return mode === "offline" ? null : exactServices;
      },
      resolveTaskExecutionWorkspacePath: async (services, query) => {
        assert.equal(services, exactServices);
        queries.push(query);
        if (mode === "stale") generation.current++;
        return "fixture/session-cwd";
      },
      handleOpenSavedWorkflowRun: (request) => opened.push(request),
      logger: { warn() {} },
      toast() {},
      intl: { formatMessage: () => "Unavailable" },
    });
    await callback({
      workspacePath: "fixture",
      sessionId: "parent",
      ...(mode === "remote" || mode === "offline"
        ? { workspaceIdentity: remote.workspaceIdentity }
        : {}),
      run: { runId: "run", toolCallId: "tool", name: "Workflow" },
    });
    assert.equal(resolutions.length, 1);
    assert.equal(resolutions[0].baseServices, baseServices);
    assert.equal(
      resolutions[0].remoteSessionId,
      mode === "remote" || mode === "offline" ? "remote-session" : undefined,
    );
    assert.equal(queries.length, mode === "offline" ? 0 : 1);
    assert.equal(opened.length, mode === "offline" || mode === "stale" ? 0 : 1);
    if (opened.length) assert.equal(opened[0].fileReferenceRootPath, "fixture/session-cwd");
  });
}
