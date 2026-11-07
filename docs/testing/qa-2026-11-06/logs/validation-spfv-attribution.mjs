import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const report = resolve(import.meta.dirname, '..');
async function safe(candidate) {
  const absolute = resolve(candidate);
  const rel = relative(root, absolute);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Attribution path outside worktree');
  for (let cursor = absolute; ; cursor = dirname(cursor)) {
    try {
      if ((await lstat(cursor)).isSymbolicLink() || (await realpath(cursor)).toLowerCase() !== cursor.toLowerCase()) throw new Error('Attribution refuses redirected path');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (cursor === parse(cursor).root) break;
  }
  return absolute;
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const stems = ['qa-spfv-observe-0-3-001-5628-1793990174199', 'qa-spfv-observe-0-3-001-5628-1793990181593'];
const observations = [];
const brief = node => node && ({ tag: node.tag, testId: node.testId, rect: node.rect, dataset: node.dataset, display: node.computed?.display });
for (const stem of stems) {
  const rel = `runtime/qa-menu-20261106-menu-reviewed/evidence/${stem}.json`;
  const path = await safe(join(report, rel));
  const raw = await readFile(path);
  const input = JSON.parse(raw.toString('utf8'));
  if (!input.dom || input.worker !== '0-3' || input.counter !== 1 || !input.test?.title?.startsWith('SPFV-E2E-002')) throw new Error('SPFV loaded evidence identity mismatch');
  const dom = input.dom;
  const toolbar = dom.toolbars?.find(node => node.withinObservedHost && node.className?.includes('group/toolbar'));
  const toolbarNodes = [...(toolbar?.descendants ?? []), ...(toolbar?.modelTextSpans ?? [])];
  const labels = toolbarNodes.filter(node => node.className?.includes('group-data-[composer-model-icon=true]/toolbar:hidden'));
  const icons = toolbarNodes.filter(node => node.className?.includes('group-data-[composer-model-icon=true]/toolbar:inline-flex') || node.className?.includes('group-data-[composer-model-icon=true]/toolbar:block'));
  const meters = toolbarNodes.filter(node => node.testId === 'composer-thought-meter');
  const pngPath = await safe(path.replace(/\.json$/u, '.png'));
  const png = await readFile(pngPath);
  observations.push({ file: rel, bytes: raw.length, sha256: sha(raw), png: rel.replace(/\.json$/u, '.png'), pngSha256: sha(png), capturedAt: input.capturedAt, test: input.test, observerSourceSha256: input.observerSourceSha256, hookSourceSha256: input.hookSourceSha256, viewport: dom.viewport, dpr: dom.dpr, host: brief(dom.host), shell: brief(dom.shell), toolbar: brief(toolbar), model: brief(dom.model), labels: labels.map(brief), icons: icons.map(brief), thoughtMeters: meters.map(brief), editor: brief(dom.editor), plus: brief(dom.action), send: brief(dom.send), finiteAnimationCount: dom.finiteAnimations?.length ?? null });
}
const sourceFiles = ['packages/ui/src/prompt-editor/ChatPromptEditor.tsx', 'packages/ui/src/prompt-editor/useComposerToolbarFit.ts', 'packages/ui/src/v4/composer/V4ComposerToolbar.tsx', 'docs/ui/side-pane-full-view.md'];
const sources = [];
for (const file of sourceFiles) sources.push({ file, sha256: sha(await readFile(await safe(join(root, file)))) });
const result = { capturedAt: new Date().toISOString(), evidenceKind: 'Readonly compression of existing actual DOM/PNG and source; no new UI, probe, process scan or test count', classification: 'BUG-007 P2: inline composer compact dataset is written to outer shell while model CSS consumes inner named toolbar group', distinctFromBug006: 'Inline iconOnly bypasses the clone measurement path and actually produces composerModelIcon=true; failure is flag owner/CSS consumer mismatch', uniqueReproductionsInThisEvidence: 1, duplicateAfterEachNotIndependentRepro: true, observations, sources, causalSource: { refBindings: 'ChatPromptEditor.tsx:433 and 470 use the same toolbarRef', inlineMode: 'ChatPromptEditor.tsx:181-182 passes iconOnly=true; useComposerToolbarFit.ts:79-81 invokes fit on live ref directly', cssConsumer: 'V4ComposerToolbar.tsx:572-575 group-data composer-model-icon /toolbar variants require the named group carrying the flag', contract: 'docs/ui/side-pane-full-view.md:118 requires plus/input/controls/send in one line; 131 sets floating width560' }, limits: ['Two afterEach snapshots share worker/counter and are one actual case, not two independent runs', 'Old <=64px assertion is not used as product specification', 'No multiline text, attachments, permission cards or drawer content in this captured empty-input shape', 'PNG is a real afterEach state; no continuous video is available', 'No product source changed; no macOS or installer validation'] };
const output = await safe(join(import.meta.dirname, 'validation-spfv-attribution.json'));
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ output, classification: result.classification, observations: observations.map(item => ({ capturedAt: item.capturedAt, shellDataset: item.shell.dataset, toolbarDataset: item.toolbar.dataset, hostHeight: item.host.rect.height, hostWidth: item.host.rect.width, editorBottom: item.editor.rect.bottom, toolbarTop: item.toolbar.rect.top, modelWidth: item.model.rect.width, labels: item.labels.map(node => node.display), icons: item.icons.map(node => node.display) })), uniqueReproductions: 1 }));
