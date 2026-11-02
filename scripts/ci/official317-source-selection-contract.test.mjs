import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

test("saved Source selection reads explicit setting history and current profile target", async () => {
  const source = await readFile(
    "packages/ui/src/remote-connection/RemoteConnectionSelection.tsx",
    "utf8",
  );
  assert.ok(
    !/snapshot!?\??\.workspaceHistory/.test(source),
    "management snapshot does not own history",
  );
  assert.ok(!source.includes(".transport") && !source.includes(".lifecycleState"));
  assert.match(source, /kind=\{profile\?\.target\.kind/);
  const flow = await readFile(
    "packages/ui/src/remote-connection-flow/flowViewSelectionStep.ts",
    "utf8",
  );
  assert.match(flow, /workspaceHistory:\s*remoteHistory/);
});

test("legacy aliases still require exact identity and one confirmed Source", async () => {
  const { getWorkspaceSourceServerId } = await tsImport(
    "../../packages/ui/src/conversation-workspace-target/sourceIdentity.ts",
    import.meta.url,
  );
  const target = { workspacePath: "/fixture", workspaceIdentity: "remote:ssh:legacy:/fixture" };
  const alias = {
    workspacePath: "/fixture",
    legacyWorkspaceIdentity: target.workspaceIdentity,
    sourceServerId: "source-a",
  };
  assert.equal(getWorkspaceSourceServerId(target, { workspaceHistory: [alias] }), "source-a");
  assert.equal(
    getWorkspaceSourceServerId(target, {
      workspaceHistory: [alias, { ...alias, sourceServerId: "source-b" }],
    }),
    null,
  );
  assert.equal(
    getWorkspaceSourceServerId(target, {
      workspaceHistory: [{ ...alias, workspacePath: "/other" }],
    }),
    null,
  );
});

test("retained project connections do not manufacture installation or raw error fields", async () => {
  const source = await readFile(
    "packages/ui/src/project-sidebar/remote-project-connection.ts",
    "utf8",
  );
  assert.ok(
    !source.includes("snapshot?.workspaceHistory") &&
      !source.includes("installState:") &&
      !source.includes("state?.error "),
  );
  assert.match(source, /workspaceHistory:\s*input\.workspaceHistory/);
  assert.match(source, /pendingWizard && \(await stillRetained\(\)\)/);
});

test("identity detail shows current connection state without retired operation log APIs", async () => {
  const source = await readFile(
    "packages/ui/src/project-sidebar/RemoteConnectionProgressSection.tsx",
    "utf8",
  );
  assert.ok(
    !source.includes("useSourceServerOperationLogs") &&
      !source.includes("resolveRemoteOperationProgress"),
  );
  assert.match(source, /workspaceSidebar\.connecting/);
});
