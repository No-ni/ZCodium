import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const repository = resolve(import.meta.dirname, "../../..");
const reportRoot = resolve(import.meta.dirname);
const desktop = join(repository, "packages", "desktop");
const staticRoot = join(reportRoot, "runtime", "qa-local-canonical-static");
const evidencePath = join(reportRoot, "logs", "feature-inventory-local-canonical-preflight.json");
const configPath = join(reportRoot, "local-canonical-batch.json");
const auditPaths = new Set();
function bounded(candidate) {
  const target = resolve(candidate);
  const rel = relative(repository, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error("Path leaves authorized worktree");
  return target;
}
async function safePath(candidate) {
  const target = bounded(candidate);
  for (let cursor = target; cursor !== repository; cursor = dirname(cursor)) {
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || (await realpath(cursor)).toLowerCase() !== cursor.toLowerCase())
        throw new Error("Reparse/redirected path rejected");
      auditPaths.add(cursor);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const rootInfo = await lstat(repository);
  if (
    rootInfo.isSymbolicLink() ||
    (await realpath(repository)).toLowerCase() !== repository.toLowerCase()
  )
    throw new Error("Redirected worktree");
  return target;
}
async function auditTree(candidate) {
  const target = await safePath(candidate);
  const info = await lstat(target);
  if (!info.isDirectory()) return;
  for (const entry of await readdir(target, { withFileTypes: true }))
    await auditTree(join(target, entry.name));
}
async function hashSource(candidate) {
  const path = await safePath(candidate);
  const content = await readFile(path);
  return {
    path: relative(repository, path).replaceAll("\\", "/"),
    bytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}
const config = JSON.parse(await readFile(await safePath(configPath), "utf8"));
const grep = new RegExp(config.grep, "u");
const selected = [];
const excluded = [];
const hashes = [];
const fixtureDirectories = new Set();
for (const item of config.cases) {
  const specPath = await safePath(resolve(desktop, item.spec));
  const info = await lstat(specPath);
  if (!info.isFile() || !specPath.endsWith(".test.ts")) throw new Error("Invalid spec");
  hashes.push(await hashSource(specPath));
  const content = await readFile(specPath, "utf8");
  const titles = [...content.matchAll(/\bit\("([^"]+)"/gu)].map((match) => match[1]);
  const matches = titles.filter((title) => grep.test(title));
  if (JSON.stringify(matches) !== JSON.stringify(item.titles))
    throw new Error("Exact title mismatch: " + item.key);
  selected.push({ key: item.key, spec: item.spec, titles: matches, count: matches.length });
  excluded.push(
    ...titles.filter((title) => !grep.test(title)).map((title) => ({ spec: item.spec, title })),
  );
}
if (
  config.specs.length !== config.expectedSpecs ||
  selected.reduce((sum, item) => sum + item.count, 0) !== config.expectedCases ||
  excluded.length !== config.excludedTitles.length
)
  throw new Error("Unexpected selected specs/cases or excluded titles");
if (excluded.some((item) => !config.excludedTitles.includes(item.title)))
  throw new Error("Unexpected excluded title");
const aggregateFixtureIds = new Set();
const duplicateFixtureIds = [];
for (const fixture of config.replayFixtures) {
  const path = await safePath(resolve(desktop, fixture));
  const info = await lstat(path);
  if (!info.isFile() || !path.endsWith(".json")) throw new Error("Invalid fixture");
  const parsed = JSON.parse(await readFile(path, "utf8"));
  for (const item of parsed.fixtures ?? []) {
    if (aggregateFixtureIds.has(item.id)) duplicateFixtureIds.push(item.id);
    aggregateFixtureIds.add(item.id);
  }
  hashes.push(await hashSource(path));
  fixtureDirectories.add(dirname(path));
}
for (const directory of fixtureDirectories) await auditTree(directory);
if (duplicateFixtureIds.length) throw new Error("Combined finite fixture pool has duplicate IDs");
const officeFixtureRoot = join(desktop, "test/e2e/fixtures/fs/office-preview-security");
await auditTree(officeFixtureRoot);
for (const name of ["tooltip.pptx", "links.xlsx"])
  hashes.push(await hashSource(join(officeFixtureRoot, name)));
for (const relativeSource of [
  "packages/desktop/test/e2e/helpers/desktop-app.ts",
  "packages/desktop/test/e2e/helpers/e2e-runtime-paths.ts",
  "packages/desktop/test/e2e/helpers/v4-conversation.ts",
  "packages/desktop/test/e2e/helpers/e2e-electron-reload.ts",
  "packages/desktop/test/e2e/helpers/upstream-replay-fixture-resolution.ts",
  "docs/testing/qa-2026-11-06/run-menu-tests.ps1",
  "docs/testing/qa-2026-11-06/qa-project-bootstrap.cjs",
  "docs/testing/qa-2026-11-06/qa-reparse-children.ps1",
  "docs/testing/qa-2026-11-06/reload-observation.cjs",
  "docs/testing/qa-2026-11-06/qa-reload-observer.ts",
])
  hashes.push(await hashSource(join(repository, relativeSource)));
await safePath(staticRoot);
for (const directory of ["home", "tmp", "appdata", "localappdata", "cache"])
  await mkdir(await safePath(join(staticRoot, directory)), { recursive: true });
const env = {
  ...process.env,
  HOME: join(staticRoot, "home"),
  USERPROFILE: join(staticRoot, "home"),
  TEMP: join(staticRoot, "tmp"),
  TMP: join(staticRoot, "tmp"),
  TMPDIR: join(staticRoot, "tmp"),
  APPDATA: join(staticRoot, "appdata"),
  LOCALAPPDATA: join(staticRoot, "localappdata"),
  NODE_COMPILE_CACHE: join(staticRoot, "cache"),
  TSX_CACHE_DIR: join(staticRoot, "cache"),
  NODE_OPTIONS: "",
};
const checker = join(desktop, "scripts/check-e2e-fixtures.mjs");
const fixtures = await Promise.all(
  config.cases
    .filter((item) => item.fixture)
    .map(async (item) => {
      try {
        const result = await execFileAsync(process.execPath, [checker, "--spec", item.spec], {
          cwd: desktop,
          env,
          timeout: 60000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        });
        return {
          key: item.key,
          spec: item.spec,
          exitCode: 0,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      } catch (error) {
        return {
          key: item.key,
          spec: item.spec,
          exitCode: Number(error.code) || 1,
          stdout: error.stdout ?? "",
          stderr: error.stderr ?? "",
          error: error.message,
        };
      }
    }),
);
const runnerParameterEvidence = JSON.parse(
  await readFile(
    await safePath(join(reportRoot, "logs/e2e-preflight-replay-fixtures-parameter.json")),
    "utf8",
  ),
);
const plannedRunRoot = bounded(join(reportRoot, "runtime", config.runId));
const plannedHome = bounded(join(plannedRunRoot, ".e2e-home-" + config.runId));
const plannedWorkspace = bounded(join(plannedHome, "ZCodeProject"));
const writeTargets = [
  ["common app/CLI/config", join(plannedHome, ".zcodium")],
  ["MPS markdown", join(plannedWorkspace, ".zcode-e2e", "markdown-preview-selection")],
  ["SSC diagnostics", join(plannedRunRoot, "evidence", "selection-events.json")],
  ["PIA source/saved images", join(plannedWorkspace, ".zcode-e2e", "image-actions")],
  ["PIA screenshots", join(plannedRunRoot, "evidence", "image-actions")],
  ["FTS", join(plannedWorkspace, "E2E_FILE_TREE_SHARED_SEARCH")],
  ["OPS copied documents", join(plannedWorkspace, "E2E_OFFICE_SECURITY")],
  ["OPS PDF export", join(plannedRunRoot, "evidence", "office-preview-export.pdf")],
  ["TRJ model IO", join(plannedHome, ".zcodium", "cli")],
  ["SE user agents and builtin override", join(plannedHome, ".zcodium", "agents")],
  [
    "TOOLBAR legacy synthetic command before/after",
    join(plannedHome, ".zcode", "commands", "e2e-draft-catalog.md"),
  ],
  ["TSL08 moved root", join(plannedHome, "E2E_UNAVAILABLE_PROJECT-moved")],
  ["TSL08 screenshots/state and reload observer", join(plannedRunRoot, "evidence")],
  ["tool HOME/cache/temp", plannedRunRoot],
].map(([owner, target]) => ({
  owner,
  path: bounded(target),
  currentlyExists: auditPaths.has(target),
}));
for (const target of writeTargets) await safePath(target.path);
const evidence = {
  capturedAt: new Date().toISOString(),
  evidenceKind:
    "Read-only source/title/fixture/reparse preflight; no hooks, UI, build, Electron or product mutation",
  nodeVersion: process.version,
  misePinnedNode: "24.14.0",
  specCount: config.expectedSpecs,
  selectedCaseCount: config.expectedCases,
  excludedCaseCount: excluded.length,
  selected,
  excluded,
  fixtureCheckResults: fixtures,
  nonConversationFixtureChecker: [
    {
      key: "FTS",
      status: "NOT-APPLICABLE",
      reason:
        "checker supports conversation/plugin domains; selected cases do not send Provider requests",
    },
    {
      key: "OPS",
      status: "NOT-APPLICABLE",
      reason:
        "checker does not support generic pending Office domain; selected cases use local copied documents and loopback link",
    },
    {
      key: "SE",
      status: "NOT-APPLICABLE",
      reason:
        "prepareV4ConversationE2E initializes local Provider registry and model controls; selected user-scope forms do not send prompts",
    },
  ],
  fixturePathCount: config.replayFixtures.length,
  aggregateFixtureIdCount: aggregateFixtureIds.size,
  duplicateFixtureIds,
  fixtureParentTreeAudit:
    "all selected JSON parent trees and Office fixture tree checked; no symlink/redirect",
  auditedExistingPaths: auditPaths.size,
  plannedTargetsAreInsideWorktree: true,
  plannedRuntimeDoesNotExistYet: !auditPaths.has(plannedRunRoot),
  writeTargets,
  pendingRuntimeChecks: [
    "re-run reparse audit on actual run HOME/profile/temp/cache/network tree and verify child env",
    "QA root hooks/reload observer must execute and record final TSL08 PID/cause if barrier fails",
    "common-only is forbidden; explicit finite 7 fixture paths must be active",
    "CFR English synthetic Git commit excluded by root; no direct git commit selected",
    "no true clipboard API; PIA paste is synthetic ClipboardEvent and TRJ copy captures navigator.clipboard.writeText",
    "TOOLBAR completed-to-draft uses stale group DIV click helper; do not classify resulting draft timeout as product failure",
    "No OpenSidePane bootstrap for this batch; SE has its own Provider initialization and no prompts",
  ],
  sourceHashes: hashes,
  runnerParameterEvidence: {
    path: "logs/e2e-preflight-replay-fixtures-parameter.json",
    allPassed: runnerParameterEvidence.allPassed,
    sourceSha: runnerParameterEvidence.sourceSha,
  },
  allPassed:
    fixtures.every((result) => result.exitCode === 0) && runnerParameterEvidence.allPassed === true,
};
await writeFile(await safePath(evidencePath), JSON.stringify(evidence, null, 2) + "\n", "utf8");
console.log(
  JSON.stringify({
    evidencePath,
    allPassed: evidence.allPassed,
    specCount: config.expectedSpecs,
    selectedCaseCount: config.expectedCases,
    excludedCaseCount: excluded.length,
    auditedExistingPaths: auditPaths.size,
    fixtureCheckResults: fixtures.map(({ key, exitCode }) => ({ key, exitCode })),
  }),
);
if (!evidence.allPassed) process.exitCode = 1;
