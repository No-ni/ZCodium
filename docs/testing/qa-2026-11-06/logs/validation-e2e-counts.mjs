import { readFile, readdir, lstat, realpath, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname, parse, isAbsolute, join } from 'node:path';
import { classifyResult } from './validation-e2e-result-classification.mjs';

const root = resolve(import.meta.dirname, '../../../..');
const reportRoot = resolve(import.meta.dirname, '..');
const runtime = join(reportRoot, 'runtime');
const outputName = process.argv[2] ?? 'validation-e2e-counts-live.json';
if (!/^validation-e2e-counts-[a-z0-9-]+\.json$/u.test(outputName)) throw new Error('Invalid QA evidence filename');
async function safePath(candidate) {
  const absolute = resolve(candidate);
  const rel = relative(root, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Evidence path outside authorized worktree');
  for (let cursor = absolute; ; cursor = dirname(cursor)) {
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Linked evidence path');
      if ((await realpath(cursor)).toLowerCase() !== cursor.toLowerCase()) throw new Error('Redirected evidence path');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (cursor === parse(cursor).root) break;
  }
}
await safePath(runtime);
const runs = [];
const records = [];
for (const entry of await readdir(runtime, { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^qa-menu-20261106-/u.test(entry.name)) continue;
  const input = join(runtime, entry.name, 'evidence', 'test-results.ndjson');
  await safePath(input);
  let raw;
  try { raw = await readFile(input, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  const current = [];
  let incompleteTrailingRecord = false;
  const lines = raw.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    let parsed;
    try { parsed = JSON.parse(lines[index]); }
    catch (error) {
      if (index === lines.length - 1) { incompleteTrailingRecord = true; break; }
      throw error;
    }
    if (typeof parsed.passed !== 'boolean' || typeof parsed.file !== 'string' || typeof parsed.fullTitle !== 'string' || !Number.isFinite(Date.parse(parsed.capturedAt))) throw new Error('Invalid case record');
    await safePath(parsed.file);
    const file = relative(root, parsed.file).replaceAll('\\', '/');
    current.push({ run: entry.name, line: index + 1, file, key: `${file.toLowerCase()}|${parsed.fullTitle}`, fullTitle: parsed.fullTitle, capturedAt: parsed.capturedAt, passed: parsed.passed, status: parsed.status ?? null, ...classifyResult(parsed), retryIndex: parsed.retryIndex, error: parsed.error ?? null });
  }
  const exitPath = join(import.meta.dirname, `e2e-${entry.name}.log.exit-code.txt`);
  await safePath(exitPath);
  let exitCode = null;
  try {
    const rawExit = (await readFile(exitPath, 'utf8')).trim();
    if (/^-?\d+$/u.test(rawExit)) exitCode = Number(rawExit);
  }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  runs.push({ run: entry.name, source: relative(reportRoot, input).replaceAll('\\', '/'), exitCode, completionEvidence: exitCode === null ? 'no exit-code file; running or externally canceled, consult report' : 'exit-code file present', attempts: current.length, executed: current.filter(item => item.outcome !== 'skipped').length, passed: current.filter(item => item.outcome === 'passed').length, failed: current.filter(item => item.outcome === 'failed').length, skipped: current.filter(item => item.outcome === 'skipped').length, incompleteTrailingRecord });
  records.push(...current);
}
records.sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt) || a.line - b.line);
const latest = new Map(records.map(item => [item.key, item]));
const output = { capturedAt: new Date().toISOString(), scope: 'All actual NDJSON records, including running/canceled runs; no-case startup/config/hook failures excluded; latest per case identity; skipped/pending separate per current summary contract, including its legacy empty-error compatibility; uniqueExecuted counts any executed attempt, latestExecuted counts latest non-skip outcome', runs, unique: latest.size, uniqueExecuted: new Set(records.filter(item => item.outcome !== 'skipped').map(item => item.key)).size, latestExecuted: [...latest.values()].filter(item => item.outcome !== 'skipped').length, attempts: records.length, executedAttempts: records.filter(item => item.outcome !== 'skipped').length, latestPassed: [...latest.values()].filter(item => item.outcome === 'passed').length, latestFailed: [...latest.values()].filter(item => item.outcome === 'failed').length, latestSkipped: [...latest.values()].filter(item => item.outcome === 'skipped').length, attemptPassed: records.filter(item => item.outcome === 'passed').length, attemptFailed: records.filter(item => item.outcome === 'failed').length, attemptSkipped: records.filter(item => item.outcome === 'skipped').length, latest: [...latest.values()], records };
const target = join(import.meta.dirname, outputName);
await safePath(target);
await writeFile(target, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ...output, latest: undefined, records: undefined }));
