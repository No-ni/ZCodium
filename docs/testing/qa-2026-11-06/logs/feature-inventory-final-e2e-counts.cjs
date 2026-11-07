const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const qa = path.resolve(__dirname, '..');
const root = path.resolve(qa, '../../..');
const baseFile = path.join(__dirname, 'validation-e2e-counts-032.json');
const run = 'qa-menu-20261106-copy-history-final';
const resultFile = path.join(qa, 'runtime', run, 'evidence/test-results.ndjson');
const summaryFile = path.join(qa, 'runtime', run, 'evidence/summary.json');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const base = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
if (summary.exitCode !== 1 || summary.completedAt !== '2026-11-06T20:31:06.809Z') throw new Error('Final summary differs');
const raw = fs.readFileSync(resultFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
if (raw.length !== 3 || base.attempts !== 247 || base.unique !== 188) throw new Error('Unexpected input counts');
const knownKeys = new Set(base.latest.map(record => record.key));
const additions = raw.map((record, index) => {
  const file = path.relative(root, record.file).split(path.sep).join('/');
  const fullTitle = record.fullTitle || record.title;
  const key = `${file}|${fullTitle}`;
  if (!knownKeys.has(key) || record.status || (record.passed !== true && !record.error)) throw new Error('Unmatched identity or ambiguous skip classification');
  return { run, line: index + 1, file, key, fullTitle, capturedAt: record.capturedAt, outcome: record.passed ? 'passed' : 'failed', classificationSource: 'final no-skip case with passed boolean/error; summary corroborates' };
});
const records = [...base.records, ...additions];
const latest = new Map();
for (const record of records) {
  const previous = latest.get(record.key);
  if (!previous || Date.parse(record.capturedAt) >= Date.parse(previous.capturedAt)) latest.set(record.key, record);
}
const current = [...latest.values()];
const count = (rows, outcome) => rows.filter(record => record.outcome === outcome).length;
const result = {
  capturedAt: new Date().toISOString(),
  evidenceKind: 'Read-only independent merge of classified validation counts032 and three final NDJSON cases; no UI, no reclassification of prior skipped cases',
  sources: [baseFile, resultFile, summaryFile].map(file => ({ file, sha256: hash(file) })),
  finalRun: { run, completedAt: summary.completedAt, exitCode: summary.exitCode, actual: additions.length, passed: count(additions, 'passed'), failed: count(additions, 'failed'), skipped: count(additions, 'skipped') },
  unique: latest.size,
  uniqueExecuted: new Set(records.filter(record => record.outcome !== 'skipped').map(record => record.key)).size,
  attempts: records.length,
  executedAttempts: records.filter(record => record.outcome !== 'skipped').length,
  latestPassed: count(current, 'passed'), latestFailed: count(current, 'failed'), latestSkipped: count(current, 'skipped'),
  attemptPassed: count(records, 'passed'), attemptFailed: count(records, 'failed'), attemptSkipped: count(records, 'skipped'),
  scopeBoundary: 'Includes canceled core VP30 once as baseline counts032 did; unique identity remains file+fullTitle; menu functional groups are not case identities or fully passed groups.',
  additions,
};
if (result.unique !== 188 || result.attempts !== 250 || result.latestPassed + result.latestFailed + result.latestSkipped !== result.unique || result.attemptPassed + result.attemptFailed + result.attemptSkipped !== result.attempts) throw new Error('Final identity/count invariant failed');
fs.writeFileSync(path.join(__dirname, 'feature-inventory-final-e2e-counts.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
