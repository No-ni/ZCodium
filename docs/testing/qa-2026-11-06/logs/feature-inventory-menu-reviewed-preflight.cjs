"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
(async () => {
  const repository = path.resolve(__dirname, "../../../..");
  const qa = path.resolve(__dirname, "..");
  const desktop = path.join(repository, "packages/desktop");
  const audited = new Set();
  async function safe(candidate) {
    const absolute = path.resolve(candidate);
    const rel = path.relative(repository, absolute);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Review preflight escapes worktree");
    for (let cursor = absolute; ; cursor = path.dirname(cursor)) {
      try {
        const item = await fs.lstat(cursor);
        if (item.isSymbolicLink() || (await fs.realpath(cursor)).toLowerCase() !== cursor.toLowerCase()) throw new Error("Review preflight rejects reparse/redirect");
        audited.add(cursor);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (cursor.toLowerCase() === repository.toLowerCase()) break;
    }
    return absolute;
  }
  async function tree(candidate) {
    const absolute = await safe(candidate);
    if (!(await fs.lstat(absolute)).isDirectory()) return;
    for (const child of await fs.readdir(absolute)) await tree(path.join(absolute, child));
  }
  const planPath = await safe(path.join(qa, "test-plan-menu-reviewed.md"));
  const plan = await fs.readFile(planPath, "utf8");
  const command = plan.match(/& \.\\docs\\testing[^\r\n]+/u)?.[0];
  if (!command) throw new Error("Missing proposed invocation");
  const grepText = command.match(/-Grep '([^']+)'/u)?.[1];
  const replayText = command.match(/-ReplayFixtures '([^']+)'/u)?.[1];
  if (!grepText || !replayText || !command.includes("-Bootstrap") || !command.includes("-SafeTerminal") || command.includes("-OpenSidePane")) throw new Error("Invocation scope changed");
  const specs = [...plan.matchAll(/^\s*'((?:\.\.\/|\.\/)[^']+\.test\.ts)'/gmu)].map((match) => match[1]);
  const grep = new RegExp(grepText, "u");
  const selected = [];
  const hashes = [];
  for (const relativeSpec of specs) {
    const absolute = await safe(path.resolve(desktop, relativeSpec));
    const source = await fs.readFile(absolute, "utf8");
    const titles = [...source.matchAll(/\bit\("([^"]+)"/gu)].map((match) => match[1]);
    selected.push({ spec: relativeSpec, selectedTitles: titles.filter((title) => grep.test(title)), excludedTitles: titles.filter((title) => !grep.test(title)) });
    hashes.push({ path: path.relative(repository, absolute).replaceAll("\\", "/"), sha256: createHash("sha256").update(source).digest("hex") });
  }
  const counts = selected.map((item) => item.selectedTitles.length);
  const expectedCounts = [12, 13, 15, 2, 5];
  if (JSON.stringify(counts) !== JSON.stringify(expectedCounts) || specs.length !== 5) throw new Error("Expected exact QLA12/RLM13/SLM15/SPFV2/ARM5");
  const replayFixtures = replayText.split(",");
  const expectedReplay = ["./test/e2e/fixtures/upstream/common.json", "./test/e2e/fixtures/upstream/conversation-session/conversation-session-archive-management.json"];
  if (JSON.stringify(replayFixtures) !== JSON.stringify(expectedReplay)) throw new Error("Finite replay input changed");
  const fixtureIds = new Set();
  const fixtureDetails = [];
  for (const fixture of replayFixtures) {
    const absolute = await safe(path.resolve(desktop, fixture));
    const source = await fs.readFile(absolute, "utf8");
    const parsed = JSON.parse(source);
    for (const item of parsed.fixtures) {
      if (fixtureIds.has(item.id)) throw new Error("Duplicate fixture ID");
      fixtureIds.add(item.id);
    }
    await tree(path.dirname(absolute));
    fixtureDetails.push({ path: fixture, fixtureCount: parsed.fixtures.length, sha256: createHash("sha256").update(source).digest("hex") });
  }
  const runnerPath = await safe(path.join(qa, "run-menu-tests.ps1"));
  const runner = await fs.readFile(runnerPath, "utf8");
  const defaultIndex = runner.indexOf("if ($Specs.Replace('\\', '/').Contains('/manual-review/'))");
  const explicitIndex = runner.indexOf("if ($qaReviewedReplayFixtures.Count)");
  const explicitOverrideAfterPendingDefault = defaultIndex >= 0 && explicitIndex > defaultIndex && runner.slice(explicitIndex).includes("$env:E2E_PROVIDER_REPLAY_FIXTURE_PATH = $qaReviewedReplayFixtures -join ','");
  if (!explicitOverrideAfterPendingDefault) throw new Error("Pending common override no longer followed by explicit finite list");
  const hookPath = await safe(path.join(qa, "qa-project-bootstrap.cjs"));
  const evidence = {
    capturedAt: new Date().toISOString(), node: process.version,
    evidenceKind: "Read-only plan/spec title registration, finite replay JSON and runner ordering audit. No spec import/UI/build/hooks.",
    planSourceSha256: createHash("sha256").update(plan).digest("hex"), runnerSourceSha256: createHash("sha256").update(runner).digest("hex"),
    hookSourceSha256: createHash("sha256").update(await fs.readFile(hookPath)).digest("hex"),
    expectedSpecs: 5, plannedCases: counts.reduce((sum, value) => sum + value, 0), expectedCounts, selected, hashes,
    grep: grepText, replayFixtures: fixtureDetails, explicitOverrideAfterPendingDefault,
    commonFixtureIsNotEmpty: fixtureDetails[0].fixtureCount > 0,
    commonBoundary: "Common contains an existing synthetic readonly Read reply; selected no-prompt menus/SPFV/archive do not invoke it. Not an empty JSON and not UI execution evidence.",
    archiveExitObserverBoundary: "Archive reload occurs suite beforeAll, before root beforeEach observer installation; retain formal exit barrier, do not claim independent PID JSON unless present.",
    auditedExistingPaths: audited.size, allPassed: true,
  };
  const target = await safe(path.join(__dirname, "feature-inventory-menu-reviewed-preflight.json"));
  await fs.writeFile(target, JSON.stringify(evidence, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ target, plannedCases: evidence.plannedCases, counts, explicitOverrideAfterPendingDefault, auditedExistingPaths: audited.size, allPassed: true }) + "\n");
})().catch((error) => { process.stderr.write(error.stack + "\n"); process.exitCode = 1; });
