const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../../../..');
const currentMode = process.argv.includes('--current');
const ts = createRequire(path.join(root, 'packages/desktop/package.json'))('typescript');
const sourceFile = path.join(root, 'packages/ui/src/ModelTrajectoryTimeline.tsx');
const evidenceFile = path.join(root, 'docs/testing/qa-2026-11-06/runtime/qa-menu-20261106-local-supplement-retry/evidence/qa-historical-trajectory-0-1-13508-1793994788354/002-synthetic-history-created.json');
function owned(file) {
  const absolute = path.resolve(file);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) throw new Error('Path escapes worktree');
  for (let current = absolute; current.length >= root.length; current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Reparse path rejected');
    if (current === root) break;
  }
  return absolute;
}
const seedEvidence = JSON.parse(fs.readFileSync(owned(evidenceFile), 'utf8'));
const rawPath = owned(seedEvidence.source);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const qaSourceFile = path.join(root, 'docs/testing/qa-2026-11-06/manual-review/pending/qa-historical-trajectory-20261106.test.ts');
const qaSource = fs.readFileSync(owned(qaSourceFile), 'utf8');
const qaAst = ts.createSourceFile(qaSourceFile, qaSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const recordFunction = qaAst.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'record');
if (!recordFunction) throw new Error('Current synthetic generator missing');
const constant = name => {
  const declaration = qaAst.statements.filter(ts.isVariableStatement).flatMap(statement => statement.declarationList.declarations).find(item => item.name.getText(qaAst) === name);
  if (!declaration || !ts.isStringLiteral(declaration.initializer)) throw new Error('Expected fixed synthetic marker');
  return declaration.initializer.text;
};
const generatorJs = ts.transpileModule(recordFunction.getText(qaAst), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
if (generatorJs.diagnostics?.length) throw new Error('Synthetic generator transpile diagnostics');
const generator = new Function('taskId', 'MARKER', 'LONG', generatorJs.outputText + '\nreturn record;')(seedEvidence.taskId, constant('MARKER'), constant('LONG'));
const generated = Array.from({ length: 80 }, (_, index) => generator(index));
const foreign = generator(900, 'qa-foreign-session');
foreign.response.text = 'QA_HIST_FOREIGN_SESSION_RECORD';
const reconstructedText = generated.map(record => JSON.stringify(record)).join('\n') + '\n' + JSON.stringify(foreign) + '\n';
const originalFilePresent = fs.existsSync(rawPath);
const rawText = !currentMode && originalFilePresent ? fs.readFileSync(rawPath, 'utf8') : reconstructedText;
if (!currentMode && hash(rawText) !== seedEvidence.sourceSha256) throw new Error('Synthetic history source hash differs');
if (currentMode && Buffer.byteLength(rawText) >= 1024 * 1024) throw new Error('Current synthetic initial history exceeds exactPath tail ownership limit');
const records = rawText.trim().split('\n').map(line => JSON.parse(line)).filter(record => record.sessionId === seedEvidence.taskId);
if (records.length !== 80 || records.some(record => record.querySource !== 'main_turn')) throw new Error('Unexpected synthetic input');
const source = fs.readFileSync(owned(sourceFile), 'utf8');
const sourceAst = ts.createSourceFile(sourceFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['resolveTrajectoryTimelineItems', 'resolveTrajectoryInputMessages', 'shouldUseConversationDelta', 'computeDeltaMessages'];
const selected = sourceAst.statements.filter(statement => ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text));
if (selected.length !== 4) throw new Error('Current pure functions missing');
const transpiled = ts.transpileModule(selected.map(statement => statement.getText(sourceAst)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
if (transpiled.diagnostics?.length) throw new Error('Pure source transpile diagnostics');
const exportsObject = {};
new Function('exports', transpiled.outputText)(exportsObject);
const mapped = records.map(record => ({ ...record, callSource: { kind: 'main' } }));
const marker = 'QA_HIST_SHARED_NEEDLE';
function projectedMatches(input) {
  return exportsObject.resolveTrajectoryTimelineItems(input).flatMap((item, index) => item.inputMessages.filter(message => typeof message.content === 'string' && message.content.includes(marker)).map(() => index));
}
const originalMatches = projectedMatches(mapped);
const cumulative = currentMode ? mapped : mapped.map((record, index) => ({ ...record, request: { ...record.request, messages: index === 0 ? mapped[0].request.messages : [...mapped[0].request.messages, ...mapped.slice(1, index + 1).flatMap(item => item.request.messages)] } }));
const cumulativeMatches = projectedMatches(cumulative);
if (JSON.stringify(originalMatches) !== (currentMode ? '[1,42]' : '[1]') || JSON.stringify(cumulativeMatches) !== '[1,42]') throw new Error('Current source does not satisfy expected projection contract');
const output = {
  capturedAt: new Date().toISOString(),
  evidenceKind: 'Read-only seed evidence and frozen source generator reconstructed to exact captured JSONL hash, plus extracted current pure UI functions; no UI/Host/Provider/build/history writes',
  sourceFile, sourceSha256: hash(source), rawPath, rawSha256: hash(rawText), evidenceFile,
  qaSourceFile, qaSourceSha256: hash(qaSource), originalFilePresent,
  originalFileRead: !currentMode && originalFilePresent,
  currentMode, initialGeneratedBytes: Buffer.byteLength(rawText),
  reconstructionMatchesCapturedSha256: hash(reconstructedText) === seedEvidence.sourceSha256,
  extractedFunctions: names, diagnostics: 0, recordCount: records.length,
  rawMarkerIndices: mapped.flatMap((record, index) => record.request.messages.some(message => message.content?.includes(marker)) ? [index] : []),
  currentFixtureProjectedMarkerIndices: originalMatches,
  proposedCumulativeProjectedMarkerIndices: cumulativeMatches,
  observedUiCounter: '1/1',
  accepted: true,
  conclusion: currentMode ? 'Current frozen cumulative main generator projects exactly two logical markers at 1 and 42 through current pure UI functions; 80 records and initial bounded history size remain. No UI or historical file was written; the observedUiCounter field is the previous run snapshot.' : 'Independent one-message synthetic main requests violate cumulative main history contract; equal message count suppresses the second marker at 42. Cumulative fixture preserves both markers without changing product delta or assertions. The worker reset removed the original path before this probe; no files were restored.',
};
fs.writeFileSync(path.join(__dirname, currentMode ? 'feature-inventory-historical-cumulative-current.json' : 'feature-inventory-historical-message-contract.json'), JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ accepted: output.accepted, recordCount: records.length, originalMatches, cumulativeMatches, diagnostics: 0 }));
