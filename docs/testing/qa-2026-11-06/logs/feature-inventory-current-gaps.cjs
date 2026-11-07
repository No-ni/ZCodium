const fs = require('node:fs');
const path = require('node:path');
const qaRoot = path.resolve(__dirname, '..');
const file = path.join(qaRoot, 'coverage-matrix.md');
const external = new Set(['NAV-12', 'SET-15', 'SET-12', 'SET-13', 'REM-01', 'REM-02', 'REM-03', 'BOT-02']);
const groups = fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line, index) => {
  const match = line.match(/^\|\s*<a id="([^"]+)"><\/a>([A-Z]+-\d+)\s*\|/);
  if (!match) return [];
  const columns = line.split('|');
  return [{ id: match[2], anchor: match[1], line: index + 1, entry: columns[2].trim(), evidence: columns[3].trim(), status: columns[4].trim(), remaining: columns.slice(5, -1).join('|').trim() }];
});
if (groups.length !== 87 || new Set(groups.map(group => group.id)).size !== 87 || new Set(groups.map(group => group.anchor)).size !== 87) throw new Error('Expected 87 unique functional groups and anchors');
const notRun = groups.filter(group => group.status.includes('NOT-RUN'));
const blocked = groups.filter(group => group.status.includes('BLOCKED'));
const union = groups.filter(group => group.status.includes('NOT-RUN') || group.status.includes('BLOCKED'));
const result = {
  capturedAt: new Date().toISOString(),
  evidenceKind: 'Read-only current matrix text and gap classification; no UI or product validation',
  groups: groups.length,
  notRun: notRun.map(group => group.id),
  blocked: blocked.map(group => group.id),
  unionCount: union.length,
  localGapGroups: union.filter(group => !external.has(group.id)),
  externalConditionGroups: union.filter(group => external.has(group.id)),
  failureLabels: groups.filter(group => group.status.includes('FAIL')).map(group => group.id),
};
fs.writeFileSync(path.join(__dirname, 'feature-inventory-current-gaps.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ groups: result.groups, notRun: result.notRun, blocked: result.blocked, union: result.unionCount, local: result.localGapGroups.map(group => group.id), external: result.externalConditionGroups.map(group => group.id), failureLabelCount: result.failureLabels.length }));
