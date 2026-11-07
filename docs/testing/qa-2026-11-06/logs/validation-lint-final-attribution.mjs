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
const input = resolve(import.meta.dirname, 'validation-lint-final.log');
const target = resolve(import.meta.dirname, 'validation-lint-final-attribution.json');
await safePath(input);
await safePath(target);
const raw = await readFile(input, 'utf8');
const diagnostics = [...raw.matchAll(/^\s{2}([!x]) (.+)\r?\n\s+,-\[([^\r\n]+):(\d+):(\d+)\]/gmu)].map(match => ({ severity: match[1] === 'x' ? 'error' : 'warning', rule: match[2].split(':')[0], file: match[3], line: Number(match[4]), column: Number(match[5]) }));
const summary = raw.match(/Found (\d+) warnings and (\d+) errors\./u);
const files = raw.match(/Finished in [^\n]+ on (\d+) files/u);
const outsideRuntime = diagnostics.filter(item => !item.file.startsWith('docs/testing/qa-2026-11-06/runtime/'));
const errors = diagnostics.filter(item => item.severity === 'error');
const output = {
  capturedAt: new Date().toISOString(), input: relative(root, input).replaceAll('\\', '/'), inputSha256: createHash('sha256').update(raw).digest('hex'),
  originalExitCode: 1, warnings: Number(summary?.[1]), errors: Number(summary?.[2]), files: Number(files?.[1]), parsedDiagnostics: diagnostics.length,
  parsedWarnings: diagnostics.length - errors.length, parsedErrors: errors.length,
  allErrorsWithinQaRuntime: errors.every(item => item.file.startsWith('docs/testing/qa-2026-11-06/runtime/')),
  errorRules: [...new Set(errors.map(item => item.rule))], errorsByFile: errors, diagnosticsOutsideRuntime: outsideRuntime,
  scope: 'Original unmodified root lint fails; compiled Jiti/plugin vendor copies in QA runtime are generated evidence, not production edits. No files deleted and no config changed. A separate lint command excluding only this runtime can establish source diagnostics, without overriding original failure.',
};
await writeFile(target, JSON.stringify(output, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ warnings: output.warnings, errors: output.errors, files: output.files, parsedDiagnostics: output.parsedDiagnostics, parsedErrors: output.parsedErrors, allErrorsWithinQaRuntime: output.allErrorsWithinQaRuntime, outsideRuntime: outsideRuntime.length, errorRules: output.errorRules }));
