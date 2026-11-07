import { execFile } from "node:child_process";
import { lstat, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { collectE2EProcessTreePids, type E2EProcessInfo } from "../../../packages/desktop/test/e2e/helpers/e2e-process-cleanup.js";

interface ObservationPaths { artifacts: string; observerSourceSha256: string; hookSourceSha256: string }
interface ProcessRow extends E2EProcessInfo { name: string; createdAt: string; executable: string }
interface Observation { paths: ObservationPaths; test: Mocha.Test; stem: string; events: Record<string, unknown>[]; oldMainPid?: number; initialPids?: number[]; active: boolean }
const observations = new WeakMap<WebdriverIO.Browser, Observation>();
const installed = new WeakSet<WebdriverIO.Browser>();
const repository = resolve(import.meta.dirname, "../../..");
let counter = 0;

async function safePath(candidate: string) {
  const absolute = resolve(candidate);
  const rel = relative(repository, absolute);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("QA reload evidence escapes worktree");
  for (let cursor = absolute; ; cursor = dirname(cursor)) {
    try {
      if ((await lstat(cursor)).isSymbolicLink() || (await realpath(cursor)).toLowerCase() !== cursor.toLowerCase()) throw new Error("QA reload evidence refuses redirected ancestors");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (cursor === parse(cursor).root) break;
  }
  return absolute;
}

function errorChain(value: unknown): unknown {
  if (!value || typeof value !== "object") return value == null ? null : String(value);
  const error = value as { name?: string; message?: string; code?: string; cause?: unknown };
  return { name: error.name ?? null, message: error.message ?? null, code: error.code ?? null, cause: error.cause ? errorChain(error.cause) : null };
}

async function processRows(): Promise<ProcessRow[]> {
  if (process.platform !== "win32") throw new Error("This read-only PID observer is Windows-only");
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,@{Name='CreatedAt';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress";
  const output = await new Promise<string>((resolveOutput, rejectOutput) => {
    execFile("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true, maxBuffer: 20 * 1024 * 1024, timeout: 10000 }, (error, stdout) => error ? rejectOutput(error) : resolveOutput(stdout));
  });
  const parsed = JSON.parse(output) as Record<string, unknown> | Record<string, unknown>[];
  return (Array.isArray(parsed) ? parsed : [parsed]).map(row => ({ pid: Number(row.ProcessId), ppid: Number(row.ParentProcessId), name: String(row.Name ?? ""), createdAt: String(row.CreatedAt ?? ""), executable: String(row.ExecutablePath ?? ""), command: String(row.CommandLine ?? "") }));
}

async function captureProcesses(observation: Observation, phase: string) {
  const rows = await processRows();
  const homeDir = process.env.ZCODE_E2E_HOME_DIR?.trim();
  const runId = process.env.ZCODE_E2E_RUN_ID?.trim();
  if (!homeDir || !runId) throw new Error("QA reload observer lacks isolated run identity");
  await safePath(homeDir);
  const pids = collectE2EProcessTreePids(rows, { currentPid: process.pid, homeDir, runId, includeChromeDriverAncestors: false, rootPids: observation.oldMainPid ? [observation.oldMainPid] : [] });
  if (phase === "before-delete") observation.initialPids = pids;
  const wanted = new Set([...pids, ...(observation.initialPids ?? [])]);
  // 完整命令行仅用于现有身份解析；证据只保留PID、创建时间及布尔marker，避免导出其它进程内容。
  observation.events.push({ phase, capturedAt: new Date().toISOString(), oldMainPid: observation.oldMainPid ?? null, helperEquivalentCollectedPids: pids, initialPidsAbsentNow: (observation.initialPids ?? []).filter(pid => !rows.some(row => row.pid === pid)), processes: rows.filter(row => wanted.has(row.pid)).map(row => ({ pid: row.pid, ppid: row.ppid, name: row.name, createdAt: row.createdAt, executableInWorktree: row.executable.toLowerCase().startsWith(repository.toLowerCase() + "\\"), runMarker: row.command.includes(runId), homeMarker: row.command.includes(homeDir) || row.command.includes(homeDir.replaceAll("\\", "/")), chromeDriver: /chromedriver/iu.test(row.name) })) });
}

/** 只读捕获reload前的权威main PID；保持原delete、timeout和退出屏障，无sleep或kill。 */
export async function beginReloadObservation(context: Mocha.Context, paths: ObservationPaths) {
  if (process.platform !== "win32" || !context.currentTest) return;
  const artifacts = await safePath(paths.artifacts);
  const worker = (process.env.WDIO_WORKER_ID || String(process.pid)).replace(/[^a-zA-Z0-9_-]/gu, "_");
  observations.set(browser, { paths, test: context.currentTest, stem: join(artifacts, `qa-reload-observe-${worker}-${++counter}-${process.pid}-${Date.now()}`), events: [], active: true });
  if (installed.has(browser)) return;
  browser.overwriteCommand("deleteSession" as never, (async function (this: WebdriverIO.Browser, original: (...args: unknown[]) => Promise<unknown>, ...args: unknown[]) {
    const observation = observations.get(this);
    const request = args[0] as { shutdownDriver?: boolean; deleteSessionOpts?: { shutdownDriver?: boolean } } | undefined;
    const reload = request?.shutdownDriver === false || request?.deleteSessionOpts?.shutdownDriver === false;
    if (observation?.active && reload) {
      try {
        observation.oldMainPid = await this.electron.execute(() => process.pid) as number;
        await captureProcesses(observation, "before-delete");
      } catch (error) { observation.events.push({ phase: "observer-read-error", error: errorChain(error) }); }
      observation.events.push({ phase: "original-delete-call", capturedAt: new Date().toISOString() });
    }
    try { return await original(...args); }
    finally { if (observation?.active && reload) observation.events.push({ phase: "original-delete-return", capturedAt: new Date().toISOString() }); }
  }) as never);
  installed.add(browser);
}

/** afterEach读取完整cause和残留PID；即便协议session已失效也不调用Renderer或改变应用。 */
export async function finishReloadObservation(context: Mocha.Context) {
  const observation = observations.get(browser);
  if (!observation?.active) return;
  observation.active = false;
  if (observation.events.length === 0 && !/Electron reload/iu.test(context.currentTest?.err?.message ?? "")) return;
  try { await captureProcesses(observation, "after-test"); }
  catch (error) { observation.events.push({ phase: "observer-read-error", error: errorChain(error) }); }
  const target = await safePath(observation.stem + ".json");
  await writeFile(target, JSON.stringify({ capturedAt: new Date().toISOString(), evidenceKind: "read-only Windows E2E reload process identity and Error.cause; no timeout override, no process termination, no product change", test: { file: observation.test.file, title: observation.test.title, state: observation.test.state, error: errorChain(context.currentTest?.err) }, ...observation.paths, events: observation.events }, null, 2) + "\n", { flag: "wx" });
}
