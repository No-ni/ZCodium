import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  captureWorkspaceSources,
  withE2ESourceEvidence,
} from "../../packages/desktop/test/e2e/reporting/e2e-source-evidence.ts";
import { assertProjectPath } from "./project-test-sandbox.mjs";

const execute = promisify(execFile);
const tracked = "packages/web/src/mobile/tracked.ts";
const untracked = "packages/web/src/mobile/untracked.tsx";

async function fixture() {
  const root = await assertProjectPath(
    await mkdtemp(join(await assertProjectPath(process.env.TEMP), "e2e-source-evidence-")),
  );
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };
  await execute("git", ["init", "--quiet", root], { env });
  await mkdir(join(root, "packages/web/src/mobile"), { recursive: true });
  await writeFile(join(root, tracked), "export const tracked = true;\n");
  await execute("git", ["add", "--", tracked], { cwd: root, env });
  await writeFile(join(root, untracked), "export const untracked = true;\n");
  return root;
}

test("source evidence hashes both tracked and new workspace source files", async () => {
  const root = await fixture();
  await writeFile(join(root, "packages/web/src/mobile/config.json"), "{}\n");
  const sources = await captureWorkspaceSources(root);
  assert.deepEqual(Object.keys(sources), [tracked, untracked]);
  for (const fingerprint of Object.values(sources)) assert.match(fingerprint, /^[a-f0-9]{64}$/u);
});

test("source evidence omits a deleted tracked file still present in the Git index", async () => {
  const root = await fixture();
  await unlink(join(root, tracked));
  const sources = await captureWorkspaceSources(root);
  assert.deepEqual(Object.keys(sources), [untracked]);
});

test("deleting an input during the build records a changed source instead of fresh-stable", async () => {
  const root = await fixture();
  const appOutputDir = join(root, "output");
  const artifactDir = join(root, "artifacts");
  const evidence = await withE2ESourceEvidence({
    freshBuild: true,
    captureSources: () => captureWorkspaceSources(root),
    async build() {
      await unlink(join(root, tracked));
      await mkdir(appOutputDir);
      await writeFile(join(appOutputDir, "index.js"), "export const built = true;\n");
    },
    appOutputDir,
    artifactDir,
  });
  assert.equal(evidence.status, "source-changed-during-build");
  assert.deepEqual(evidence.changedFiles, [tracked]);
  assert.deepEqual(Object.keys(evidence.sources), [untracked]);
  const saved = JSON.parse(await readFile(join(artifactDir, "build-source-evidence.json"), "utf8"));
  assert.deepEqual(saved.changedFiles, [tracked]);
});

test("source evidence still rejects a non-ENOENT source read error", async () => {
  const root = await fixture();
  await unlink(join(root, tracked));
  await mkdir(join(root, tracked));
  await assert.rejects(
    () => captureWorkspaceSources(root),
    (error) => ["EISDIR", "EPERM", "EACCES"].includes(error.code),
  );
});
