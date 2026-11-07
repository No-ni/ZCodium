import { execFile } from 'node:child_process';
import { writeFile, lstat, realpath } from 'node:fs/promises';
import { resolve, relative, dirname, parse, isAbsolute, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const repository = resolve(import.meta.dirname, '../../../..');
const runId = 'qa-menu-20261106-filtered';
const homeDir = join(repository, 'docs/testing/qa-2026-11-06/runtime', runId, `.e2e-home-${runId}`);
const oldPids = [19716, 31144, 31336, 19060, 12968, 14172];
async function safe(candidate) {
  const absolute = resolve(candidate);
  const rel = relative(repository, absolute);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Read-only observation path escapes worktree');
  for (let cursor = absolute; ; cursor = dirname(cursor)) {
    try {
      if ((await lstat(cursor)).isSymbolicLink() || (await realpath(cursor)).toLowerCase() !== cursor.toLowerCase()) throw new Error('Redirected observation path');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (cursor === parse(cursor).root) break;
  }
  return absolute;
}
await safe(homeDir);
const desktopRequire = createRequire(join(repository, 'packages/desktop/package.json'));
const { tsImport } = desktopRequire('tsx/esm/api');
const { collectE2EProcessTreePids } = await tsImport(pathToFileURL(join(repository, 'packages/desktop/test/e2e/helpers/e2e-process-cleanup.ts')).href, { parentURL: import.meta.url, tsconfig: join(repository, 'packages/desktop/tsconfig.e2e.json') });
const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,@{Name='CreatedAt';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress";
const raw = await new Promise((resolveOutput, rejectOutput) => execFile('C:/Program Files/PowerShell/7/pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 20 * 1024 * 1024 }, (error, stdout) => error ? rejectOutput(error) : resolveOutput(stdout)));
const parsed = JSON.parse(raw);
const rows = (Array.isArray(parsed) ? parsed : [parsed]).map(row => ({ pid: Number(row.ProcessId), ppid: Number(row.ParentProcessId), name: String(row.Name ?? ''), createdAt: String(row.CreatedAt ?? ''), executable: String(row.ExecutablePath ?? ''), command: String(row.CommandLine ?? '') }));
const helperPids = collectE2EProcessTreePids(rows, { currentPid: process.pid, homeDir, runId, includeChromeDriverAncestors: false, rootPids: [19716] });
const driverPids = rows.filter(row => /chromedriver/iu.test(row.name) && row.command.includes('--port=60521')).map(row => row.pid);
const wanted = new Set([...oldPids, ...helperPids, ...driverPids]);
const evidence = { capturedAt: new Date().toISOString(), evidenceKind: 'Read-only WMI filtered-run identity snapshot after worker0-0 protocol timeouts; no UI/CDP requests, kill, timeout changes or product edits', runId, oldMainPid: 19716, oldPids, helperEquivalentPids: helperPids, oldPidsAbsentNow: oldPids.filter(pid => !rows.some(row => row.pid === pid)), oldDriverPort: 60521, driverPids, processes: rows.filter(row => wanted.has(row.pid)).map(row => ({ pid: row.pid, ppid: row.ppid, name: row.name, createdAt: row.createdAt, executableInWorktree: row.executable.toLowerCase().startsWith(repository.toLowerCase() + '\\'), runMarker: row.command.includes(runId), homeMarker: row.command.includes(homeDir) || row.command.includes(homeDir.replaceAll('\\', '/')), oldDriverPort: driverPids.includes(row.pid) })) };
const output = await safe(join(import.meta.dirname, `validation-filtered-process-snapshot-${Date.now()}.json`));
await writeFile(output, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, ...evidence }));
