import { readFile, lstat, realpath, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname, parse, isAbsolute } from 'node:path';

const repository = resolve(import.meta.dirname, '../../../..');
const reportRoot = resolve(import.meta.dirname, '..');
const outputName = process.argv[2] ?? 'validation-links-live.json';
if (!/^validation-links-[a-z0-9-]+\.json$/u.test(outputName)) throw new Error('Invalid report evidence filename');
async function safePath(candidate) {
  const absolute = resolve(candidate);
  const rel = relative(repository, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Report link leaves authorized worktree');
  for (let cursor = absolute; ; cursor = dirname(cursor)) {
    try {
      if ((await lstat(cursor)).isSymbolicLink() || (await realpath(cursor)).toLowerCase() !== cursor.toLowerCase()) throw new Error('Redirected report link');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (cursor === parse(cursor).root) break;
  }
  return absolute;
}
const files = ['test-report.md', 'test-execution-history.md', 'bug-report.md', 'validation.md', 'coverage-matrix.md'];
const missingTargets = [];
let localLinkCount = 0;
const contents = {};
for (const file of files) {
  contents[file] = await readFile(await safePath(resolve(reportRoot, file)), 'utf8');
  for (const match of contents[file].matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
    const target = match[1];
    if (/^[a-z]+:\/\/|^#/iu.test(target)) continue;
    const path = target.split('#')[0].replace(/^<|>$/gu, '');
    const absolute = await safePath(resolve(reportRoot, decodeURIComponent(path)));
    localLinkCount += 1;
    try { await lstat(absolute); }
    catch (error) { if (error.code !== 'ENOENT') throw error; missingTargets.push({ file, target }); }
  }
}
const matrix = contents['coverage-matrix.md'];
const coverageAnchors = [...contents['test-report.md'].matchAll(/coverage-matrix\.md#([a-z0-9-]+)/gu)].map(match => match[1]);
const historyCoverageAnchors = [...contents['test-execution-history.md'].matchAll(/coverage-matrix\.md#([a-z0-9-]+)/gu)].map(match => match[1]);
const actualAnchors = new Set([...matrix.matchAll(/<a id="([a-z0-9-]+)"><\/a>/gu)].map(match => match[1]));
const indexedCoverageAnchors = coverageAnchors.length === 87 ? coverageAnchors : historyCoverageAnchors;
const missingCoverageAnchors = [...coverageAnchors, ...historyCoverageAnchors].filter(anchor => !actualAnchors.has(anchor));
const expectedBugAnchors = Array.from({ length: 8 }, (_, index) => `bug-${String(index + 1).padStart(3, '0')}`);
const actualBugAnchors = new Set([...contents['bug-report.md'].matchAll(/<a id="(bug-[0-9]{3})"><\/a>/gu)].map(match => match[1]));
const missingBugAnchors = expectedBugAnchors.filter(anchor => !actualBugAnchors.has(anchor));
const referencedBugAnchors = Object.values(contents).flatMap(content => [...content.matchAll(/bug-report\.md#(bug-[0-9]{3})/gu)].map(match => match[1]));
const missingReferencedBugAnchors = referencedBugAnchors.filter(anchor => !actualBugAnchors.has(anchor));
const evidence = { capturedAt: new Date().toISOString(), scope: 'Test report, preserved execution history, Bug report, validation and coverage matrix: all local target existence, the 87 explicit coverage anchors in current report or preserved history, and eight explicit Bug anchors; no generic Markdown-heading slug or external URL verification', localLinkCount, missingTargets, coverageLinkCount: indexedCoverageAnchors.length, uniqueCoverageAnchors: new Set(indexedCoverageAnchors).size, coverageIndexSource: coverageAnchors.length === 87 ? 'test-report.md' : 'test-execution-history.md', currentCoverageLinkCount: coverageAnchors.length, historyCoverageLinkCount: historyCoverageAnchors.length, missingCoverageAnchors, expectedBugAnchorCount: expectedBugAnchors.length, actualBugAnchorCount: actualBugAnchors.size, missingBugAnchors, referencedBugAnchorCount: referencedBugAnchors.length, missingReferencedBugAnchors };
await writeFile(await safePath(resolve(import.meta.dirname, outputName)), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(evidence));
if (missingTargets.length || missingCoverageAnchors.length || missingBugAnchors.length || missingReferencedBugAnchors.length || evidence.actualBugAnchorCount !== 8 || evidence.coverageLinkCount !== 87 || evidence.uniqueCoverageAnchors !== 87) process.exitCode = 1;
