import { execFile } from 'node:child_process';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';

const repository = resolve(import.meta.dirname, '../../../..');
const reportRoot = resolve(import.meta.dirname, '..');
const runId = 'qa-menu-20261106-grp-pin-repro-retry';
const knownPid = 8448;
async function safe(path) {
  const absolute = resolve(path), rel = relative(repository, absolute);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Identity diagnostic path leaves worktree');
  for (let cursor = absolute; ; cursor = dirname(cursor)) {
    try { if ((await lstat(cursor)).isSymbolicLink() || (await realpath(cursor)).toLowerCase() !== cursor.toLowerCase()) throw new Error('Identity diagnostic redirected path'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (cursor === parse(cursor).root) break;
  }
  return absolute;
}
if (process.platform !== 'win32' || process.env.NODE_OPTIONS) throw new Error('Requires Windows and cleared Node loaders');
for (const key of ['HOME','USERPROFILE','TEMP','TMP','APPDATA','LOCALAPPDATA']) await safe(process.env[key] || '');
const perfPath = await safe(join(reportRoot, 'runtime', runId, 'evidence/perf/process-samples-0-0.ndjson'));
const lines = (await readFile(perfPath, 'utf8')).trim().split(/\r?\n/u);
const perf = lines.map(line => JSON.parse(line)).reverse().find(row => row.mainPid === knownPid);
if (!perf || perf.workerId !== '0-0' || !perf.windows?.some(window => window.url.includes(`/.e2e-cache/${runId}/app/renderer/index.html`))) throw new Error('Known PID lacks this run staged-window evidence');
const script = `Get-CimInstance Win32_Process -Filter 'ProcessId = ${knownPid}' | Select-Object ProcessId,Name,ExecutablePath,CommandLine,@{Name='CreatedAt';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress`;
const output = await new Promise((resolveOutput, reject) => execFile('C:/Program Files/PowerShell/7/pwsh.exe', ['-NoProfile','-NonInteractive','-Command',script], {encoding:'utf8',windowsHide:true,timeout:7000,maxBuffer:16384}, (error, stdout) => error ? reject(error) : resolveOutput(stdout)));
const row = output.trim() ? JSON.parse(output) : null;
const normalize = text => text.replaceAll('\\','/').toLowerCase();
const command = normalize(String(row?.CommandLine || ''));
const app = normalize(join(repository,'packages/desktop/.e2e-cache',runId,'app/main/index.js'));
const home = normalize(join(reportRoot,'runtime',runId,`.e2e-home-${runId}`));
function originalMarker(value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
  return new RegExp(`(?:^|[\\s"'])${escaped}(?=$|[\\s"'])`,'iu').test(command);
}
const checks = Object.fromEntries([['run',`--zcode-e2e-run-id=${runId}`],['home',`--zcode-e2e-home=${home}`],['app',`--app=${app}`]].map(([name,value])=>[name,{originalExact:originalMarker(value),valueInsideQuotes:command.includes(value.replace('=','="')+'"'),singleValueInsideQuotes:command.includes(value.replace('=',"='")+"'"),literalContained:command.includes(value)}]));
const evidence = { capturedAt:new Date().toISOString(),evidenceKind:'Known same-run PID marker diagnostic only; no process selection/resource sampling, UI, CDP or kill; complete command line held only in memory',runId,knownPid,perfCapturedAt:perf.capturedAt,pidPresent:Boolean(row),createdAt:row?.CreatedAt??null,executableInWorktree:row?normalize(row.ExecutablePath||'').startsWith(normalize(repository)+'/'):false,mainNameMatches:row?/^(electron|zcodium)\.exe$/iu.test(row.Name||''):false,noChromiumType:row?!command.includes('--type='):false,markerChecks:checks,afterExitNoLiveIdentity:!row,limits:'Known PID and actual staged renderer perf evidence are fixed. If process is absent this cannot diagnose former command line structure or prove no Main existed; no raw commands saved.' };
await writeFile(await safe(join(import.meta.dirname,`validation-grp-pin-retry-identity-${Date.now()}.json`)),JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(evidence));
