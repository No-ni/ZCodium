import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';

const repository = resolve(import.meta.dirname, '../../../..');
const reportRoot = resolve(import.meta.dirname, '..');
async function safe(candidate) {
  const absolute = resolve(candidate);
  const rel = relative(repository, absolute);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Attribution path leaves worktree');
  for (let cursor = absolute; ; cursor = dirname(cursor)) {
    try {
      if ((await lstat(cursor)).isSymbolicLink() || (await realpath(cursor)).toLowerCase() !== cursor.toLowerCase()) throw new Error('Attribution refuses redirected ancestors');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (cursor === parse(cursor).root) break;
  }
  return absolute;
}
const stem = 'runtime/qa-menu-20261106-local-supplement/evidence/qa-residual-local-menus-0-3-25872-1793991442433/003-RLM04';
async function fingerprint(path, base = reportRoot) {
  const content = await readFile(await safe(join(base, path)));
  return { path: relative(reportRoot, join(base, path)).replaceAll('\\', '/'), bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') };
}
const actual = JSON.parse(await readFile(await safe(join(reportRoot, stem + '.json')), 'utf8'));
const evidence = {
  capturedAt: new Date().toISOString(),
  evidenceKind: 'Read-only attribution of existing UI evidence and current source; no new UI, probe, process scan or test count',
  classification: 'BUG-008 P2: distinct Settings command IDs project to identical cmdk value, producing two visible selected rows',
  sourceEvidence: [await fingerprint('packages/ui/src/command-center/CommandCenterDialog.tsx', repository), await fingerprint('packages/ui/src/quickpick/quickPickCommands.ts', repository), await fingerprint('packages/ui/src/components/ui/command.tsx', repository), await fingerprint('node_modules/cmdk/dist/index.mjs', repository)],
  actualEvidence: [await fingerprint(stem + '.json'), await fingerprint(stem + '.png')],
  actual: { capturedAt: actual.capturedAt, query: actual.state.centerQuery, visiblePickerCount: actual.state.pickerCount, scope: actual.state.menus.find(item => item.selected === 'true')?.text, selectedQuery: '[role="dialog"] [cmdk-item][aria-selected="true"]', selectedCount: 2, distinctSelectedElementSuffixesFromActualError: ['e.83', 'e.84'], screenshotReviewed: true, screenshotObservation: 'One open dialog; Settings under both Suggested and Configure visibly share selected gray background', providerRequests: actual.providerRequestCount, dpr: actual.state.dpr },
  sourceChain: { renderer: { file: 'packages/ui/src/command-center/CommandCenterDialog.tsx', line: 793, identity: 'value uses title and joined keywords; React key command.id does not make cmdk value unique' }, options: { file: 'packages/ui/src/quickpick/quickPickCommands.ts', lines: [113,190], ids: ['suggested-settings','settings'], sameTitleId: 'quickPick.command.settings', sameKeywords: ['settings','preferences','配置','设置'] }, installedCmdk: { file: 'node_modules/cmdk/dist/index.mjs', line: 1, selection: 'Each Item compares the shared selected value with its own value; equal values set both aria-selected and data-selected true' }, style: { file: 'packages/ui/src/components/ui/command.tsx', line: 153, consumer: 'data-selected drives selected background' } },
  limits: 'Only repeated selected markers and visual keyboard selection are confirmed. Test stopped before Enter/settings action; no claim of duplicate execution. RLM07 shares same run/source and is supporting evidence, not an independent clean reproduction. No generic hidden-DOM count explanation: screenshot contains both rows in one open dialog.',
};
await writeFile(await safe(join(import.meta.dirname, 'validation-command-center-selected-attribution.json')), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ classification: evidence.classification, selectedCount: evidence.actual.selectedCount, scope: evidence.actual.scope, query: evidence.actual.query, bytes: evidence.actualEvidence.map(item => item.bytes) }));
