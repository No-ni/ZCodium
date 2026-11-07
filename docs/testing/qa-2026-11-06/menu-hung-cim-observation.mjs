import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const runId = 'qa-menu-20261106-menu-reviewed';
const runtime = join(root, 'docs/testing/qa-2026-11-06/runtime', runId);
const home = join(runtime, `.e2e-home-${runId}`);
const app = join(root, 'packages/desktop/.e2e-cache', runId, 'app/main/index.js');
const logs = join(root, 'docs/testing/qa-2026-11-06/logs');
const perfPath = join(runtime, 'evidence/perf/process-samples-0-1.ndjson');
const expectedPid = 25980;
if (process.platform !== 'win32' || process.argv.length !== 2 || process.env.NODE_OPTIONS) throw new Error('Fixed Windows observer only; no arguments or external loader');
async function safe(candidate) {
  const absolute = resolve(candidate);
  const rel = relative(root, absolute);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Observer path escapes authorized worktree');
  for (let cursor = absolute; ; cursor = dirname(cursor)) {
    try {
      if ((await lstat(cursor)).isSymbolicLink() || (await realpath(cursor)).toLowerCase() !== cursor.toLowerCase()) throw new Error('Observer refuses redirected path');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (cursor === parse(cursor).root) break;
  }
  return absolute;
}
const normalize = value => String(value).replaceAll('\\', '/').toLowerCase();
function marker(command, value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|[\\s"'])${escaped}(?=$|[\\s"'])`, 'iu').test(normalize(command));
}
function exactMain(row) {
  return /^(?:electron|zcodium)\.exe$/iu.test(row.name) && normalize(row.executable).startsWith(normalize(root) + '/') && marker(row.command, `--zcode-e2e-run-id=${runId}`) && marker(row.command, `--zcode-e2e-home=${normalize(home)}`) && marker(row.command, `--app=${normalize(app)}`) && !/--type=/iu.test(row.command);
}
function descendants(rows, main) {
  const included = new Map([[main.pid, main]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      const parent = included.get(row.ppid);
      if (!included.has(row.pid) && parent && Number.isFinite(Date.parse(row.createdAt)) && Date.parse(row.createdAt) >= Date.parse(parent.createdAt)) { included.set(row.pid, row); changed = true; }
    }
  }
  return [...included.values()];
}
const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,WorkingSetSize,ThreadCount,HandleCount,@{Name='CpuTicks';Expression={([UInt64]$_.KernelModeTime+[UInt64]$_.UserModeTime).ToString()}},@{Name='CreatedAt';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress";
async function rowsFromCim() {
  const raw = await new Promise((resolveOutput, rejectOutput) => execFile('C:/Program Files/PowerShell/7/pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 7000, maxBuffer: 20 * 1024 * 1024 }, (error, stdout) => error ? rejectOutput(error) : resolveOutput(stdout)));
  const parsed = JSON.parse(raw);
  return (Array.isArray(parsed) ? parsed : [parsed]).map(row => ({ pid: Number(row.ProcessId), ppid: Number(row.ParentProcessId), name: String(row.Name ?? ''), executable: String(row.ExecutablePath ?? ''), command: String(row.CommandLine ?? ''), createdAt: String(row.CreatedAt ?? ''), cpuTicks: String(row.CpuTicks ?? '0'), workingSetBytes: Number(row.WorkingSetSize), threads: Number(row.ThreadCount), handles: Number(row.HandleCount) }));
}
for (const key of ['HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'TSX_CACHE_DIR', 'npm_config_cache', 'npm_config_store_dir', 'npm_config_userconfig', 'COREPACK_HOME', 'ZCODE_DATA_BASE_DIR']) {
  if (!process.env[key]) throw new Error(`Isolated ${key} required`);
  await safe(process.env[key]);
}
if (process.env.NODE_COMPILE_CACHE) await safe(process.env.NODE_COMPILE_CACHE);
for (const candidate of [logs, runtime, home, app, perfPath]) await safe(candidate);
await lstat(runtime); await lstat(home); await lstat(app);
const perf = (await readFile(perfPath, 'utf8')).trim().split(/\r?\n/u).reverse().map(line => { try { return JSON.parse(line); } catch { return null; } }).find(Boolean);
if (perf?.workerId !== '0-1' || perf.mainPid !== expectedPid || !Number.isFinite(Date.parse(perf.capturedAt)) || !perf.specs?.some(value => String(value).endsWith('/qa-residual-local-menus-20261106.test.ts'))) throw new Error('RLM worker main association unproved');
const started = new Date();
const output = await safe(join(logs, `validation-menu-hung-cim-${started.getTime()}.json`));
const handle = await open(output, 'wx');
const evidence = { capturedAt: started.toISOString(), runId, workerId: '0-1', expectedMainPid: expectedPid, perfCapturedAt: perf.capturedAt, sourceSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'), intervalMs: 2000, logicalCpus: availableParallelism(), noUiAttachKill: true, scope: 'Two fixed-run CIM observations; exact worker main and creation-limited PPID descendants only; command lines stay in memory', samples: [] };
let pinned = null;
const previous = new Map();
try {
  for (let index = 0; index < 2; index++) {
    if (index) await new Promise(resolveDelay => setTimeout(resolveDelay, 2000));
    const began = Date.now();
    const rows = await rowsFromCim();
    const captured = Date.now();
    const roots = rows.filter(exactMain);
    let refusal = null;
    if (roots.length !== 1) refusal = roots.length ? 'ambiguous-same-run-main' : 'no-exact-same-run-main';
    else if (roots[0].pid !== expectedPid) refusal = 'current-main-is-different-worker';
    else if (!Number.isFinite(Date.parse(roots[0].createdAt)) || Date.parse(roots[0].createdAt) > Date.parse(perf.capturedAt)) refusal = 'main-created-after-worker-perf-or-invalid-time';
    else if (pinned && (pinned.pid !== roots[0].pid || pinned.createdAt !== roots[0].createdAt)) refusal = 'main-identity-changed';
    if (!refusal && !pinned) pinned = { pid: roots[0].pid, createdAt: roots[0].createdAt };
    const selected = refusal ? [] : descendants(rows, roots[0]);
    const processes = selected.map(row => {
      const old = previous.get(row.pid);
      const delta = old?.createdAt === row.createdAt ? Number(BigInt(row.cpuTicks) - BigInt(old.cpuTicks)) : null;
      const cpu = delta === null || delta < 0 ? null : delta / 10000 / (captured - old.captured) * 100;
      previous.set(row.pid, { ...row, captured });
      const metric = Date.parse(row.createdAt) <= Date.parse(perf.capturedAt) && perf.metrics?.find(value => value.pid === row.pid);
      const role = row.pid === expectedPid ? 'main' : /--type=renderer(?:\s|$)/iu.test(row.command) ? 'renderer' : metric?.name?.startsWith('zcode-host-') ? 'host' : metric?.name === 'zcode-cron-scheduler' ? 'scheduler' : metric?.type === 'GPU' ? 'gpu' : 'descendant-unclassified';
      return { pid: row.pid, ppid: row.ppid, name: row.name, createdAt: row.createdAt, role, cpuTicks: row.cpuTicks, cpuPercentOfOneCore: cpu, workingSetBytes: row.workingSetBytes, threads: row.threads, handles: row.handles, runMarker: marker(row.command, `--zcode-e2e-run-id=${runId}`), homeMarker: marker(row.command, `--zcode-e2e-home=${normalize(home)}`), appMarker: marker(row.command, `--app=${normalize(app)}`), executableInWorktree: normalize(row.executable).startsWith(normalize(root) + '/') };
    });
    evidence.samples.push({ capturedAt: new Date(captured).toISOString(), cimMs: captured - began, exactMainCount: roots.length, exactMatchingMainPids: roots.map(row => row.pid), refusal, main: pinned, processes });
    if (refusal) process.exitCode = 1;
  }
} catch (error) {
  evidence.observerError = { code: error.code ?? null, message: error.message };
  process.exitCode = 1;
} finally {
  evidence.finishedAt = new Date().toISOString();
  await handle.write(JSON.stringify(evidence, null, 2) + '\n');
  await handle.close();
  console.log(JSON.stringify({ output, runId, samples: evidence.samples.length, refusals: evidence.samples.map(item => item.refusal), noUiAttachKill: true }));
}
