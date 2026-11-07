import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';

const repository = resolve(import.meta.dirname, '../../../..');
const reportRoot = resolve(import.meta.dirname, '..');
const runId = 'qa-menu-20261106-grp-pin-grouped';
async function safe(candidate) {
  const absolute = resolve(candidate);
  const rel = relative(repository, absolute);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Grouped readiness path leaves worktree');
  for (let cursor = absolute; ; cursor = dirname(cursor)) {
    try {
      if ((await lstat(cursor)).isSymbolicLink() || (await realpath(cursor)).toLowerCase() !== cursor.toLowerCase()) throw new Error('Grouped readiness refuses redirected ancestors');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (cursor === parse(cursor).root) break;
  }
  return absolute;
}
const targets = {
  runtime: join(reportRoot, 'runtime', runId),
  stagedApp: join(repository, 'packages/desktop/.e2e-cache', runId, 'app'),
  exitEvidence: join(import.meta.dirname, `e2e-${runId}.log.exit-code.txt`),
};
const exists = {};
for (const [name, path] of Object.entries(targets)) {
  await safe(path);
  try { await lstat(path); exists[name] = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; exists[name] = false; }
}
if (Object.values(exists).some(Boolean)) throw new Error('Fixed grouped run is not new; readiness refused');
const source = await readFile(await safe(join(reportRoot, 'grp-pin-process-sampler.mjs')));
const evidence = { capturedAt: new Date().toISOString(), evidenceKind: 'Read-only fixed grouped readiness; no sampler, process scan, target runtime creation or UI', runId, exists, samplerSha256: createHash('sha256').update(source).digest('hex'), ancestorAndReparseChecks: true, command: 'node .run-logs/qa-2026-11-06/validation/run-validation.mjs grp-pin-sampler-grouped', order: 'Sampler start confirmed before root wrapper; do not create runtime or staged app first' };
await writeFile(await safe(join(import.meta.dirname, 'validation-grp-pin-sampler-prelaunch-grouped-evidence.json')), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(evidence));
