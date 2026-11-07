const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../../../..');
const ts = createRequire(path.join(root, 'packages/desktop/package.json'))('typescript');
const qaFile = path.join(root, 'docs/testing/qa-2026-11-06/manual-review/pending/qa-historical-trajectory-20261106.test.ts');
const uiFile = path.join(root, 'packages/ui/src/ModelTrajectoryTimeline.tsx');
const snapshotFile = path.join(root, 'docs/testing/qa-2026-11-06/runtime/qa-menu-20261106-local-final-targeted/evidence/qa-historical-trajectory-0-1-32648-1793995922626/003-HIST01.json');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
function owned(file) {
  const absolute = path.resolve(file);
  if (!absolute.startsWith(root + path.sep)) throw new Error('Path outside worktree');
  for (let current = absolute; current !== root; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Reparse path rejected');
  }
  return absolute;
}
const qa = fs.readFileSync(owned(qaFile), 'utf8');
const ui = fs.readFileSync(owned(uiFile), 'utf8');
const observed = JSON.parse(fs.readFileSync(owned(snapshotFile), 'utf8'));
const ast = ts.createSourceFile(qaFile, qa, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const record = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === 'record');
if (!record) throw new Error('Synthetic function missing');
function constant(name) {
  const declaration = ast.statements.filter(ts.isVariableStatement).flatMap(item => item.declarationList.declarations).find(item => item.name.getText(ast) === name);
  if (!declaration || !ts.isStringLiteral(declaration.initializer)) throw new Error('Synthetic marker missing');
  return declaration.initializer.text;
}
const compiled = ts.transpileModule(record.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
if (compiled.diagnostics?.length) throw new Error('Generator diagnostics');
const generate = new Function('taskId', 'MARKER', 'LONG', compiled.outputText + '\nreturn record;')(observed.taskId, constant('MARKER'), constant('LONG'));
const records = Array.from({ length: 80 }, (_, index) => ({ ...generate(index), callSource: { kind: 'main' } }));
const uiAst = ts.createSourceFile(uiFile, ui, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['resolveTrajectoryTimelineItems', 'resolveTrajectoryInputMessages', 'shouldUseConversationDelta', 'computeDeltaMessages'];
const functions = uiAst.statements.filter(item => ts.isFunctionDeclaration(item) && names.includes(item.name?.text));
if (functions.length !== 4) throw new Error('Current projection missing');
const compiledUi = ts.transpileModule(functions.map(item => item.getText(uiAst)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
if (compiledUi.diagnostics?.length) throw new Error('UI pure projection diagnostics');
const exportsObject = {};
new Function('exports', compiledUi.outputText)(exportsObject);
const items = exportsObject.resolveTrajectoryTimelineItems(records);
const logicalMatches = items.flatMap((item, index) => item.inputMessages.filter(message => message.content.includes(constant('MARKER'))).map(() => index));
const firstInputRoles = items[0].inputMessages.map(message => message.role);
const responseRoles = [records[0].response.reasoningText ? 'reasoning' : '', records[0].response.text ? 'assistant' : '', records[0].response.toolCalls.length ? 'tool-call' : ''].filter(Boolean);
const firstSixRoles = [...firstInputRoles.map(role => role === 'tool' ? 'tool-result' : role), ...responseRoles];
const observedResponseIndices = [...new Set([...observed.state.expandedText.matchAll(/QA_HIST_ASSISTANT_(\d+)/g)].map(match => Number(match[1])))];
if (logicalMatches.join(',') !== '1,42' || firstSixRoles.length !== 6 || observedResponseIndices.includes(0)) throw new Error('Unexpected fixture or mounted snapshot');
const result = {
  capturedAt: new Date().toISOString(),
  evidenceKind: 'Read-only frozen generator/current UI pure projection and saved DOM snapshot; no UI, Host, history writes or build',
  qaFile, qaSha256: hash(qa), uiFile, uiSha256: hash(ui), snapshotFile,
  snapshotSha256: hash(fs.readFileSync(snapshotFile)), observedCapturedAt: observed.capturedAt,
  recordCount: records.length, firstInputRoles, firstSixRoles, logicalMarkerIndices: logicalMatches,
  actualSnapshot: { virtual: observed.state.virtual, calls: observed.state.calls, expanded: observed.state.expanded, roles: [...new Set(observed.state.roles)], capturedCopyCount: observed.state.clips.length },
  inferredMountedRecordIndicesFromAssistantOutput: observedResponseIndices,
  inferenceBoundary: 'The saved JSON has no scrollTop or raw data-index list; indices are inferred from exact synthetic assistant output markers. PNG visibly starts at call05. Initial scroll cause is not proven.',
  currentQaPrecondition: 'expanded>=6 counts any mounted records; it does not require first data-index=0 or initial system/tool-result owner.',
  accepted: true,
  conclusion: 'Current cumulative fixture retains six roles in first record and two logical markers at 1/42. Failure snapshot mounts record1-8 and omits the first-record-only roles. Preserve fixture and assertions; explicitly scroll the real timeline owner to first call and wait for its system/tool-result before the initial snapshot. No product defect is established by this QA viewport assumption.',
};
fs.writeFileSync(path.join(__dirname, 'feature-inventory-historical-initial-viewport.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ accepted: true, firstSixRoles, logicalMatches, observedResponseIndices }));
