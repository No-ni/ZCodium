import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { createProjectTestSandbox } from "./project-test-sandbox.mjs";
import { resolveGenUiOutputDirectory } from "../../apps/zcode-cli/packages/core/src/runtime/helpers/gen-ui-output.ts";
import { buildChildEnvironmentUpdate } from "../../apps/zcode-cli/packages/core/src/runtime/methods/context-refresh.ts";

test("fork announcement uses the real child runtime output identity while declaring child cwd", async () => {
  const sandbox = await createProjectTestSandbox("worktree-gen-ui");
  const workspace = join(sandbox.root, "project"),
    childCwd = join(sandbox.root, "worktree"),
    output = join(sandbox.root, "outputs");
  const parent = {
    config: {
      presentationSurface: "zcode_desktop",
      genUiOutputRoot: output,
      workspacePath: workspace,
    },
    workspaceScopeRoot: workspace,
    workspaceRoot: workspace,
    sessionId: "parent",
    latestContextBuildResult: { sections: [{ source: "desktop_context" }] },
  };
  const child = { ...parent, workspaceRoot: childCwd, sessionId: "child" };
  const previous = {
    cwd: workspace,
    platform: "win32",
    shell: "powershell",
    osVersion: "fixture",
    isGitRepository: true,
    additionalWorkingDirectories: [],
    desktopContext: true,
    visualizationDirectory: resolveGenUiOutputDirectory(parent),
  };
  const update = buildChildEnvironmentUpdate(parent, previous, "child", true, childCwd);
  assert.ok(update);
  assert.ok(update.content.includes(childCwd));
  assert.ok(update.content.includes(resolveGenUiOutputDirectory(child)));
  assert.notEqual(resolveGenUiOutputDirectory(child), resolveGenUiOutputDirectory(parent));
  assert.equal(parent.config.workspacePath, workspace);
});
