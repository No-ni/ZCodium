import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const reportRoot = resolve(import.meta.dirname);
const repository = resolve(reportRoot, "../../..");
const desktop = join(repository, "packages/desktop");
const runtime = join(reportRoot, "runtime/qa-additional-local-static");
const evidencePath = join(reportRoot, "logs/feature-inventory-additional-local-preflight.json");
const audited = new Set();
async function safe(candidate) {
  const absolute = resolve(candidate);
  const rel = relative(repository, absolute);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error("Additional preflight escapes worktree");
  for (let cursor = absolute; ; cursor = dirname(cursor)) {
    try {
      const item = await lstat(cursor);
      if (item.isSymbolicLink() || (await realpath(cursor)).toLowerCase() !== cursor.toLowerCase())
        throw new Error("Additional preflight refuses reparse/redirected ancestor");
      audited.add(cursor);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (cursor.toLowerCase() === repository.toLowerCase()) break;
  }
  return absolute;
}
async function tree(candidate) {
  const absolute = await safe(candidate);
  if (!(await lstat(absolute)).isDirectory()) return;
  for (const child of await readdir(absolute)) await tree(join(absolute, child));
}
const configPath = await safe(join(reportRoot, "additional-local-batch.json"));
const config = JSON.parse(await readFile(configPath, "utf8"));
const sourceHashes = [];
async function hash(candidate) {
  const absolute = await safe(candidate);
  const content = await readFile(absolute);
  sourceHashes.push({
    path: relative(repository, absolute).replaceAll("\\", "/"),
    bytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  });
  return content.toString("utf8");
}
const selected = [];
const uniqueSpecs = new Set();
for (const run of config.runs) {
  const expression = new RegExp(run.grep, "u");
  if (!run.grep.endsWith("$")) throw new Error("Exact tail-anchor grep required");
  let selectedCount = 0;
  for (const spec of run.specs) {
    const absolute = await safe(resolve(desktop, spec));
    if (!absolute.endsWith(".test.ts") || !(await lstat(absolute)).isFile())
      throw new Error("Invalid canonical spec");
    uniqueSpecs.add(absolute);
    const content = await hash(absolute);
    const titles = [...content.matchAll(/\bit\("([^"]+)"/gu)].map((match) => match[1]);
    const matches = titles.filter((title) => expression.test(title));
    if (JSON.stringify(matches) !== JSON.stringify(run.titles))
      throw new Error("Canonical titles changed: " + run.runId);
    selectedCount += matches.length;
    selected.push({
      runId: run.runId,
      spec,
      selectedTitles: matches,
      excludedTitles: titles.filter((title) => !expression.test(title)),
    });
  }
  if (selectedCount !== run.expectedCases) throw new Error("Case count changed");
  const fixtureIds = new Set();
  for (const fixture of run.replayFixtures) {
    const absolute = await safe(resolve(desktop, fixture));
    if (!absolute.endsWith(".json") || !(await lstat(absolute)).isFile())
      throw new Error("Invalid replay fixture");
    const parsed = JSON.parse(await hash(absolute));
    for (const item of parsed.fixtures ?? []) {
      if (fixtureIds.has(item.id)) throw new Error("Duplicate fixture IDs");
      fixtureIds.add(item.id);
    }
    await tree(dirname(absolute));
  }
  const runRoot = await safe(join(reportRoot, "runtime", run.runId));
  const home = join(runRoot, ".e2e-home-" + run.runId);
  for (const target of [
    home,
    join(home, "ZCodeProject"),
    join(home, ".zcodium/v2/tasks-index.sqlite"),
    join(home, ".zcodium/cli/db/db.sqlite"),
    join(runRoot, "evidence"),
  ])
    await safe(target);
}
if (
  uniqueSpecs.size !== config.expectedSpecs ||
  selected.reduce((sum, item) => sum + item.selectedTitles.length, 0) !== config.expectedCases
)
  throw new Error("Batch count changed");
for (const name of [
  "packages/desktop/test/e2e/helpers/desktop-app.ts",
  "packages/desktop/test/e2e/helpers/conversation-session.ts",
  "packages/desktop/test/e2e/helpers/conversation-session-readonly-tool.ts",
  "packages/desktop/test/e2e/helpers/e2e-runtime-paths.ts",
  "packages/desktop/test/e2e/helpers/model-provider-restart-runtime.ts",
  "packages/desktop/test/e2e/helpers/e2e-electron-reload.ts",
  "packages/desktop/test/e2e/helpers/e2e-process-cleanup.ts",
  "packages/desktop/test/e2e/helpers/e2e-electron-storage.ts",
  "packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts",
  "packages/desktop/wdio.conf.ts",
  "docs/testing/qa-2026-11-06/run-menu-tests.ps1",
  "docs/testing/qa-2026-11-06/qa-project-bootstrap.cjs",
  "docs/testing/qa-2026-11-06/qa-reparse-children.ps1",
  "docs/testing/qa-2026-11-06/reload-observation.cjs",
  "docs/testing/qa-2026-11-06/qa-reload-observer.ts",
])
  await hash(join(repository, name));
const manifestPath = join(
  desktop,
  "test/e2e/fixtures/cases/conversation-session/conversation-session-archive-management.json",
);
const manifest = JSON.parse(await hash(manifestPath));
const noRequests =
  manifest.providerRequestPolicy === "none" &&
  manifest.noProviderRequests === true &&
  manifest.requests.length === 0;
if (!noRequests) throw new Error("Archive provider policy changed");
await safe(runtime);
const env = { ...process.env, NODE_OPTIONS: "" };
for (const name of [
  "HOME",
  "USERPROFILE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "TSX_CACHE_DIR",
  "NODE_COMPILE_CACHE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]) {
  env[name] = join(runtime, name.toLowerCase());
  await mkdir(await safe(env[name]), { recursive: true });
}
const checker = await safe(join(desktop, "scripts/check-e2e-fixtures.mjs"));
let archiveFixtureCheck;
try {
  const result = await execFileAsync(
    process.execPath,
    [checker, "--spec", config.runs[0].specs[0]],
    { cwd: desktop, env, timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true },
  );
  archiveFixtureCheck = { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
} catch (error) {
  archiveFixtureCheck = {
    exitCode: Number(error.code) || 1,
    stdout: error.stdout ?? "",
    stderr: error.stderr ?? "",
  };
}
const evidence = {
  capturedAt: new Date().toISOString(),
  node: process.version,
  evidenceKind:
    "Read-only canonical titles/source/fixture and bounded path audit; archive JSON checker only. No UI/build/spec import/hook invocation.",
  expectedSpecs: config.expectedSpecs,
  expectedCases: config.expectedCases,
  selected,
  archiveNoProviderRequests: noRequests,
  archiveFixtureCheck,
  browserFixtureCheck: {
    status: "NOT-APPLICABLE",
    reason:
      "Browser domain not supported by conversation checker; skipProvider/about:blank/no prompt reviewed from source",
  },
  auditedExistingPaths: audited.size,
  sourceHashes,
  pendingRuntimeChecks: [
    "Actual run environment and all descendant reparse points must pass wrapper guard again",
    "Archive seed must follow successful old-process exit barrier",
    "Browser initial pane is prepared only for its own run",
    "No real clipboard, external URL, SSH, devices or git commit selected",
    "Actual attempts remain unrun until root reports NDJSON/summary",
  ],
  allPassed: archiveFixtureCheck.exitCode === 0,
};
await writeFile(await safe(evidencePath), JSON.stringify(evidence, null, 2) + "\n");
if (evidence.allPassed) {
  config.status = "READY_AFTER_STATIC_PREFLIGHT_UI_UNRUN";
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
}
console.log(
  JSON.stringify({
    evidencePath,
    allPassed: evidence.allPassed,
    expectedSpecs: config.expectedSpecs,
    expectedCases: config.expectedCases,
    auditedExistingPaths: audited.size,
    fixtureExitCode: archiveFixtureCheck.exitCode,
  }),
);
if (!evidence.allPassed) process.exitCode = 1;
