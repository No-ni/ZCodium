// MRO02 当前服务证据；真实 MobileApp/bridge 交互另由 mobile/LAN smoke 验证。
import assert from "node:assert/strict";
import test from "node:test";
import { ServiceChannels } from "@zcode/shared";
import { createProjectTestSandbox } from "../../../../../../../../scripts/ci/project-test-sandbox.mjs";
import { createProjectDirectoryFixture } from "./remote-project-directory.fixture.mjs";

test("window directory keeps local, pinned and retained remote projects while Source owns its full tree", async () => {
  const sandbox = await createProjectTestSandbox("current-project-directory");
  const fixture = await createProjectDirectoryFixture(sandbox.root);
  try {
    const window = fixture.channels(false).responses,
      source = fixture.channels(true).responses;
    const readDirectory = `${ServiceChannels.RemoteProjects}:readDirectory`;
    const readTree = `${ServiceChannels.Project}:readTree`;
    const tree = await window[readTree]();
    assert.deepEqual(
      tree.projects.map((project) => project.id),
      [fixture.local.id],
    );
    assert.equal(tree.tasks.find((task) => task.taskId === "PINNED_TASK").pinned, true);
    const directory = await window[readDirectory]();
    assert.deepEqual(
      directory.entries.map((entry) => entry.projectId),
      [fixture.remote.id],
    );
    assert.deepEqual(
      new Set((await source[readTree]()).projects.map((project) => project.id)),
      new Set([fixture.remote.id, fixture.hidden.id]),
    );
    assert.deepEqual(await source[readDirectory](), { hosts: [], entries: [] });
    const remote = await fixture.windowProject.prepareSession({
      hostId: fixture.hostId,
      projectId: fixture.remote.id,
    });
    assert.equal(remote.workspacePath, fixture.remotePath);
    assert.equal(remote.workspaceIdentity, fixture.identity);
    await window[`${ServiceChannels.Project}:saveProject`]({
      id: fixture.local.id,
      name: "E2E_MRO02_LOCAL_RENAMED",
      pinned: true,
    });
    const updated = (await window[readTree]()).projects.find(
      (project) => project.id === fixture.local.id,
    );
    assert.equal(updated.name, "E2E_MRO02_LOCAL_RENAMED");
    assert.equal(updated.pinned, true);
    assert.equal(fixture.traffic.calls.at(-1).owner, "window");
    assert.equal(
      (await source[readTree]()).projects.find((project) => project.id === fixture.remote.id).name,
      fixture.remote.name,
    );
  } finally {
    fixture.dispose();
  }
});
