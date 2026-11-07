import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ZipFile } from "yazl";
import { ServiceChannels, type ConversationArchiveContent } from "@zcode/shared";
import type { ConversationArchiveInput } from "../../../../../packages/services/src/node.js";
import { DEFAULT_WORKSPACE, readSettings } from "../../../../../packages/desktop/test/e2e/helpers/desktop-app.js";
import { getV4PaneSnapshot, prepareV4ConversationE2E, setV4ComposerText, waitForV4ComposerText } from "../../../../../packages/desktop/test/e2e/helpers/v4-conversation.js";
import { callHandoffHost } from "../../../../../packages/desktop/test/e2e/helpers/remote-project-handoff-probe.js";
import { installLocalQaRpcProbe } from "../../qa-local-rpc-probe.js";
import { readQaPreviewLines } from "../../qa-preview-dom.js";
import { visibleControl, visibleControls, clickVisibleControl, closeVisibleMenus } from "../../qa-menu-dom.js";
import { countUpstreamRequests } from "../../../../../packages/desktop/test/e2e/helpers/conversation-session-network.js";
import { startElectronWindowRecording, type ElectronWindowRecordingSession } from "../../../../../packages/desktop/test/e2e/helpers/electron-window-recorder.js";

// 本轮外置 QA：真实菜单/离线Host导入，仅拦系统出口；不修改产品/旧spec。
const REPOSITORY = resolve(fileURLToPath(new URL("../../../../../", import.meta.url)));
// docs 不在 desktop 的 node_modules 解析链内；从 desktop 的公开 package export 解析。
const desktopRequire = createRequire(join(REPOSITORY, "packages/desktop/package.json"));
const servicesPublicEntry = await safe(desktopRequire.resolve("@zcode/services/node"));
const { encodeConversationArchive, decodeConversationArchive } = await import(pathToFileURL(servicesPublicEntry).href) as typeof import("../../../../../packages/services/src/node.js");
const CENTER = '[role="dialog"] [cmdk-input]';
const ITEMS = '[role="dialog"] [cmdk-item]';
const IMPORT_BUTTON = '[data-testid="task-new-button"] button[aria-label="Conversation options"], [data-testid="task-new-button"] button[aria-label="对话选项"]';
const USER_MARKER = "RLM_TASK_USER_中文";
const ASSISTANT_MARKER = "RLM_TASK_ASSISTANT_中文";
const TITLE = "RLM_TASK_中文_01";
const FILE_NAME = "RLM_中文 空格.txt";
const FILE_CONTENT = "RLM_FILE_CONTENT_中文 空格";
let evidenceRoot: string;
let fixtureRoot: string;
let databasePath: string;
let home: string;
let alpha: ImportedTask;
let betaFile: string;
let alphaFile: string;
let baselineRequests = 0;
let originalPreferences: {locale: string; theme: string};
let sequence = 0;
type ImportedTask = {taskId: string; workspacePath: string; workspaceIdentity?: string; executionWorkspacePath: string};
type TaskIndexRow = {task_id: string; workspace_path: string; workspace_key: string; title: string; unread_at: number | null; meta_json: string};
interface Adapters {
  clips: Array<{method: string; text: string}>;
  rejectClipboard: boolean;
  pickerCount: number;
  selected?: HTMLInputElement;
  restore(): void;
}
declare global { interface Window { __qaResidualAdapters?: Adapters; __zcodeTabStoreE2E?: {getState(): {activeWorkspacePath?: string | null; activeWorkspaceIdentity?: string | null}} } }

async function safe(candidate: string) {
  if (!isAbsolute(candidate)) throw new Error("RLM requires absolute paths");
  const target = resolve(candidate);
  const rel = relative(REPOSITORY, target);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("RLM path escapes worktree");
  for (let cursor = target; ; cursor = dirname(cursor)) {
    try {
      if ((await lstat(cursor)).isSymbolicLink() || (await realpath(cursor)).toLowerCase() !== cursor.toLowerCase()) throw new Error("RLM refuses links/redirected ancestors");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (cursor === dirname(cursor)) break;
  }
  return target;
}
async function auditTree(target: string) {
  await safe(target);
  const guard = await safe(join(REPOSITORY, "docs/testing/qa-2026-11-06/qa-reparse-children.ps1"));
  const script = readFileSync(guard, "utf8") + "\n$ErrorActionPreference='Stop'; $target=$env:RLM_AUDIT_TARGET; $cursor=[IO.Path]::GetFullPath($target); while($cursor) { if(Test-Path -LiteralPath $cursor) { if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'RLM refuses reparse ancestors' } }; $cursor=[IO.Path]::GetDirectoryName($cursor) }; if(Test-Path -LiteralPath $target -PathType Container) { $queue=[Collections.Generic.Queue[string]]::new(); $queue.Enqueue($target); while($queue.Count) { foreach($child in Get-QaAuditChildren $queue.Dequeue()) { if($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'RLM refuses descendant reparse points' }; if($child.PSIsContainer) { $queue.Enqueue($child.FullName) } } } }";
  execFileSync("C:\\Program Files\\PowerShell\\7\\pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {env: {...process.env, RLM_AUDIT_TARGET: target, QA_REPARSE_WORKTREE: REPOSITORY}, windowsHide: true, stdio: "pipe", timeout: 30_000});
}
async function preparePaths() {
  if (process.platform !== "win32" || process.env.E2E_PROVIDER_HTTP_MODE !== "replay" || process.env.ZCODE_E2E_MANUAL_REVIEW !== "1") throw new Error("RLM requires isolated Windows pending replay");
  for (const name of ["HOME","USERPROFILE","TEMP","TMP","TMPDIR","APPDATA","LOCALAPPDATA","COREPACK_HOME","PNPM_HOME","npm_config_cache","npm_config_store_dir","npm_config_userconfig","TSX_CACHE_DIR","NODE_COMPILE_CACHE","XDG_CACHE_HOME","XDG_CONFIG_HOME","XDG_DATA_HOME","ZCODE_E2E_HOME_DIR","ZCODE_E2E_ARTIFACT_DIR"]) await safe(process.env[name] || "");
  home = await safe(process.env.ZCODE_E2E_HOME_DIR!);
  databasePath = await safe(join(home, ".zcodium/v2/tasks-index.sqlite"));
  if (resolve(DEFAULT_WORKSPACE) !== join(home, "ZCodeProject")) throw new Error("RLM DEFAULT_WORKSPACE mismatch");
  const artifacts = await safe(process.env.ZCODE_E2E_ARTIFACT_DIR!);
  await auditTree(home); await auditTree(artifacts);
  const worker = (process.env.WDIO_WORKER_ID || String(process.pid)).replace(/[^a-zA-Z0-9_-]/gu, "_");
  const files = (await readdir(artifacts)).filter((name) => name.startsWith(`qa-project-bootstrap-${worker}-`) && name.endsWith("-after.json"));
  const snapshots = await Promise.all(files.map(async (name) => JSON.parse(await readFile(await safe(join(artifacts, name)), "utf8"))));
  if (!snapshots.some((item) => item.workerId === worker && item.database === databasePath && item.projects?.some((project: {host_id: string; name: string; deleted: number}) => project.host_id === "local" && project.name === "ZCodeProject" && !project.deleted))) throw new Error("RLM isolated bootstrap evidence missing");
  const suffix = `${worker}-${process.pid}-${Date.now()}`;
  evidenceRoot = await safe(join(artifacts, `qa-residual-local-menus-${suffix}`));
  fixtureRoot = await safe(join(DEFAULT_WORKSPACE, ".zcode-e2e", `qa-residual-${suffix}`));
  await mkdir(evidenceRoot); await mkdir(fixtureRoot, {recursive: true});
}
async function indexRows() {
  await auditTree(databasePath);
  const db = new DatabaseSync(databasePath, {readOnly: true});
  try { return db.prepare("SELECT task_id,workspace_path,workspace_key,title,unread_at,meta_json FROM tasks WHERE cli_deleted=0").all() as TaskIndexRow[]; }
  finally { db.close(); }
}
async function visible(selector: string, pattern?: RegExp) {
  return visibleControl(selector, pattern);
}
async function click(selector: string, pattern?: RegExp) {
  await clickVisibleControl(selector, pattern, "RLM");
}
async function closeOverlays() {
  await closeVisibleMenus("RLM");
  if ((await visibleControls('[role="dialog"]')).length) await browser.keys("Escape");
  if (await visible('[data-testid="settings-page"]')) await click('[data-testid="settings-back-button"]');
}
async function choosePresentation(kind: "locale" | "theme", value: string) {
  await closeOverlays(); await click('[data-testid="sidebar-preferences-trigger"]');
  const labels = kind === "locale" ? /^(Language|界面语言)$/u : /^(App theme|界面主题)$/u;
  const selector = '[role="menuitem"][aria-haspopup="menu"]';
  await click(selector, labels);
  await browser.waitUntil(async()=>(await visibleControls(selector, labels))[0]?.state === "open",{timeout:10_000});
  const radio = value === "en-US" ? /^English$/u : value === "zh-CN" ? /^中文简体$/u : value === "zai-dark" ? /^(Dark theme|深色主题)$/u : value === "zai-light" ? /^(Light theme|浅色主题)$/u : /^(System default|跟随系统|系统默认)$/u;
  await click('[role="menuitemradio"]', radio);
  await browser.waitUntil(() => browser.execute((kind, value) => kind === "locale" ? localStorage.getItem("zcode-locale-preference") === value : localStorage.getItem("zcode-theme") === value, kind, value), {timeout:15_000});
  if (kind === "locale") await browser.waitUntil(async () => { const settings = await readSettings(); return settings.localePreference === value && (value === "system" || settings.locale === value); }, {timeout:15_000, timeoutMsg:"RLM persisted resolved locale did not converge"});
}
async function installAdapters() {
  // 仅适配器用rawJS，确保属性callback不携带tsx keepNames的__name闭包。
  await browser.execute(`
    if (window.__qaResidualAdapters) return;
    const clipboard = navigator.clipboard;
    if (!clipboard) throw new Error("RLM Clipboard API missing");
    const textDescriptor = Object.getOwnPropertyDescriptor(clipboard, "writeText");
    const writeDescriptor = Object.getOwnPropertyDescriptor(clipboard, "write");
    const inputClick = HTMLInputElement.prototype.click;
    const state = {clips: [], rejectClipboard: false, pickerCount: 0, restore() {
      if (this.selected?.isConnected) this.selected.dispatchEvent(new Event("cancel"));
      HTMLInputElement.prototype.click = inputClick;
      if (textDescriptor) Object.defineProperty(clipboard, "writeText", textDescriptor); else delete clipboard.writeText;
      if (writeDescriptor) Object.defineProperty(clipboard, "write", writeDescriptor); else delete clipboard.write;
      delete window.__qaResidualAdapters;
    }};
    Object.defineProperty(clipboard, "writeText", {configurable:true, value: async (text) => {
      if (state.rejectClipboard) throw new Error("RLM synthetic clipboard rejection");
      state.clips.push({method:"writeText", text});
    }});
    Object.defineProperty(clipboard, "write", {configurable:true, value: async (items) => {
      if (state.rejectClipboard) throw new Error("RLM synthetic clipboard rejection");
      for (const item of items) {
        if (!item.types.includes("text/plain")) throw new Error("RLM only permits synthetic text clipboard");
        state.clips.push({method:"write", text: await (await item.getType("text/plain")).text()});
      }
    }});
    Object.defineProperty(HTMLInputElement.prototype, "click", {configurable:true,writable:true,value:function() {
      if (this.type === "file" && this.accept === ".zcodium") { state.selected = this; state.pickerCount++; return; }
      inputClick.call(this);
    }});
    window.__qaResidualAdapters = state;
  `);
}
async function pickerOpen() {
  await closeOverlays(); await click(IMPORT_BUTTON);
  await click('[role="menuitem"]', /^(Import from file…|从文件导入…)$/u);
  await browser.waitUntil(() => browser.execute(() => Boolean(window.__qaResidualAdapters?.selected?.isConnected)), {timeout:15_000, timeoutMsg:"RLM actual archive input not created"});
  const state = await browser.execute(() => ({accept:window.__qaResidualAdapters!.selected!.accept, count:document.querySelectorAll('input[type="file"][accept=".zcodium"]').length}));
  expect(state).toEqual({accept:".zcodium", count:1});
}
async function pickerChoose(file: string) {
  await safe(file); const data = await readFile(file);
  await browser.execute((bytes: number[], name: string) => {
    const state = window.__qaResidualAdapters!;
    const input = state.selected;
    if (!input?.isConnected) throw new Error("RLM selected file input missing");
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(bytes)], name, {type:"application/octet-stream"}));
    input.files = transfer.files; input.dispatchEvent(new Event("change", {bubbles:true}));
  }, Array.from(data), file.split(/[\\/]/u).at(-1)!);
  await waitImportIdle();
}
async function waitImportIdle() {
  await browser.waitUntil(async () => (await $(IMPORT_BUTTON).getAttribute("aria-busy")) !== "true" && await browser.execute(() => document.querySelectorAll('input[type="file"][accept=".zcodium"]').length === 0), {timeout:45_000, timeoutMsg:"RLM import busy/input not released"});
}
async function zipManifest(manifest: unknown) {
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(manifest)), "manifest.json"); zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
export function residualArchiveInput(title = TITLE): ConversationArchiveInput {
  const base = {turnId:"share-turn-1", productTurnId:"share-product-turn-1"};
  const rows: ConversationArchiveContent["rows"] = [
    {...base,rowId:1,entityId:"share-entity-1",createdAt:1,createdAtSeq:1,kind:"turnHeader",origin:"userInput",state:"completedSuccess",startedAt:1,endedAt:3},
    {...base,rowId:2,entityId:"share-entity-2",createdAt:2,createdAtSeq:2,kind:"userInput",origin:"realUser",text:USER_MARKER},
    {...base,rowId:3,entityId:"share-entity-3",createdAt:3,createdAtSeq:3,kind:"assistantText",state:"complete",text:ASSISTANT_MARKER},
  ];
  return {title,selectedProductTurnIds:["share-product-turn-1"],rows,artifacts:[]};
}
async function writeArchive(title: string, name: string) {
  const bytes = await encodeConversationArchive(residualArchiveInput(title));
  const decoded = await decodeConversationArchive(bytes);
  expect(decoded.content.rows).toHaveLength(3); expect(decoded.artifacts.size).toBe(0);
  const file = await safe(join(fixtureRoot, name)); await writeFile(file, bytes, {flag:"wx"}); return file;
}
async function readImportedTask(title: string): Promise<ImportedTask> {
  const locale = (await readSettings()).locale;
  if (locale !== "en-US" && locale !== "zh-CN") throw new Error("RLM resolved locale unavailable");
  const importedTitle = `${locale === "en-US" ? "Imported: " : "导入："}${title}`;
  await browser.waitUntil(async () => (await indexRows()).some((row) => row.title === importedTitle), {timeout:30_000, timeoutMsg:"RLM imported task title did not persist"});
  const row = (await indexRows()).find((item) => item.title === importedTitle)!;
  await browser.waitUntil(async () => (await getV4PaneSnapshot()).sessionId === row.task_id, {timeout:30_000, timeoutMsg:"RLM imported task did not activate"});
  expect((await getV4PaneSnapshot()).sessionId).toBe(row.task_id);
  const identity = row.workspace_key !== row.workspace_path ? row.workspace_key : undefined;
  const target = {workspacePath:row.workspace_path,workspaceIdentity:identity,sessionIds:[row.task_id],includeArchived:true};
  const sessions = await callHandoffHost<Array<{sessionId:string;executionWorkspacePath?:string}>>(ServiceChannels.ZCodeSession,"listSessions",[target]);
  const matchingSession = sessions.find((item) => item.sessionId === row.task_id);
  let execution = matchingSession ? matchingSession.executionWorkspacePath?.trim() || row.workspace_path : undefined;
  if (!matchingSession) {
    const snapshot = await callHandoffHost<{session:{sessionId:string;executionWorkspacePath?:string}}>(ServiceChannels.ZCodeAgent,"readSession",[{sessionId:row.task_id,workspacePath:row.workspace_path,workspaceIdentity:identity,messageLimit:1,runtimePolicy:"existing-only"}]);
    if (snapshot.session.sessionId !== row.task_id) throw new Error("RLM exact imported session query mismatch");
    execution = snapshot.session.executionWorkspacePath?.trim() || row.workspace_path;
  }
  if (!execution) throw new Error("RLM imported session has no authoritative execution path");
  await safe(execution); await auditTree(execution);
  await browser.waitUntil(() => browser.execute((user, assistant) => { const notice = document.querySelector<HTMLElement>('[data-conversation-share-import-notice="true"]'); return notice?.innerText.includes(user) === true && notice.innerText.includes(assistant); },USER_MARKER,ASSISTANT_MARKER), {timeout:30_000, timeoutMsg:"RLM imported public readonly user/assistant rows not visible"});
  return {taskId:row.task_id,workspacePath:row.workspace_path,workspaceIdentity:identity,executionWorkspacePath:execution};
}
async function importFile(file: string, title: string) { await pickerOpen(); await pickerChoose(file); return readImportedTask(title); }
const taskRow = () => `[data-testid="task-item-${alpha.taskId}"]`;
async function activateAlpha() {
  await closeOverlays();
  if (!(await visible(taskRow()))) { await click('[data-testid="sidebar-view-menu"]'); await click('[data-testid="sidebar-view-timeline"]'); }
  await click(taskRow());
  await browser.waitUntil(async () => (await getV4PaneSnapshot()).sessionId === alpha.taskId, {timeout:20_000});
}
async function taskMenu(label: RegExp) { await activateAlpha(); await $(taskRow()).click({button:"right"}); await click('[role="menuitem"]',label); }
async function clipCount() { return browser.execute(() => window.__qaResidualAdapters!.clips.length); }
async function newClip(before: number) {
  await browser.waitUntil(async () => await clipCount() === before+1, {timeout:20_000, timeoutMsg:"RLM clipboard write not captured exactly once"});
  return browser.execute((index) => window.__qaResidualAdapters!.clips[index]!,before);
}
async function markdownCopy() { await activateAlpha(); await click('[data-testid="workspace-more-button"]'); await click('[data-testid="task-copy-markdown"]'); }
async function openCenter(scope: "all"|"commands"|"conversations"|"files", query = "") {
  await closeOverlays(); await click('[data-testid="sidebar-search-open"]'); await $(CENTER).waitForDisplayed({timeout:15_000});
  const labels = {all:/^(All|全部)$/u, commands:/^(Actions|操作)$/u, conversations:/^(Tasks|任务)$/u, files:/^(Files|文件)$/u};
  const label = labels[scope];
  await click('[role="dialog"] [role="tab"]',label);
  await $(CENTER).setValue(query);
  const explicitScope = query.trimStart().startsWith(">") ? "commands" : query.trimStart().startsWith("#") ? "conversations" : query.trimStart().startsWith("@") ? "files" : scope;
  await browser.waitUntil(async () => (await $('[role="dialog"] [role="tab"][aria-selected="true"]').getText()).trim().match(labels[explicitScope]) !== null, {timeout:10_000});
  expect(await $$('[role="dialog"] [role="tab"][aria-selected="true"]')).toHaveLength(1);
}
async function chooseCenterResult(pattern: RegExp) {
  let target: Awaited<ReturnType<typeof visible>>;
  await browser.waitUntil(async () => Boolean(target = await visible(ITEMS,pattern)), {timeout:25_000, timeoutMsg:`RLM command center result missing: ${pattern.source}`});
  const value = await target!.getAttribute("data-value");
  await target!.moveTo();
  await browser.waitUntil(async () => (await target!.getAttribute("aria-selected")) === "true", {timeout:5000});
  expect(await $$('[role="dialog"] [cmdk-item][aria-selected="true"]')).toHaveLength(1);
  await browser.keys("ArrowDown"); await browser.keys("ArrowUp");
  expect(await target!.getAttribute("aria-selected")).toBe("true");
  await browser.keys("Enter");
  await $(CENTER).waitForExist({reverse:true,timeout:15_000});
  return value;
}
async function currentCenterTransition() {
  return browser.execute(`const dialog=document.querySelector('[role="dialog"]');return {input:dialog?.querySelector('input')?.value??null,headings:[...(dialog?.querySelectorAll('[cmdk-group-heading]')??[])].map(node=>node.textContent||''),items:[...(dialog?.querySelectorAll('[cmdk-item]')??[])].map(node=>({value:node.getAttribute('data-value'),text:node.textContent||'',selected:node.getAttribute('aria-selected')}))};`);
}
async function openSettings(section: string) {
  await closeOverlays(); await click('[data-testid="task-settings-button"]');
  await click(`[data-settings-section-nav="${section}"]`);
  await browser.waitUntil(() => browser.execute(() => {const main=document.querySelector('[data-testid="settings-page"] main'); return main && !/^(加载中…|加载中\.\.\.|Loading…|Loading\.\.\.)$/u.test((main.textContent||"").trim());}), {timeout:20_000});
}
async function fingerprintFiles(target: string): Promise<Record<string,string>> {
  await auditTree(target); const result:Record<string,string>={};
  const walk = async (directory:string):Promise<void> => {
    let entries; try {entries=await readdir(directory,{withFileTypes:true});} catch(error) {if((error as NodeJS.ErrnoException).code==="ENOENT") return; throw error;}
    for(const entry of entries) {const child=await safe(join(directory,entry.name)); if(entry.isDirectory()) await walk(child); else if(entry.isFile()) result[relative(target,child)]=createHash("sha256").update(await readFile(child)).digest("hex");}
  };
  await walk(target);return result;
}
async function mcpConfigFingerprint() {
  const result:Record<string,string|null>={};
  for(const candidate of [join(home,".zcodium/cli/config.json"),join(home,".agents/mcp.json"),join(alpha.executionWorkspacePath,".zcodium/config.json"),join(alpha.executionWorkspacePath,".agents/mcp.json")]) {
    const target=await safe(candidate);await auditTree(target);
    try {result[target]=createHash("sha256").update(await readFile(target)).digest("hex");}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;result[target]=null;}
  }
  return result;
}
async function capture(name: string, details: Record<string,unknown>) {
  const stem = await safe(join(evidenceRoot,`${String(++sequence).padStart(3,"0")}-${name}`));
  const state = await browser.execute(() => ({
    activePane:document.querySelector('[data-testid="v4-session-pane-workspace-main"]')?.getAttribute("data-session-id"),
    activeWorkspace:window.__zcodeTabStoreE2E?.getState().activeWorkspacePath ?? null,
    menus:Array.from(document.querySelectorAll('[role="menuitem"],[role="tab"]')).filter((element)=>element.checkVisibility()).map((element)=>({text:element.textContent,selected:element.getAttribute("aria-selected"),disabled:element.getAttribute("aria-disabled")})),
    centerQuery:(document.querySelector('[cmdk-input]') as HTMLInputElement|null)?.value ?? null,
    toasts:document.querySelector<HTMLElement>("#zcode-toast-host")?.innerText ?? null,
    theme:Array.from(document.documentElement.classList), dpr:window.devicePixelRatio,
    clipboard:window.__qaResidualAdapters?.clips ?? [], pickerCount:window.__qaResidualAdapters?.pickerCount ?? 0,
    history:Object.fromEntries(Object.keys(localStorage).filter((key)=>key.startsWith("zcode-command-center-search-history:")).map((key)=>[key,localStorage.getItem(key)])),
  }));
  const reservation=await open(stem+".png","wx");await reservation.close(); await browser.saveScreenshot(stem+".png");
  await writeFile(stem+".json",JSON.stringify({capturedAt:new Date().toISOString(),evidenceKind:"synthetic Windows local UI plus readonly index; no real clipboard/picker/provider",...details,state,index:await indexRows(),providerRequestCount:await countUpstreamRequests({})},null,2)+"\n",{flag:"wx"});
}
async function runCase(context:Mocha.Context,id:string,action:()=>Promise<void>) {
  context.timeout(150_000);
  const frameDir=await safe(join(evidenceRoot,`${id}-frames`));await auditTree(frameDir);
  let recording:ElectronWindowRecordingSession|undefined;
  try {
    await capture(id+"-before",{status:"before"});
    recording=await startElectronWindowRecording({browser,frameDir,outputPath:join(evidenceRoot,`${id}-unencoded.webm`),frameIntervalMs:1000,preRollDurationMs:0,cleanupFrames:false,encodeVideo:async()=>{throw new Error("No standard video encoder; PNG/time sequence retained");}});
    await action(); expect(await countUpstreamRequests({})).toBe(baselineRequests);
    await capture(id,{status:"passed"}); await auditTree(frameDir); await recording.discard(); recording=undefined;
  } catch(error) {
    let evidence:unknown;
    try {if(recording) {await auditTree(frameDir); evidence=await recording.stop({tailDurationMs:500});}} catch(failure) {evidence={format:"PNG/time frame sequence; WebM not encoded",frames:frameDir,error:failure instanceof Error?failure.message:String(failure)};}
    await capture(id,{status:"failed",error:error instanceof Error?error.message:String(error),frameEvidence:evidence});throw error;
  } finally {await browser.execute(()=>{if(window.__qaResidualAdapters) window.__qaResidualAdapters.rejectClipboard=false;});}
}

describe("RLM 当前fork剩余本地菜单与离线导入（外置pending）",()=>{
  before(async function(){
    this.timeout(180_000);
    try {
      await preparePaths();await prepareV4ConversationE2E({skipProvider:true});
      originalPreferences=await browser.execute(()=>({locale:localStorage.getItem("zcode-locale-preference")||"system",theme:localStorage.getItem("zcode-theme")||"system"}));
      await choosePresentation("locale","en-US");await choosePresentation("theme","zai-light");
      await installAdapters();await installLocalQaRpcProbe();baselineRequests=await countUpstreamRequests({});
      alphaFile=await writeArchive(TITLE,"alpha.zcodium");betaFile=await writeArchive("RLM_TASK_中文_02","beta.zcodium");
      alpha=await importFile(alphaFile,TITLE);
      await writeFile(await safe(join(alpha.executionWorkspacePath,FILE_NAME)),FILE_CONTENT,{flag:"wx"});
      await capture("fixture-import",{status:"fixture",task:alpha,fixture:alphaFile});
    } catch (error) {
      if (evidenceRoot) {
        try { await capture("beforeAll-failure",{status:"setup-failed",error:error instanceof Error ? error.message : String(error)}); }
        catch (evidenceError) { throw new AggregateError([error,evidenceError],"RLM setup failed; failure evidence also failed"); }
      }
      throw error;
    }
  });
  afterEach(async()=>{await closeOverlays();});
  after(async()=>{
    if(originalPreferences) {await choosePresentation("locale",originalPreferences.locale);await choosePresentation("theme",originalPreferences.theme);}
    await browser.execute(()=>{window.__qaResidualAdapters?.restore();window.__remoteProjectHandoffRpc?.restore();});
    await browser.electron.restoreAllMocks();
  });
  it("RLM-01: 四种任务路径/ID复制及文件管理器出口",async function(){await runCase(this,"RLM01",async()=>{
    const target={workspacePath:alpha.workspacePath,workspaceIdentity:alpha.workspaceIdentity,taskId:alpha.taskId};
    const sessionFile=await callHandoffHost<{path:string}>(ServiceChannels.ZCodeTask,"getTaskSessionFilePath",[target]);
    const logFile=await callHandoffHost<{path:string;exists:boolean}>(ServiceChannels.ZCodeTask,"getTaskNativeSessionLogFile",[target]);
    for(const [label,expected] of [[/^(Copy path|复制路径)$/u,alpha.executionWorkspacePath],[/^(Copy task path|复制任务路径)$/u,sessionFile.path],[/^(Copy log path|复制日志路径)$/u,logFile.path],[/^(Copy session ID|复制会话 ID)$/u,alpha.taskId]] as const) {
      const before=await clipCount();await taskMenu(label);const clip=await newClip(before);expect(clip.text).toBe(expected);if(expected!==alpha.taskId) await safe(expected);
      await capture("RLM01-copy",{label:label.source,expected,logExists:logFile.exists});
    }
    const openPath=await browser.electron.mock("shell","openPath");await openPath.mockReturnValue("");
    const reveal=await browser.electron.mock("shell","showItemInFolder");await reveal.mockReturnValue(undefined);
    try {await taskMenu(/^(Open in File Manager|Open in File Explorer|Open in Explorer|在文件管理器中打开|在资源管理器中打开)$/u);await browser.waitUntil(async()=>{await openPath.update();return Boolean(openPath.mock.calls.length);},{timeout:15_000});await reveal.update();expect(openPath.mock.calls[0]![0]).toBe(alpha.executionWorkspacePath);expect(reveal.mock.calls).toHaveLength(0);} finally {await openPath.mockRestore();await reveal.mockRestore();}
  });});
  it("RLM-02: Markdown完整复制、受控拒绝后恢复重试",async function(){await runCase(this,"RLM02",async()=>{
    for(let repeat=0;repeat<2;repeat++){const before=await clipCount();await markdownCopy();const clip=await newClip(before);expect(clip.text).toContain(TITLE);expect(clip.text).toContain(USER_MARKER);expect(clip.text).toContain(ASSISTANT_MARKER);expect(clip.text).not.toContain("RLM_TASK_中文_02");}
    await browser.execute(()=>{window.__qaResidualAdapters!.rejectClipboard=true;});const before=await clipCount();await markdownCopy();
    await browser.waitUntil(()=>browser.execute(()=>/Copy failed|复制失败/u.test(document.querySelector<HTMLElement>("#zcode-toast-host")?.innerText||"")),{timeout:20_000});expect(await clipCount()).toBe(before);await capture("RLM02-rejected",{status:"expected-clipboard-error"});
    await browser.execute(()=>{window.__qaResidualAdapters!.rejectClipboard=false;});await markdownCopy();expect((await newClip(before)).text).toContain(ASSISTANT_MARKER);
  });});
  it("RLM-03: 真实标记未读与同任务清除、返回不反弹",async function(){await runCase(this,"RLM03",async()=>{
    await taskMenu(/^(Mark as unread|标记为未读)$/u);
    await browser.waitUntil(async()=>typeof (await indexRows()).find((row)=>row.task_id===alpha.taskId)?.unread_at==="number",{timeout:15_000});
    expect(await $(taskRow()).$(".bg-sky-500").isExisting()).toBe(true);await capture("RLM03-unread",{status:"expected-unread"});
    await click(taskRow());await browser.waitUntil(async()=>(await indexRows()).find((row)=>row.task_id===alpha.taskId)?.unread_at===null,{timeout:15_000});
    await click('[data-testid="task-new-button"] button:not([aria-label])');await activateAlpha();expect((await indexRows()).find((row)=>row.task_id===alpha.taskId)?.unread_at).toBeNull();expect(await $(taskRow()).$(".bg-sky-500").isExisting()).toBe(false);
    await choosePresentation("locale","zh-CN");await choosePresentation("theme","zai-dark");
  });});
  it("RLM-04: Command Center操作范围键盘进入设置",async function(){await runCase(this,"RLM04",async()=>{
    await activateAlpha();await openCenter("commands");expect(await $$(`${ITEMS}[data-value^="recent-task:"]`)).toHaveLength(0);await $(CENTER).setValue("设置");
    await chooseCenterResult(/^(设置|Settings)(?:\s|$)/u);await $('[data-testid="settings-page"]').waitForDisplayed({timeout:15_000});
  });});
  it("RLM-05: Command Center任务范围查询唯一ID并重开最近",async function(){await runCase(this,"RLM05",async()=>{
    await activateAlpha();const anchorTitle=`RLM_RECENT_ANCHOR_中文_${Date.now()}`;const anchor=await importFile(await writeArchive(anchorTitle,"recent-anchor.zcodium"),anchorTitle);
    expect(anchor.workspacePath).toBe(alpha.workspacePath);expect(anchor.workspaceIdentity).toBe(alpha.workspaceIdentity);expect(anchor.taskId).not.toBe(alpha.taskId);
    await openCenter("conversations");await browser.waitUntil(async()=>Boolean(await visible(`${ITEMS}[data-value^="recent-task:"]`,new RegExp(TITLE,"u"))),{timeout:15_000});await $(CENTER).setValue(TITLE);
    const value=await chooseCenterResult(new RegExp(TITLE,"u"));expect(value).toContain(alpha.taskId);await browser.waitUntil(async()=>(await getV4PaneSnapshot()).sessionId===alpha.taskId,{timeout:15_000});
    await click(`[data-testid="task-item-${anchor.taskId}"]`);await browser.waitUntil(async()=>(await getV4PaneSnapshot()).sessionId===anchor.taskId,{timeout:15_000});await openCenter("conversations",TITLE);await browser.waitUntil(async()=>Boolean(await visible(ITEMS,new RegExp(TITLE,"u"))),{timeout:15_000});
    await capture("RLM05-search-before-clear",{status:"step",center:await currentCenterTransition()});
    // 本轮QA：真实按键触发controlled input更新；setValue(空串)仅清DOM会留下旧搜索分支。
    await $(CENTER).click();await browser.keys(["Control","a"]);await browser.keys("Backspace");
    await capture("RLM05-real-key-clear",{status:"step",center:await currentCenterTransition()});
    await browser.waitUntil(async()=>Boolean(await visible(`${ITEMS}[data-value^="recent-task:"]`,new RegExp(TITLE,"u"))),{timeout:15_000});await capture("RLM05-owned-anchor",{status:"passed",anchorTaskId:anchor.taskId,sameWorkspace:true,center:await currentCenterTransition()});
  });});
  it("RLM-06: Command Center文件范围索引实际中文空格文件",async function(){await runCase(this,"RLM06",async()=>{
    await activateAlpha();await openCenter("files");expect(await $$(ITEMS)).toHaveLength(0);await $(CENTER).setValue("RLM_中文 空格");
    await chooseCenterResult(/RLM_中文 空格/u);await browser.waitUntil(async()=>(await readQaPreviewLines()).lines.some(line=>line.line==="1"&&line.normalized===FILE_CONTENT),{timeout:20_000,timeoutMsg:"RLM exact shadow preview line did not load synthetic content"});await capture("RLM06-shadow-line",{status:"passed",preview:await readQaPreviewLines()});
  });});
  it("RLM-07: All前缀操作/任务/文件选择、历史恢复和清空",async function(){await runCase(this,"RLM07",async()=>{
    await activateAlpha();
    for(const [query,pattern,scope] of [[">设置",/^(设置|Settings)(?:\s|$)/u,"commands"],["#"+TITLE,new RegExp(TITLE,"u"),"conversations"],["@RLM_中文 空格",/RLM_中文 空格/u,"files"]] as const){
      await openCenter("all",query);await chooseCenterResult(pattern);await activateAlpha();
      const history=await browser.execute(():Array<{scope:string;query:string}>=>Object.keys(localStorage).filter((key)=>key.startsWith("zcode-command-center-search-history:")).flatMap((key)=>JSON.parse(localStorage.getItem(key)||"[]") as Array<{scope:string;query:string}>));
      expect(history.some((item:{scope:string;query:string})=>item.scope===scope && item.query===query.slice(1))).toBe(true);
    }
    await openCenter("all");await click('[role="dialog"] button',/^@\s*RLM_中文 空格$/u);expect(await $(CENTER).getValue()).toBe("@RLM_中文 空格");
    await $(CENTER).setValue("");await click('[role="dialog"] button[aria-label="清除搜索历史"], [role="dialog"] button[aria-label="Clear search history"]');await browser.keys("Escape");await openCenter("all");
    expect(await visible('[role="dialog"] button[aria-label="清除搜索历史"], [role="dialog"] button[aria-label="Clear search history"]')).toBeUndefined();
  });});
  it("RLM-08: 文件选择取消与pending入口busy不启动第二事务",async function(){await runCase(this,"RLM08",async()=>{
    const before=(await indexRows()).length;await pickerOpen();expect(await $(IMPORT_BUTTON).isEnabled()).toBe(false);
    const count=await browser.execute(()=>window.__qaResidualAdapters!.pickerCount);await browser.execute(()=>{(document.querySelector('[data-testid="task-new-button"] button[aria-busy="true"]') as HTMLButtonElement).click();});expect(await browser.execute(()=>window.__qaResidualAdapters!.pickerCount)).toBe(count);
    await browser.execute(()=>window.__qaResidualAdapters!.selected!.dispatchEvent(new Event("cancel")));await waitImportIdle();expect((await indexRows()).length).toBe(before);
  });});
  it("RLM-09: 有效归档真实Host导入与重复复用、草稿保留",async function(){await runCase(this,"RLM09",async()=>{
    const before=(await indexRows()).length;const beta=await importFile(betaFile,"RLM_TASK_中文_02");expect((await indexRows()).length).toBe(before+1);
    await setV4ComposerText("RLM_DUPLICATE_DRAFT_KEEP");const again=await importFile(betaFile,"RLM_TASK_中文_02");expect(again.taskId).toBe(beta.taskId);expect((await indexRows()).length).toBe(before+1);
    await browser.waitUntil(()=>browser.execute(()=>/Opened the previously imported|已打开之前导入/u.test(document.querySelector<HTMLElement>("#zcode-toast-host")?.innerText||"")),{timeout:15_000});
    await waitForV4ComposerText("RLM_DUPLICATE_DRAFT_KEEP","RLM duplicate import overwrote the draft");await setV4ComposerText("");
    const decoded=await decodeConversationArchive(await readFile(betaFile));expect(Object.keys(decoded.content).sort()).toEqual(["artifacts","format","rows","selectedProductTurnIds","title","version"].sort());
    await activateAlpha();
  });});
  it("RLM-10: 空文件/nonZIP/version/hash错误映射与逐次恢复",async function(){await runCase(this,"RLM10",async()=>{
    const decoded=await decodeConversationArchive(await readFile(alphaFile));
    const cases:Array<{name:string;bytes:Buffer;message:RegExp}>= [
      {name:"empty",bytes:Buffer.alloc(0),message:/72 MiB/u},
      {name:"nonzip",bytes:Buffer.from("RLM_NOT_A_ZIP"),message:/完整|incomplete/u},
      {name:"version2",bytes:await zipManifest({content:{...decoded.content,version:2},sha256:"0".repeat(64)}),message:/更新版本|newer version/u},
      {name:"hash",bytes:await zipManifest({content:decoded.content,sha256:"0".repeat(64)}),message:/完整|incomplete/u},
    ];
    for(const item of cases){const before=(await indexRows()).length;const file=await safe(join(fixtureRoot,item.name+".zcodium"));await writeFile(file,item.bytes,{flag:"wx"});await pickerOpen();await pickerChoose(file);
      await browser.waitUntil(()=>browser.execute((pattern)=>new RegExp(pattern,"u").test(document.querySelector<HTMLElement>("#zcode-toast-host")?.innerText||""),item.message.source),{timeout:15_000,timeoutMsg:`RLM ${item.name} error mapping mismatch`});
      expect(await visible('#zcode-toast-host button',/^(Retry|重试)$/u)).toBeUndefined();expect((await indexRows()).length).toBe(before);await capture("RLM10-"+item.name,{status:"expected-contract-error",fixture:file});
      const recovered=await importFile(alphaFile,TITLE);expect(recovered.taskId).toBe(alpha.taskId);expect((await indexRows()).length).toBe(before);
    }
  });});
  it("RLM-11: MCP真实新建填写取消不保存或启动服务器",async function(){await runCase(this,"RLM11",async()=>{
    await openSettings("mcp");const before=await mcpConfigFingerprint();await click('[data-settings-create-action="settings.mcp.create.open"]');
    await $('input[placeholder="my-mcp-server"]').waitForDisplayed();await $('input[placeholder="my-mcp-server"]').setValue("rlm-mcp-cancel");await $('input[placeholder="npx"]').setValue("RLM_DO_NOT_EXECUTE");
    await click('[data-testid="settings-page"] main button',/^(Cancel|取消)$/u);await $('input[placeholder="my-mcp-server"]').waitForExist({reverse:true,timeout:15_000});expect(await mcpConfigFingerprint()).toEqual(before);
  });});
  it("RLM-12: Commands真实新建名称/prompt取消无文件新增",async function(){await runCase(this,"RLM12",async()=>{
    await openSettings("commands");const root=await safe(join(home,".zcodium/commands"));const before=await fingerprintFiles(root);
    await click('[data-testid="settings-page"] main button[aria-label="New"], [data-testid="settings-page"] main button[aria-label="新建"]');await $('form input[placeholder="my-command"]').waitForDisplayed();await $('form input[placeholder="my-command"]').setValue("rlm-command-cancel");
    await $('form textarea').setValue("RLM_COMMAND_DRAFT_ONLY");await click('form button[type="button"]',/^(Cancel|取消)$/u);await $('form input[placeholder="my-command"]').waitForExist({reverse:true,timeout:15_000});expect(await fingerprintFiles(root)).toEqual(before);
  });});
  it("RLM-13: Skills新建真实进入skill-creator草稿，无发送",async function(){await runCase(this,"RLM13",async()=>{
    await openSettings("skill");await click('[data-settings-create-action="settings.skills.create.open"]');await $('[data-testid="settings-page"]').waitForExist({reverse:true,timeout:15_000});
    await browser.waitUntil(()=>browser.execute(()=>document.querySelector<HTMLElement>('[data-testid="v4-composer-input"]')?.innerText.includes("skill-creator")===true),{timeout:20_000,timeoutMsg:"RLM Skills creator mention draft not visible"});
    expect((await getV4PaneSnapshot()).sessionId).toBe("draft");expect((await getV4PaneSnapshot()).canStop).toBe(false);await capture("RLM13-creator-draft",{status:"draft-only"});await activateAlpha();
  });});
});
