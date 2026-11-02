import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createProjectTestFixture, assertProjectPath } from "./project-test-sandbox.mjs";
import { ZCODE_WORKSPACE_CONFIG_DIR_NAME } from "@zcode/shared";
import { createSubagentsService } from "../../packages/services/src/subagents/subagentsService.js";

test("Host prepares a real subagent snapshot and rejects reads and preparation after disposal", async () => {
  const fixture = await createProjectTestFixture("subagent-lifecycle");
  const home = await assertProjectPath(join(fixture, "home"));
  const workspacePath = await assertProjectPath(join(fixture, "workspace"));
  await mkdir(join(home, ".zcodium", "agents"), { recursive: true });
  await mkdir(join(workspacePath, ZCODE_WORKSPACE_CONFIG_DIR_NAME, "agents"), { recursive: true });
  await writeFile(
    join(workspacePath, ZCODE_WORKSPACE_CONFIG_DIR_NAME, "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: Synthetic lifecycle reviewer\n---\nReview synthetic fixtures.\n",
    { flag: "wx" },
  );
  const service = createSubagentsService({ homeDir: home });
  const workspace = { workspacePath, workspaceIdentity: "synthetic-subagent-scope" };
  try {
    await service.prepareRuntimeState(workspace);
    const snapshot = await service.readRuntimeConfig(workspace);
    assert.equal(snapshot.kind, "ready");
    if (snapshot.kind === "ready")
      assert.ok(snapshot.profiles.some((profile) => profile.name === "reviewer"));
    service.disposeAll();
    await assert.rejects(service.readRuntimeConfig(workspace), /disposed/i);
    await assert.rejects(service.prepareRuntimeState(workspace), /disposed/i);
  } finally {
    service.disposeAll();
  }
});
