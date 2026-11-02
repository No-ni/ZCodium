import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
async function opener(directory, controller) {
  const text = await readFile(new URL("../../packages/ui/src/Root.tsx", import.meta.url), "utf8");
  const file = ts.createSourceFile(
    "Root.tsx",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let fn;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "openPreparedRemoteProjectWorkspace")
      fn = node;
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(fn, "Root must supply the real prepared-project navigation port");
  let attached;
  const deps = {
    services: { windowProjectDirectory: directory },
    attachRemoteProjectWorkspace: async (input) => {
      attached = input;
      await input.bind("fixture-session", input.workspacePath, input.isCurrent);
    },
    useRemoteWorkspaceSessionStore: {
      getState: () => ({
        sessionsById: {
          "fixture-session": {
            sourceServerId: "fixture-source",
            workspaceIdentity: "fixture-identity",
          },
        },
      }),
    },
    handleConnectRemote() {},
    handleCancelRemoteProject() {},
    remoteWorkspaceController: controller,
  };
  const { outputText } = ts.transpileModule(
    `${fn.getText(file)}\nconst actual = openPreparedRemoteProjectWorkspace;`,
    { compilerOptions: { target: ts.ScriptTarget.ESNext } },
  );
  return {
    run: new Function(...Object.keys(deps), `${outputText}\nreturn actual;`)(
      ...Object.values(deps),
    ),
    attached: () => attached,
    text,
  };
}
test("Root attaches a prepared remote project using the window owner and frozen membership", async () => {
  const intents = [],
    directory = { remoteProjectService: {}, projectService: {} },
    isCurrent = () => true;
  const result = await opener(directory, { dispatch: async (input) => intents.push(input) });
  await result.run({
    hostId: "fixture-source",
    workspacePath: "/fixture",
    workspaceIdentity: "fixture-identity",
    projectId: "fixture-project",
    expectedMembershipId: "fixture-member",
    isCurrent,
  });
  assert.equal(result.attached().remoteService, directory.remoteProjectService);
  assert.equal(result.attached().projectService, directory.projectService);
  assert.equal(result.attached().expectedMembershipId, "fixture-member");
  assert.equal(result.attached().findSession("fixture-identity").sourceServerId, "fixture-source");
  assert.deepEqual(intents, [
    {
      type: "open-project",
      sourceServerId: "fixture-source",
      path: "/fixture",
      remoteSessionId: "fixture-session",
      draftProjectId: "fixture-project",
      preparedWorkspaceIdentity: "fixture-identity",
      isCurrent,
    },
  ]);
  assert.match(result.text, /openRemoteProjectWorkspace:\s*openPreparedRemoteProjectWorkspace/);
  assert.match(
    result.text,
    /openMobileProjectDraft:\s*webRemoteControlWorkspaceSwitcher\?\.openProjectDraft/,
  );
});
test("prepared remote navigation rejects absent identity or window services before attaching", async () => {
  const result = await opener(undefined, {
    dispatch: async () => assert.fail("must not navigate"),
  });
  await assert.rejects(
    result.run({
      hostId: "fixture-source",
      workspacePath: "/fixture",
      projectId: "fixture-project",
    }),
    /workspace-identity-required/,
  );
  await assert.rejects(
    result.run({
      hostId: "fixture-source",
      workspacePath: "/fixture",
      workspaceIdentity: "fixture-identity",
      projectId: "fixture-project",
    }),
    /service-unavailable/,
  );
  assert.equal(result.attached(), undefined);
});
