import { readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { resolve, dirname, parse, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '../../../..');
async function safePath(candidate) {
  const path = resolve(candidate);
  const rel = relative(root, path);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Outside worktree');
  for (let current = path; ; current = dirname(current)) {
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Linked evidence');
      if ((await realpath(current)).toLowerCase() !== current.toLowerCase()) throw new Error('Redirected evidence');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current === parse(current).root) break;
  }
}
const input = resolve(import.meta.dirname, 'validation-e2e-counts-033.json');
const target = resolve(import.meta.dirname, 'validation-e2e-final-summary.json');
await safePath(input);
await safePath(target);
const raw = await readFile(input, 'utf8');
const counts = JSON.parse(raw);
function summarize(records) {
  return { unique: records.length, passed: records.filter(item => item.outcome === 'passed').length, failed: records.filter(item => item.outcome === 'failed').length, skipped: records.filter(item => item.outcome === 'skipped').length };
}
const canonical = counts.latest.filter(item => item.file.startsWith('packages/desktop/test/e2e/') && !item.file.includes('/manual-review/pending/'));
const pending = counts.latest.filter(item => item.file.startsWith('packages/desktop/test/e2e/') && item.file.includes('/manual-review/pending/'));
const external = counts.latest.filter(item => item.file.startsWith('docs/testing/qa-2026-11-06/'));
if (canonical.length + pending.length + external.length !== counts.unique) throw new Error('Layer partition mismatch');
const completedRecords = counts.records.filter(item => item.run !== 'qa-menu-20261106-core');
const completedRuns = counts.runs.filter(item => item.run !== 'qa-menu-20261106-core');
const output = {
  capturedAt: new Date().toISOString(), input: relative(root, input).replaceAll('\\', '/'), inputSha256: createHash('sha256').update(raw).digest('hex'),
  unique: counts.unique, uniqueExecuted: counts.uniqueExecuted, latestExecuted: counts.latestExecuted, attempts: counts.attempts, executedAttempts: counts.executedAttempts,
  latest: { passed: counts.latestPassed, failed: counts.latestFailed, skipped: counts.latestSkipped },
  attemptsByOutcome: { passed: counts.attemptPassed, failed: counts.attemptFailed, skipped: counts.attemptSkipped },
  layers: { canonical: summarize(canonical), repositoryPending: summarize(pending), externalQa: summarize(external) },
  completedNonCancelled: { runsWithCaseRecords: completedRuns.length, attempts: completedRecords.length, passed: completedRecords.filter(item => item.outcome === 'passed').length, failed: completedRecords.filter(item => item.outcome === 'failed').length, skipped: completedRecords.filter(item => item.outcome === 'skipped').length },
  cancelledPartial: { run: 'qa-menu-20261106-core', attempts: counts.records.length - completedRecords.length, scope: 'One real VP30 PASS preserved; same case later rerun, not a new unique case and not a completed batch.' },
  zeroCaseBoundary: 'No-case config/build/hook failures are execution-history entries, not invented PASS/FAIL/SKIP cases. BLOCKED describes unreached actions or prerequisite guards; no separate blocked count is available from reporter NDJSON.',
  confirmedFindings: { total: 8, product: 6, deterministicTestGate: 2, runtimePinCandidate: 1, runtimePinCandidateIncludedInConfirmedTotal: false },
  deterministicTests: { unique: 133, passed: 131, failed: 2, attemptsIncludingIndependentReproductions: 138, reproductionAttempts: 5, reproductionPassed: 3, reproductionFailed: 2 },
  actualRuns: counts.runs,
  latestSkipped: counts.latest.filter(item => item.outcome === 'skipped').map(({file, fullTitle, run, classificationSource}) => ({file, fullTitle, run, classificationSource})),
};
await writeFile(target, JSON.stringify(output, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ unique: output.unique, attempts: output.attempts, latest: output.latest, layers: output.layers, completedNonCancelled: output.completedNonCancelled }));
