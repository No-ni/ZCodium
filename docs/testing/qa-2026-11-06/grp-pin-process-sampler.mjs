import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(import.meta.dirname, '../../..');
const targetRunId = 'qa-menu-20261106-grp-pin-grouped';
const runtime = join(repository, 'docs/testing/qa-2026-11-06/runtime', targetRunId);
const targetHome = join(runtime, `.e2e-home-${targetRunId}`);
const appRoot = join(repository, 'packages/desktop/.e2e-cache', targetRunId, 'app');
const appEntry = join(appRoot, 'main/index.js');
const logs = join(repository, 'docs/testing/qa-2026-11-06/logs');
const args = process.argv.slice(2);
const staticCheck = args.includes('--static-check');
if (args.some(arg => !/^--(?:static-check|interval-ms=\d+|max-ms=\d+)$/u.test(arg))) throw new Error('Unsupported sampler argument');
const intervalMs = Number(args.find(arg => arg.startsWith('--interval-ms='))?.split('=')[1] ?? 2000);
const maxMs = Number(args.find(arg => arg.startsWith('--max-ms='))?.split('=')[1] ?? 900000);
if (intervalMs < 1000 || intervalMs > 2000 || maxMs < 60000 || maxMs > 1200000) throw new Error('Sampler interval or duration exceeds approved bounds');

async function safe(candidate) {
  const absolute = resolve(candidate);
  const rel = relative(repository, absolute);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Sampler path escapes worktree');
  for (let cursor = absolute; ; cursor = dirname(cursor)) {
    try {
      if ((await lstat(cursor)).isSymbolicLink() || (await realpath(cursor)).toLowerCase() !== cursor.toLowerCase()) throw new Error('Sampler refuses redirected ancestors');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (cursor === parse(cursor).root) break;
  }
  return absolute;
}
const normalize = value => value.replaceAll('\\', '/').toLowerCase();
function windowsTokens(command) {
  const tokens = [];
  let token = '';
  let quoted = false;
  let active = false;
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (character === '\\') {
      let count = 1;
      while (command[index + count] === '\\') count++;
      if (command[index + count] === '"') {
        token += '\\'.repeat(Math.floor(count / 2));
        if (count % 2) token += '"';
        else quoted = !quoted;
        index += count;
      } else {
        token += '\\'.repeat(count);
        index += count - 1;
      }
      active = true;
    } else if (character === '"') {
      quoted = !quoted;
      active = true;
    } else if (/\s/u.test(character) && !quoted) {
      if (active) tokens.push(token);
      token = '';
      active = false;
    } else {
      token += character;
      active = true;
    }
  }
  if (quoted) return null;
  if (active) tokens.push(token);
  return tokens;
}
function exactOption(tokens, key, expected, pathValue = false) {
  if (!tokens) return false;
  const candidates = tokens.filter(token => token.toLowerCase() === key || token.toLowerCase().startsWith(key + '='));
  if (candidates.length !== 1 || !candidates[0].startsWith(key + '=')) return false;
  const actual = candidates[0].slice(key.length + 1);
  return pathValue ? normalize(actual) === normalize(expected) : actual === expected;
}
function marker(command, key, value, pathValue = false) {
  return exactOption(windowsTokens(command), key, value, pathValue);
}
function exactMain(row) {
  const tokens = windowsTokens(row.command);
  return /^(?:electron|zcodium)\.exe$/iu.test(row.name) &&
    normalize(row.executable).startsWith(normalize(repository) + '/') &&
    exactOption(tokens, '--zcode-e2e-run-id', targetRunId) &&
    exactOption(tokens, '--zcode-e2e-home', targetHome, true) &&
    exactOption(tokens, '--app', appEntry, true) &&
    !tokens.some(token => /^--type(?:=|$)/iu.test(token));
}
function descendants(rows, rootPid) {
  const included = new Set(rows.some(row => row.pid === rootPid) ? [rootPid] : []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      const parent = included.has(row.ppid) && rows.find(candidate => candidate.pid === row.ppid);
      if (!included.has(row.pid) && parent && Date.parse(row.createdAt) >= Date.parse(parent.createdAt)) { included.add(row.pid); changed = true; }
    }
  }
  return rows.filter(row => included.has(row.pid));
}
function role(row, mainPid, perf) {
  if (row.pid === mainPid) return { role: 'main', roleSource: 'exact-main-identity' };
  if (/--type=renderer(?:\s|$)/iu.test(row.command)) return { role: 'renderer', roleSource: 'chromium-type' };
  const metric = perf?.metrics?.find(item => item.pid === row.pid);
  if (metric?.name?.startsWith('zcode-host-')) return { role: 'host', roleSource: 'existing-WDIO-perf-service-name' };
  if (metric?.name === 'zcode-cron-scheduler') return { role: 'scheduler', roleSource: 'existing-WDIO-perf-service-name' };
  if (metric?.type) return { role: metric.type === 'GPU' ? 'gpu' : 'utility', roleSource: 'existing-WDIO-perf-type' };
  return { role: /--utility-sub-type=node\.mojom\.NodeService/iu.test(row.command) ? 'node-utility-unclassified' : 'descendant-unclassified', roleSource: 'command-type-only' };
}
function cpuPercent(row, previous, capturedAt) {
  if (!previous || previous.createdAt !== row.createdAt || capturedAt <= previous.capturedAt) return null;
  const deltaTicks = Number(BigInt(row.cpuTicks) - BigInt(previous.cpuTicks));
  return deltaTicks < 0 ? null : deltaTicks / 10000 / (capturedAt - previous.capturedAt) * 100;
}
async function tailJsonLines(path) {
  await safe(path);
  let file;
  try { file = await open(path, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const size = (await file.stat()).size;
    const start = Math.max(0, size - 4 * 1024 * 1024);
    const buffer = Buffer.alloc(size - start);
    await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split(/\r?\n/u);
    if (start) lines.shift();
    for (let index = lines.length - 1; index >= 0; index--) {
      if (!lines[index].trim()) continue;
      try { return JSON.parse(lines[index]); }
      catch { /* 正在追加的末行不是完整证据，读取前一个完整采样。 */ }
    }
    return null;
  } finally { await file.close(); }
}
async function rowsFromWmi() {
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,WorkingSetSize,ThreadCount,HandleCount,@{Name='CpuTicks';Expression={([UInt64]$_.KernelModeTime+[UInt64]$_.UserModeTime).ToString()}},@{Name='CreatedAt';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress";
  const raw = await new Promise((resolveOutput, rejectOutput) => execFile('C:/Program Files/PowerShell/7/pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 7000, maxBuffer: 20 * 1024 * 1024 }, (error, stdout) => error ? rejectOutput(error) : resolveOutput(stdout)));
  const parsed = JSON.parse(raw);
  return (Array.isArray(parsed) ? parsed : [parsed]).map(row => ({ pid: Number(row.ProcessId), ppid: Number(row.ParentProcessId), name: String(row.Name ?? ''), executable: String(row.ExecutablePath ?? ''), command: String(row.CommandLine ?? ''), createdAt: String(row.CreatedAt ?? ''), cpuTicks: String(row.CpuTicks ?? '0'), workingSetBytes: Number(row.WorkingSetSize), threads: Number(row.ThreadCount), handles: Number(row.HandleCount) }));
}
async function runEnded() {
  const exitPath = await safe(join(logs, `e2e-${targetRunId}.log.exit-code.txt`));
  try {
    const value = (await readFile(exitPath, 'utf8')).trim();
    if (/^-?\d+$/u.test(value)) return { source: 'runner-exit-code', exitCode: Number(value) };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const summaryPath = await safe(join(runtime, 'evidence/summary.json'));
  try {
    const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
    if (summary.runId === targetRunId && Number.isFinite(summary.exitCode) && summary.completedAt) return { source: 'completed-summary', exitCode: summary.exitCode, completedAt: summary.completedAt };
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  return null;
}

if (staticCheck) {
  const main = { pid: 10, ppid: 1, name: 'electron.exe', executable: join(repository, 'node_modules/electron/dist/electron.exe'), command: `electron.exe "--app=${appEntry}" --zcode-e2e-run-id=${targetRunId} "--zcode-e2e-home=${targetHome}"`, createdAt: '2026-11-06T00:00:00Z', cpuTicks: '10000000' };
  const renderer = { ...main, pid: 11, ppid: 10, command: '--type=renderer', cpuTicks: '15000000' };
  const host = { ...main, pid: 12, ppid: 10, command: '--type=utility --utility-sub-type=node.mojom.NodeService' };
  const valueQuoted = `"C:\\Program Files\\electron.exe" --app="${appEntry}" --zcode-e2e-run-id="${targetRunId}" --zcode-e2e-home="${targetHome}"`;
  const probe = command => exactMain({ ...main, command });
  const checks = {
    wholeTokenQuotesAccepted: exactMain(main),
    valueQuotesAccepted: probe(valueQuoted),
    unquotedAccepted: probe(`electron.exe --app=${appEntry} --zcode-e2e-run-id=${targetRunId} --zcode-e2e-home=${targetHome}`),
    mixedQuotesAccepted: probe(`electron.exe --app="${appEntry}" --zcode-e2e-run-id=${targetRunId} "--zcode-e2e-home=${targetHome}"`),
    windowsPathCaseAndSlashAccepted: probe(valueQuoted.replace(appEntry, normalize(appEntry)).replace(targetHome, normalize(targetHome).toUpperCase())),
    quotedRunSuffixRejected: !probe(valueQuoted.replace(targetRunId, `${targetRunId}-other`)),
    quotedHomeSuffixRejected: !probe(valueQuoted.replace(targetHome, `${targetHome}-other`)),
    quotedAppSuffixRejected: !probe(valueQuoted.replace(appEntry, `${appEntry}-other`)),
    oldFirstRunRejected: !probe(main.command.replaceAll(targetRunId, 'qa-menu-20261106-grp-pin-repro')),
    oldRetryRunRejected: !probe(main.command.replaceAll(targetRunId, 'qa-menu-20261106-grp-pin-repro-retry')),
    duplicateAppRejected: !probe(valueQuoted + ` --app="${appEntry}"`),
    duplicateHomeRejected: !probe(valueQuoted + ` "--zcode-e2e-home=${targetHome}"`),
    duplicateRunRejected: !probe(valueQuoted + ` --zcode-e2e-run-id=${targetRunId}`),
    splitAppAmbiguityRejected: !probe(valueQuoted + ' --app ignored'),
    unclosedQuoteRejected: !probe(valueQuoted + ' "'),
    singleQuoteWrapperRejected: !probe(`electron.exe '--app=${appEntry}' --zcode-e2e-run-id=${targetRunId} --zcode-e2e-home=${targetHome}`),
    escapedLiteralQuoteRejected: !probe(valueQuoted.replace(appEntry, appEntry + '\\"')),
    embeddedMarkerRejected: !probe(valueQuoted.replace('--app=', 'x--app=')),
    alternateEntryRejected: !probe(valueQuoted.replace(appEntry, join(repository, 'packages/desktop/out/main/index.js'))),
    quotedChromiumChildRejected: !probe(valueQuoted + ' "--type=renderer"'),
    outsideExecutableRejected: !exactMain({ ...main, executable: join(repository + '-other', 'electron.exe') }),
    rendererRejectedAsMain: !exactMain(renderer),
    onlyKnownDescendants: descendants([main, renderer, host, { ...main, pid: 13, ppid: 1 }], 10).length === 3,
    predatingChildRejected: descendants([main, { ...renderer, createdAt: '2025-01-01T00:00:00Z' }], 10).length === 1,
    hostRoleFromExistingPerf: role(host, 10, { metrics: [{ pid: 12, name: 'zcode-host-local-1' }] }).role === 'host',
    oneCoreCpuPercent: cpuPercent({ ...renderer, cpuTicks: '35000000' }, { ...renderer, capturedAt: 1000 }, 3000) === 100,
    reusedPidCpuRejected: cpuPercent({ ...renderer, createdAt: 'reused' }, { ...renderer, capturedAt: 1000 }, 3000) === null,
    ambiguousRootDetected: [main, { ...main, pid: 14 }].filter(exactMain).length === 2,
  };
  if (Object.values(checks).some(value => !value)) throw new Error(`Sampler identity/resource static guard failed: ${Object.entries(checks).filter(([, value]) => !value).map(([name]) => name).join(', ')}`);
  console.log(JSON.stringify({ evidenceKind: 'Pure in-memory sampler identity/CPU guards; no process scan, timers, run directory or UI', targetRunId, checks: Object.keys(checks).length, passed: Object.keys(checks).length, details: checks, intervalMs, maxMs, rejectsPriorRun: true, exactHomeAndEntry: true, rejectsOutsideExecutable: true, detectsAmbiguousRoot: true, commandLinesPersisted: false }));
} else {
  if (process.platform !== 'win32') throw new Error('This approved sampler is Windows-only');
  if (process.env.NODE_OPTIONS) throw new Error('Sampler requires cleared external Node loaders');
  for (const name of ['HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'TSX_CACHE_DIR', 'npm_config_cache', 'npm_config_store_dir', 'npm_config_userconfig', 'COREPACK_HOME', 'ZCODE_DATA_BASE_DIR']) {
    if (!process.env[name]) throw new Error(`Sampler requires isolated ${name}`);
    await safe(process.env[name]);
  }
  if (process.env.NODE_COMPILE_CACHE) await safe(process.env.NODE_COMPILE_CACHE);
  for (const path of [logs, runtime, targetHome, appRoot]) await safe(path);
  try { await lstat(runtime); throw new Error('Sampler requires a new runId; start sampler before the QA wrapper'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await lstat(appRoot); throw new Error('Sampler refuses a preexisting staged app for the fixed retry'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await lstat(join(logs, `e2e-${targetRunId}.log.exit-code.txt`)); throw new Error('Sampler refuses existing run completion evidence'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const startedAt = Date.now();
  const stem = join(logs, `validation-grp-pin-sampler-${startedAt}`);
  const output = await safe(stem + '.ndjson');
  const outputHandle = await open(output, 'wx');
  const append = value => outputHandle.write(JSON.stringify(value) + '\n');
  const sourceSha256 = createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex');
  const tracked = new Map();
  const previous = new Map();
  let main = null;
  let samples = 0;
  let stopReason = 'duration-limit';
  let completion = null;
  await append({ kind: 'start', capturedAt: new Date(startedAt).toISOString(), targetRunId, intervalMs, maxMs, sourceSha256, scope: 'Only exact main identity and its descendants; no UI/CDP requests or process termination', logicalCpus: availableParallelism() });
  console.log(JSON.stringify({ output, targetRunId, intervalMs, maxMs, startedAt: new Date(startedAt).toISOString() }));
  try {
    while (Date.now() - startedAt < maxMs) {
      const cycleStarted = Date.now();
      completion = await runEnded();
      const rows = await rowsFromWmi();
      const capturedAt = Date.now();
      if (!main) {
        const candidates = rows.filter(exactMain);
        if (candidates.length > 1) throw new Error('Ambiguous same-run main identity; sampler refuses multiple roots');
        if (candidates.length === 1) {
          // 首次锁定前再次审查已物化的路径，防止词法在本树而实际通过重解析点越界。
          for (const path of [candidates[0].executable, appEntry, targetHome]) await safe(path);
          main = { pid: candidates[0].pid, createdAt: candidates[0].createdAt };
        }
      }
      const currentMain = main && rows.find(row => row.pid === main.pid && row.createdAt === main.createdAt);
      const descendantsNow = currentMain ? descendants(rows, main.pid) : [];
      for (const row of descendantsNow) tracked.set(row.pid, row.createdAt);
      const selected = rows.filter(row => tracked.get(row.pid) === row.createdAt);
      const perf = await tailJsonLines(join(runtime, 'evidence/perf/process-samples-0-0.ndjson'));
      const processes = selected.map(row => {
        const cpu = cpuPercent(row, previous.get(row.pid), capturedAt);
        previous.set(row.pid, { createdAt: row.createdAt, cpuTicks: row.cpuTicks, capturedAt });
        return { pid: row.pid, ppid: row.ppid, name: row.name, createdAt: row.createdAt, ...role(row, main?.pid, perf), cpuPercentOfOneCore: cpu, cpuPercentOfSystem: cpu === null ? null : cpu / availableParallelism(), workingSetBytes: row.workingSetBytes, threads: row.threads, handles: row.handles, runMarker: marker(row.command, '--zcode-e2e-run-id', targetRunId), homeMarker: marker(row.command, '--zcode-e2e-home', targetHome, true), executableInWorktree: normalize(row.executable).startsWith(normalize(repository) + '/') };
      });
      await append({ kind: 'sample', capturedAt: new Date(capturedAt).toISOString(), cycleMs: capturedAt - cycleStarted, main, mainAlive: Boolean(currentMain), exactRootFound: Boolean(main), perfRoleSnapshotAt: perf?.capturedAt ?? null, trackedAbsentOrReusedPids: [...tracked].filter(([pid, createdAt]) => !rows.some(row => row.pid === pid && row.createdAt === createdAt)).map(([pid]) => pid), processes });
      samples++;
      if (completion) { stopReason = 'run-completed'; break; }
      await new Promise(resolveDelay => setTimeout(resolveDelay, Math.max(0, intervalMs - (Date.now() - cycleStarted))));
    }
  } catch (error) {
    stopReason = 'observer-read-error';
    await append({ kind: 'observer-error', capturedAt: new Date().toISOString(), code: error.code ?? null, message: error.message });
    process.exitCode = 1;
  } finally {
    const summary = { capturedAt: new Date().toISOString(), startedAt: new Date(startedAt).toISOString(), targetRunId, intervalMs, maxMs, sourceSha256, samples, main, stopReason, completion, output, noUiOrKill: true, roleBoundary: 'Host names reuse existing per-run WDIO perf; unknown utility remains unclassified; no command lines saved' };
    await writeFile(await safe(stem + '.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
    await append({ kind: 'stop', ...summary });
    await outputHandle.close();
    console.log(JSON.stringify(summary));
  }
}
