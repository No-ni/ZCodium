import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Key } from "webdriverio";
import { ServiceChannels, sanitizeZCodeRuntimeEnv, type ConversationArchiveContent } from "@zcode/shared";
import type { ConversationArchiveInput } from "../../../../../packages/services/src/node.js";
import { DEFAULT_WORKSPACE, readSettings, setCurrentElectronRendererContentSize } from "../../../../../packages/desktop/test/e2e/helpers/desktop-app.js";
import { getV4PaneSnapshot, prepareV4ConversationE2E, setV4ComposerText } from "../../../../../packages/desktop/test/e2e/helpers/v4-conversation.js";
import { openProjectFileTree } from "../../../../../packages/desktop/test/e2e/helpers/project-sidebar.js";
import { callHandoffHost } from "../../../../../packages/desktop/test/e2e/helpers/remote-project-handoff-probe.js";
import { installLocalQaRpcProbe } from "../../qa-local-rpc-probe.js";
import { readQaPreviewLines } from "../../qa-preview-dom.js";
import { visibleControl, clickVisibleControl, closeVisibleMenus } from "../../qa-menu-dom.js";
import { countUpstreamRequests } from "../../../../../packages/desktop/test/e2e/helpers/conversation-session-network.js";
import { startElectronWindowRecording, type ElectronWindowRecordingSession } from "../../../../../packages/desktop/test/e2e/helpers/electron-window-recorder.js";

// 中文说明：外置QA只操作合成run，拦系统出口；终端在profile/环境证明之前不创建。
const ROOT = resolve(fileURLToPath(new URL("../../../../../", import.meta.url)));
const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const MODULE_ROOTS = ["C:\\Program Files\\PowerShell\\7\\Modules", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules"];
const OPTIONAL_MODULE_ROOT = "C:\\Program Files\\PowerShell\\Modules";
const REQUIRED = ["HOME","USERPROFILE","TEMP","TMP","TMPDIR","APPDATA","LOCALAPPDATA","COREPACK_HOME","PNPM_HOME","npm_config_cache","npm_config_store_dir","npm_config_userconfig","TSX_CACHE_DIR","NODE_COMPILE_CACHE","XDG_CACHE_HOME","XDG_CONFIG_HOME","XDG_DATA_HOME","ZCODE_E2E_HOME_DIR","ZCODE_E2E_ARTIFACT_DIR"];
const IMPORT_BUTTON = '[data-testid="task-new-button"] button[aria-label="Conversation options"], [data-testid="task-new-button"] button[aria-label="对话选项"]';
const FIND_MARKER = "SLM_CHAT_FIND_中文_NEEDLE";
const FILE_MARKER = "SLM_FILE_FIND_中文_NEEDLE";
const USER_MARKER = "SLM_SYNTHETIC_USER_中文";
const COPY_MARKER = "SLM_SYNTHETIC_ASSISTANT_中文";
const FILE_NAME = "SLM_中文 空格.txt";
const ASSISTANT_TEXT = COPY_MARKER + "\n\n" + Array.from({length:1300},(_,i)=>[79,649,1099].includes(i)?FIND_MARKER:`合成会话查找行 ${i+1}：仅本树离线QA。`).join("\n\n");
const FILE_TEXT = Array.from({length:1300},(_,i)=>[79,649,1099].includes(i)?FILE_MARKER:`合成文件查找行 ${i+1}：仅本树离线QA。`).join("\n")+"\n";
let home: string;
let evidence: string;
let fixtures: string;
let database: string;
let counter = 0;
let baselineRequests = 0;
let preferences: {locale:string;mode:"office"|"coding"};
let task: {id:string;workspacePath:string;workspaceIdentity?:string;executionPath:string} | undefined;
let filePath: string;
let taskTitle: string;
interface ShortAdapters { clips:Array<{method:string;text:string}>;selected?:HTMLInputElement;restore():void }
declare global { interface Window { __qaShortAdapters?: ShortAdapters } }
class Blocked extends Error {}
type IndexRow = {task_id:string;workspace_path:string;workspace_key:string;title:string};

function contained(candidate:string) {
  const rel=relative(ROOT,resolve(candidate));return Boolean(rel)&&!isAbsolute(rel)&&rel!==".."&&!rel.startsWith(`..${sep}`);
}
async function ancestors(candidate:string) {
  for(let cursor=resolve(candidate);;cursor=dirname(cursor)) {
    try {if((await lstat(cursor)).isSymbolicLink()||(await realpath(cursor)).toLowerCase()!==cursor.toLowerCase())throw new Error("SLM redirected/reparse ancestor rejected");}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    if(cursor===dirname(cursor))break;
  }
}
async function safe(candidate:string) {
  if(!isAbsolute(candidate)||!contained(candidate))throw new Error("SLM path must be absolute inside worktree");
  await ancestors(candidate);return resolve(candidate);
}
async function audit(candidate:string) {
  const target=await safe(candidate);const guard=await safe(join(ROOT,"docs/testing/qa-2026-11-06/qa-reparse-children.ps1"));
  const script=readFileSync(guard,"utf8")+"\n$ErrorActionPreference='Stop';$target=$env:SLM_AUDIT_TARGET;$cursor=[IO.Path]::GetFullPath($target);while($cursor){if(Test-Path -LiteralPath $cursor){if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'SLM reparse ancestor'}};$cursor=[IO.Path]::GetDirectoryName($cursor)};if(Test-Path -LiteralPath $target -PathType Container){$queue=[Collections.Generic.Queue[string]]::new();$queue.Enqueue($target);while($queue.Count){foreach($item in Get-QaAuditChildren $queue.Dequeue()){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'SLM reparse descendant'};if($item.PSIsContainer){$queue.Enqueue($item.FullName)}}}}";
  execFileSync(PWSH,["-NoProfile","-NonInteractive","-Command",script],{env:{...process.env,SLM_AUDIT_TARGET:target,QA_REPARSE_WORKTREE:ROOT},windowsHide:true,stdio:"pipe",timeout:30_000});
}
async function preparePaths() {
  if(process.platform!=="win32"||process.env.E2E_PROVIDER_HTTP_MODE!=="replay"||process.env.ZCODE_E2E_MANUAL_REVIEW!=="1")throw new Error("SLM requires isolated Windows pending replay");
  for(const name of REQUIRED)await safe(process.env[name]||"");
  home=await safe(process.env.ZCODE_E2E_HOME_DIR!);database=await safe(join(home,".zcodium/v2/tasks-index.sqlite"));
  if(resolve(DEFAULT_WORKSPACE)!==join(home,"ZCodeProject"))throw new Error("SLM helper workspace mismatch");
  const artifacts=await safe(process.env.ZCODE_E2E_ARTIFACT_DIR!);await audit(home);await audit(artifacts);
  const worker=(process.env.WDIO_WORKER_ID||String(process.pid)).replace(/[^a-zA-Z0-9_-]/gu,"_");
  const names=(await readdir(artifacts)).filter(name=>name.startsWith(`qa-project-bootstrap-${worker}-`)&&name.endsWith("-after.json"));
  const snapshots=await Promise.all(names.map(async name=>JSON.parse(await readFile(await safe(join(artifacts,name)),"utf8"))));
  if(!snapshots.some(item=>item.workerId===worker&&item.database===database&&item.projects?.some((p:{host_id:string;name:string;deleted:number})=>p.host_id==="local"&&p.name==="ZCodeProject"&&!p.deleted)))throw new Error("SLM current worker bootstrap missing");
  const suffix=`${worker}-${process.pid}-${Date.now()}`;
  evidence=await safe(join(artifacts,`qa-short-local-menus-${suffix}`));fixtures=await safe(join(DEFAULT_WORKSPACE,".zcode-e2e",`qa-short-${suffix}`));
  await mkdir(evidence);await mkdir(fixtures,{recursive:true});taskTitle=`SLM_TASK_中文_${suffix}`;
}
async function indexRows() {
  await safe(database);await audit(database);const db=new DatabaseSync(database,{readOnly:true});
  try{return db.prepare("SELECT task_id,workspace_path,workspace_key,title FROM tasks WHERE cli_deleted=0").all() as IndexRow[];}finally{db.close();}
}
async function visible(selector:string,pattern?:RegExp) {
  return visibleControl(selector, pattern);
}
async function click(selector:string,pattern?:RegExp) {
  await clickVisibleControl(selector, pattern, "SLM");
}
async function closeMenus() {
  await closeVisibleMenus("SLM");
}
async function closeOverlays() {
  await closeMenus();for(let i=0;i<3&&await visible('[role="dialog"]');i++)await browser.keys("Escape");
  if(await visible('[data-testid="settings-page"]'))await click('[data-testid="settings-back-button"]');
}
async function presentation(kind:"locale"|"mode",value:string) {
  await closeMenus();await click('[data-testid="sidebar-preferences-trigger"]');
  await click('[role="menuitem"][aria-haspopup="menu"]',kind==="locale"?/^(Language|界面语言)$/u:/^(Interface mode|界面模式)$/u);
  const label=kind==="locale"?(value==="en-US"?/^English$/u:value==="zh-CN"?/^中文简体$/u:/^(System default|跟随系统|系统默认)$/u):(value==="office"?/^(Office mode|办公模式)$/u:/^(Coding mode|编程模式)$/u);
  await click('[role="menuitemradio"]',label);await closeMenus();
  await browser.waitUntil(async()=>{if(kind!=="locale")return browser.execute(expected=>localStorage.getItem("zcode-interface-mode")===expected,value);const settings=await readSettings();return settings.localePreference===value&&(value==="system"||settings.locale===value);},{timeout:15_000,timeoutMsg:"SLM presentation persistence did not converge"});
}
async function installAdapters() {
  // 原生browser script不经tsx函数序列化，避免keepNames向属性callback插入__name闭包。
  await browser.execute(`
    const clipboard=navigator.clipboard;if(!clipboard)throw new Error("SLM clipboard unavailable");
    const writeText=Object.getOwnPropertyDescriptor(clipboard,"writeText");const write=Object.getOwnPropertyDescriptor(clipboard,"write");const inputClick=HTMLInputElement.prototype.click;
    const state={clips:[],restore(){if(this.selected?.isConnected)this.selected.dispatchEvent(new Event("cancel"));HTMLInputElement.prototype.click=inputClick;if(writeText)Object.defineProperty(clipboard,"writeText",writeText);else delete clipboard.writeText;if(write)Object.defineProperty(clipboard,"write",write);else delete clipboard.write;delete window.__qaShortAdapters;}};
    Object.defineProperty(clipboard,"writeText",{configurable:true,value:async(text)=>{state.clips.push({method:"writeText",text});}});
    Object.defineProperty(clipboard,"write",{configurable:true,value:async(items)=>{for(const item of items){if(!item.types.includes("text/plain"))throw new Error("SLM permits text-only mock clipboard");state.clips.push({method:"write",text:await(await item.getType("text/plain")).text()});}}});
    Object.defineProperty(HTMLInputElement.prototype,"click",{configurable:true,writable:true,value:function(){if(this.type==="file"&&this.accept===".zcodium"){state.selected=this;return;}inputClick.call(this);}});window.__qaShortAdapters=state;
  `);
}
export function shortArchiveInput(title="SLM_TASK_中文_STATIC"):ConversationArchiveInput {
  const base={turnId:"share-turn-1",productTurnId:"share-product-turn-1"};
  const rows:ConversationArchiveContent["rows"]=[
    {...base,rowId:1,entityId:"share-entity-1",createdAt:1,createdAtSeq:1,kind:"turnHeader",origin:"userInput",state:"completedSuccess",startedAt:1,endedAt:3},
    {...base,rowId:2,entityId:"share-entity-2",createdAt:2,createdAtSeq:2,kind:"userInput",origin:"realUser",text:USER_MARKER},
    {...base,rowId:3,entityId:"share-entity-3",createdAt:3,createdAtSeq:3,kind:"assistantText",state:"complete",text:ASSISTANT_TEXT},
  ];return{title,selectedProductTurnIds:["share-product-turn-1"],rows,artifacts:[]};
}
async function ensureTask() {
  if(task)return task;
  await closeOverlays();const requireDesktop=createRequire(join(ROOT,"packages/desktop/package.json"));
  const servicePath=await safe(requireDesktop.resolve("@zcode/services/node"));const services=await import(pathToFileURL(servicePath).href) as typeof import("../../../../../packages/services/src/node.js");
  const bytes=await services.encodeConversationArchive(shortArchiveInput(taskTitle));const decoded=await services.decodeConversationArchive(bytes);
  expect(decoded.content.rows).toHaveLength(3);expect(decoded.artifacts.size).toBe(0);
  const archive=await safe(join(fixtures,"completed.zcodium"));await writeFile(archive,bytes,{flag:"wx"});
  await click(IMPORT_BUTTON);await click('[role="menuitem"]',/^(Import from file…|从文件导入…)$/u);
  await browser.waitUntil(()=>browser.execute(()=>Boolean(window.__qaShortAdapters?.selected?.isConnected)),{timeout:15_000});
  await browser.execute((data:number[],name:string)=>{const input=window.__qaShortAdapters!.selected!;if(!input.isConnected)throw new Error("SLM real file input gone");const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(data)],name,{type:"application/octet-stream"}));input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));},Array.from(bytes),"completed.zcodium");
  const locale = (await readSettings()).locale;
  if (locale !== "en-US" && locale !== "zh-CN") throw new Error("SLM resolved locale unavailable");
  const importedTitle = `${locale === "en-US" ? "Imported: " : "导入："}${taskTitle}`;
  await browser.waitUntil(async()=>await browser.execute(()=>document.querySelectorAll('input[type="file"][accept=".zcodium"]').length===0)&&(await $(IMPORT_BUTTON).getAttribute("aria-busy"))!=="true"&&(await indexRows()).some(row=>row.title===importedTitle),{timeout:45_000});
  const row=(await indexRows()).find(item=>item.title===importedTitle)!;
  await browser.waitUntil(async()=>(await getV4PaneSnapshot()).sessionId===row.task_id,{timeout:30_000});
  const identity=row.workspace_key!==row.workspace_path?row.workspace_key:undefined;
  const sessions=await callHandoffHost<Array<{sessionId:string;executionWorkspacePath?:string}>>(ServiceChannels.ZCodeSession,"listSessions",[{workspacePath:row.workspace_path,workspaceIdentity:identity,sessionIds:[row.task_id],includeArchived:true}]);
  let execution=sessions.find(item=>item.sessionId===row.task_id)?.executionWorkspacePath;
  if(!sessions.some(item=>item.sessionId===row.task_id)){const snapshot=await callHandoffHost<{session:{sessionId:string;executionWorkspacePath?:string}}>(ServiceChannels.ZCodeAgent,"readSession",[{sessionId:row.task_id,workspacePath:row.workspace_path,workspaceIdentity:identity,messageLimit:1,runtimePolicy:"existing-only"}]);if(snapshot.session.sessionId!==row.task_id)throw new Error("SLM session mismatch");execution=snapshot.session.executionWorkspacePath;}
  const executionPath=await safe(execution?.trim()||row.workspace_path);await audit(executionPath);
  task={id:row.task_id,workspacePath:row.workspace_path,workspaceIdentity:identity,executionPath};
  await browser.waitUntil(() => browser.execute((user, assistant) => { const notice = document.querySelector<HTMLElement>('[data-conversation-share-import-notice="true"]'); return notice?.innerText.includes(user) === true && notice.innerText.includes(assistant); }, USER_MARKER, COPY_MARKER), {timeout:30_000, timeoutMsg:"SLM imported readonly public rows missing"});
  filePath=await safe(join(DEFAULT_WORKSPACE,FILE_NAME));await writeFile(filePath,FILE_TEXT,{flag:"wx"});
  await capture("fixture-import",{status:"fixture",task,archive,rows:3,provider:"no send"});return task;
}
async function activateTask() {
  const current=await ensureTask();await closeOverlays();
  if((await getV4PaneSnapshot()).sessionId!==current.id){await click(`[data-testid="task-item-${current.id}"]`);await browser.waitUntil(async()=>(await getV4PaneSnapshot()).sessionId===current.id,{timeout:20_000});}
  return current;
}
async function clipCount(){return browser.execute(()=>window.__qaShortAdapters!.clips.length);}
async function newClip(before:number){await browser.waitUntil(async()=>await clipCount()===before+1,{timeout:15_000});return browser.execute(index=>window.__qaShortAdapters!.clips[index]!,before);}
async function fingerprint(path:string){await audit(path);try{return createHash("sha256").update(await readFile(path)).digest("hex");}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}}
async function capture(name:string,details:Record<string,unknown>) {
  const stem=await safe(join(evidence,`${String(++counter).padStart(3,"0")}-${name}`));
  const state=await browser.execute(()=>({dpr:devicePixelRatio,activePane:document.querySelector('[data-testid="v4-session-pane-workspace-main"]')?.getAttribute("data-session-id"),headings:[...document.querySelectorAll("h1,h2,h3")].filter(el=>el.checkVisibility()).map(el=>el.textContent),tabs:[...document.querySelectorAll<HTMLElement>('[data-side-pane-tab-id]')].map(el=>({id:el.dataset.sidePaneTabId,state:el.dataset.state})),menus:[...document.querySelectorAll<HTMLElement>('[role="menuitem"],button')].filter(el=>el.checkVisibility()).map(el=>({text:el.innerText.slice(0,120),label:el.getAttribute("aria-label"),testid:el.dataset.testid})),clips:window.__qaShortAdapters?.clips.map(item=>({method:item.method,length:item.text.length,synthetic:item.text.includes("SLM_")})),mode:localStorage.getItem("zcode-interface-mode")}));
  const reservation=await open(stem+".png","wx");await reservation.close();await browser.saveScreenshot(stem+".png");
  await writeFile(stem+".json",JSON.stringify({capturedAt:new Date().toISOString(),evidenceKind:"synthetic local menu UI; readonly index; mock clipboard/native exits; no Provider send",...details,state,tasks:await indexRows(),providerRequests:await countUpstreamRequests({})},null,2)+"\n",{flag:"wx"});
}
async function runCase(context:Mocha.Context,id:string,action:()=>Promise<void>) {
  context.timeout(180_000);const frameDir=await safe(join(evidence,`${id}-frames`));await audit(frameDir);let recording:ElectronWindowRecordingSession|undefined;let blocked=false;
  try{await capture(id+"-before",{status:"before"});recording=await startElectronWindowRecording({browser,frameDir,outputPath:join(evidence,`${id}-unencoded.webm`),frameIntervalMs:1000,preRollDurationMs:0,cleanupFrames:false,encodeVideo:async()=>{throw new Error("Standard video encoder unavailable; PNG/time sequence retained");}});await action();expect(await countUpstreamRequests({})).toBe(baselineRequests);await capture(id,{status:"passed"});await audit(frameDir);await recording.discard();recording=undefined;}
  catch(error){if(error instanceof Blocked){await capture(id,{status:"blocked",reason:error.message});if(recording){await audit(frameDir);await recording.discard();recording=undefined;}blocked=true;}else{let frames:unknown;try{if(recording){await audit(frameDir);frames=await recording.stop({tailDurationMs:500});}}catch(failure){frames={format:"PNG/time sequence; WebM unencoded",frameDir,error:failure instanceof Error?failure.message:String(failure)};}await capture(id,{status:"failed",error:error instanceof Error?error.message:String(error),frames});throw error;}}
  if(blocked)context.skip();
}

async function nativeClick(key:"changelog"|"devtools"|"clear") {
  return browser.electron.execute((electron,action)=>{
    const menu=electron.Menu.getApplicationMenu();if(!menu)throw new Error("SLM application menu missing");
    // 不定义序列化后的局部命名函数，避免tsx keepNames的__name闭包进入Electron execute。
    const items=[...menu.items];for(let i=0;i<items.length;i++){if(items[i]?.submenu)items.push(...items[i]!.submenu!.items);}
    const item=items.find(candidate=>action==="devtools"?candidate.id==="help.toggle-dev-tools":action==="changelog"?["What's new","更新日志"].includes(candidate.label):["Clear all data","清除所有数据"].includes(candidate.label));
    if(!item||!item.enabled||!item.visible||!item.click)throw new Error("SLM actual native menu item unavailable");
    const win=electron.BrowserWindow.getAllWindows().find(candidate=>!candidate.isDestroyed()&&candidate.webContents.getURL().includes("/renderer/index.html"));if(!win)throw new Error("SLM renderer window missing");win.focus();
    (item as unknown as {click:()=>void}).click();return{id:item.id,label:item.label,role:item.role};
  },key);
}
async function devtoolsOpen(){return browser.electron.execute(electron=>{const win=electron.BrowserWindow.getAllWindows().find(candidate=>!candidate.isDestroyed()&&candidate.webContents.getURL().includes("/renderer/index.html"));if(!win)throw new Error("SLM renderer window missing");return win.webContents.isDevToolsOpened();});}
async function openSettings(section="general") {
  await closeOverlays();await click('[data-testid="task-settings-button"]');await click(`[data-settings-section-nav="${section}"]`);
  await browser.waitUntil(async()=>(await $(`[data-settings-section-nav="${section}"]`).getAttribute("aria-current"))==="page",{timeout:15_000});
}
async function closeOnboarding() {
  await $('[data-testid="onboarding-page"]').waitForDisplayed({timeout:15_000});expect(await $$('[data-testid="onboarding-page"] li[aria-current="step"]')).toHaveLength(1);
  await click('[data-testid="onboarding-page"] button[aria-label="Exit onboarding"], [data-testid="onboarding-page"] button[aria-label="退出引导"]');
  await $('[data-testid="onboarding-page"]').waitForExist({reverse:true,timeout:15_000});await $('[data-testid="settings-page"]').waitForDisplayed({timeout:15_000});
}
async function projectOrder(){return browser.execute(()=>({ids:[...document.querySelectorAll<HTMLElement>('[data-project-id][data-project-name]')].map(el=>el.dataset.projectId!),stored:JSON.parse(localStorage.getItem("zcode-project-sidebar-preferences")||"{}").order as string[]|undefined}));}
async function createProject(name:string) {
  await closeOverlays();await $('[data-testid="project-section"]').moveTo();await click('[data-testid="virtual-project-add"]');
  await $('[data-testid="virtual-project-name"]').setValue(name);expect(await $('[data-testid="virtual-project-save"]').isEnabled()).toBe(true);await click('[data-testid="virtual-project-save"]');
  const selector=`[data-project-id][data-project-name=${JSON.stringify(name)}]`;await $(selector).waitForDisplayed({timeout:20_000});return(await $(selector).getAttribute("data-project-id"))!;
}
async function moveProject(id:string,direction:"ArrowDown"|"ArrowUp") {
  const toggle=$(`[data-project-id=${JSON.stringify(id)}] [data-testid="virtual-project-toggle"]`);await toggle.scrollIntoView({block:"center"});
  await browser.execute(query=>(document.querySelector(query) as HTMLElement).focus(),`[data-project-id=${JSON.stringify(id)}] [data-testid="virtual-project-toggle"]`);
  expect(await toggle.isFocused()).toBe(true);await browser.keys("Space");
  await browser.waitUntil(async()=>(await toggle.getAttribute("aria-pressed"))==="true",{timeout:5000});await browser.keys(direction);await browser.keys("Space");
  await browser.waitUntil(async()=>(await toggle.getAttribute("aria-pressed"))!=="true",{timeout:5000});
}
async function paneTabs(){return browser.execute(()=>[...document.querySelectorAll<HTMLElement>('[data-side-pane-tab-id]')].map(el=>({id:el.dataset.sidePaneTabId!,active:el.dataset.state==="active"})));}
async function launcher() {
  await closeOverlays();if(!await visible('[data-side-pane-add-tab-trigger],[data-side-pane-add-trigger]'))await click('[data-testid="side-pane-toggle"]');
  await click('[data-side-pane-add-tab-trigger],[data-side-pane-add-trigger]');
  await browser.waitUntil(async()=>Boolean(await visible('[data-side-pane-open-tab-item]')),{timeout:15_000});
}
async function openReview() {
  if((await paneTabs()).some(tab=>tab.id==="git")){await click('[data-side-pane-tab-id="git"]');return false;}
  await launcher();await click('[data-side-pane-open-tab-item="review"]');await $('[data-testid="git-pane"]').waitForDisplayed({timeout:30_000});return true;
}
async function closeTab(id:string) {
  const selector=`[data-side-pane-tab-id=${JSON.stringify(id)}]`;await $(selector).moveTo();await click(`${selector} button`);
  await browser.waitUntil(async()=>!(await paneTabs()).some(tab=>tab.id===id),{timeout:15_000});
}
async function fileRow() {
  await activateTask();await openProjectFileTree(DEFAULT_WORKSPACE);
  const selector=`[data-testid=${JSON.stringify(`workspace-file-tree-row-${filePath}`)}]`;
  // 真正刷新文件树，等待Host投影；不注入store/filetree行。
  if(!await visible(selector)) {const refresh=await visible('[data-testid="workspace-file-tree-refresh-button"]');if(refresh)await refresh.click();}
  await $(selector).waitForDisplayed({timeout:30_000});return selector;
}
async function clickPaintedControl(selector:string,pattern?:RegExp) {
  let previous = "";
  let targetCaptured = false;
  await browser.waitUntil(async()=>{
    const snapshot = await browser.execute(`
      const selector=arguments[0], source=arguments[1], flags=arguments[2];
      const pattern=source===null?null:new RegExp(source,flags);
      const matches=[];
      const elements=document.querySelectorAll(selector);
      for(let index=0;index<elements.length;index++){
        const element=elements[index];
        if(!element.isConnected||!element.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))continue;
        const text=(element.innerText||element.textContent||"").trim();
        if(pattern&&!pattern.test(text))continue;
        const rect=element.getBoundingClientRect();
        const x=rect.left+rect.width/2,y=rect.top+rect.height/2;
        const hit=document.elementFromPoint(x,y);
        if(rect.width<=0||rect.height<=0||rect.left<0||rect.top<0||rect.right>innerWidth||rect.bottom>innerHeight||!hit||!(hit===element||element.contains(hit)))continue;
        if(element.getAttribute("aria-disabled")==="true"||element.hasAttribute("disabled"))continue;
        matches.push({index,text,rect:[rect.left,rect.top,rect.width,rect.height]});
      }
      return matches;
    `,selector,pattern?.source??null,pattern?.flags??"") as Array<{index:number;text:string;rect:number[]}>;
    if(snapshot.length!==1){previous="";return false;}
    const signature=JSON.stringify(snapshot);
    if(signature!==previous){previous=signature;return false;}
    if(!targetCaptured){await capture("painted-target",{status:"target-before-click",selector,label:pattern?.source??null,target:snapshot[0]});targetCaptured=true;return false;}
    const element=(await $$(selector))[snapshot[0]!.index];
    if(!element||(await element.getText()).trim()!==snapshot[0]!.text){previous="";return false;}
    await element.click();
    return true;
  },{timeout:15_000,interval:100,timeoutMsg:`SLM unique painted control did not settle: ${selector}`});
}
async function fileMenu(label:RegExp){
  const selector=await fileRow();await $(selector).click({button:"right"});
  const menu='[data-slot="context-menu-content"][data-state="open"] [role="menuitem"]';
  await clickPaintedControl(menu,label);
}

export function parseShortTerminalProbe(value:unknown) {
  const parsed:unknown=typeof value==="string"?JSON.parse(value):value;
  if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw new Blocked("PowerShell profile probe returned an invalid root");
  const object=parsed as Record<string,unknown>;
  if(JSON.stringify(Object.keys(object).sort())!==JSON.stringify(["modules","profiles"]))throw new Blocked("PowerShell profile probe returned unknown keys");
  const profiles=object.profiles, modules=object.modules;
  if(!Array.isArray(profiles)||profiles.length!==4||!Array.isArray(modules)||modules.length<1||modules.length>8)throw new Blocked("PowerShell profile/module probe returned incomplete classification");
  for(const rows of [profiles,modules]){
    const paths=new Set<string>();
    for(const row of rows){
      if(!row||typeof row!=="object"||Array.isArray(row)||JSON.stringify(Object.keys(row).sort())!==JSON.stringify(["exists","path"])||typeof row.path!=="string"||!isAbsolute(row.path)||typeof row.exists!=="boolean")throw new Blocked("PowerShell profile/module row has invalid shape");
      const key=resolve(row.path).toLowerCase();if(paths.has(key))throw new Blocked("PowerShell profile/module paths are duplicated");paths.add(key);
    }
  }
  return parsed as {profiles:Array<{path:string;exists:boolean}>;modules:Array<{path:string;exists:boolean}>};
}

async function terminalGate() {
  if(process.env.PSModulePath?.toLowerCase()!==MODULE_ROOTS.join(";").toLowerCase()||!process.env.PSModuleAnalysisCachePath)throw new Blocked("SafeTerminal startup environment was not supplied");
  await audit(process.env.PSModuleAnalysisCachePath);await ancestors(PWSH);
  // 源码链逐次留hash：Main env→Host fork env→Terminal process.env；正式产品无测试patch。
  const sourcePaths=["packages/desktop/src/main/desktopHostProcess.ts","packages/desktop/src/main/desktopRuntimeEnv.ts","packages/services/src/terminal/terminalService.ts","packages/shared/src/runtimeEnv.ts"];
  const sources=await Promise.all(sourcePaths.map(async path=>({path,text:await readFile(await safe(join(ROOT,path)),"utf8")})));
  if(!sources[0]!.text.includes("...buildHostProcessEnv(dependencies.hostProcessLocalEnv)")||!sources[1]!.text.includes("...readDefinedProcessEnv()")||!sources[1]!.text.includes("...sanitizeZCodeRuntimeEnv(rawInheritedEnv)")||!sources[2]!.text.includes("const env = resolveTerminalEnv()")||!sources[2]!.text.includes("const nextEnv = { ...env }")||!sources[2]!.text.includes('["pwsh.exe", "powershell.exe", process.env.ComSpec, "cmd.exe"]'))throw new Blocked("Current Host/terminal environment inheritance contract could not be proved");
  const main=await browser.electron.execute((_electron,names)=>Object.fromEntries(names.map(name=>[name,process.env[name]||""])),[...REQUIRED,"PSModulePath","PSModuleAnalysisCachePath","PATH","POWERSHELL_TELEMETRY_OPTOUT"]);
  for(const name of REQUIRED){await safe(main[name]||"");if(main[name]!==process.env[name])throw new Blocked("Actual Main environment differs from isolated run");}
  if(main.PSModulePath?.toLowerCase()!==MODULE_ROOTS.join(";").toLowerCase()||main.PSModuleAnalysisCachePath!==process.env.PSModuleAnalysisCachePath||main.POWERSHELL_TELEMETRY_OPTOUT!=="1")throw new Blocked("Actual Main lacks restricted module/cache environment");
  const sanitized=sanitizeZCodeRuntimeEnv(main);for(const name of [...REQUIRED,"PSModulePath","PSModuleAnalysisCachePath"])if(sanitized[name]!==main[name])throw new Blocked("Host sanitizer changes a required isolated path");
  const shell=(main.PATH||"").split(";").filter(Boolean).map(dir=>join(dir,"pwsh.exe"));let first:string|undefined;
  for(const candidate of shell){try{const info=await lstat(candidate);if(info.isSymbolicLink())throw new Blocked("Shell search contains a linked executable");if(info.isFile()){await ancestors(candidate);first=resolve(candidate);break;}}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
  if(first?.toLowerCase()!==PWSH.toLowerCase())throw new Blocked("Host shell search does not resolve the audited installed pwsh.exe");
  const script="$ErrorActionPreference='Stop';$roots=@($PROFILE.AllUsersAllHosts,$PROFILE.AllUsersCurrentHost,$PROFILE.CurrentUserAllHosts,$PROFILE.CurrentUserCurrentHost);[pscustomobject]@{profiles=@($roots|ForEach-Object{[pscustomobject]@{path=[IO.Path]::GetFullPath($_);exists=[IO.File]::Exists($_)}});modules=@($env:PSModulePath -split ';'|Where-Object{$_}|ForEach-Object{[pscustomobject]@{path=[IO.Path]::GetFullPath($_);exists=[IO.Directory]::Exists($_)}})}|ConvertTo-Json -Compress -Depth 4";
  const probe=await browser.electron.execute(async(_electron,shellPath,command)=>{const {execFile}=await import("node:child_process");return await new Promise<string>((resolveProbe,reject)=>{execFile(shellPath,["-NoProfile","-NonInteractive","-Command",command],{env:{...process.env},windowsHide:true,timeout:15_000,maxBuffer:16384},(error,stdout)=>error?reject(new Error("SLM NoProfile readonly probe failed")):resolveProbe(stdout));});},PWSH,script);
  const parsed=parseShortTerminalProbe(probe);
  if(parsed.profiles.length!==4)throw new Blocked("PowerShell profile probe returned incomplete classification");
  const profileEvidence=[];for(const row of parsed.profiles){await ancestors(row.path);const inside=contained(row.path);if(row.exists&&!inside)throw new Blocked("An existing PowerShell profile is outside the worktree");if(inside)await audit(row.path);profileEvidence.push({exists:row.exists,insideWorktree:inside});}
  const moduleEvidence=[];for(const row of parsed.modules){await ancestors(row.path);const inside=contained(row.path);const installed=MODULE_ROOTS.findIndex(root=>root.toLowerCase()===row.path.toLowerCase());const optional=row.path.toLowerCase()===OPTIONAL_MODULE_ROOT.toLowerCase();if(inside)await audit(row.path);else if(installed>=0){if(!row.exists)throw new Blocked("Audited installed module root vanished");}else if(!optional||row.exists)throw new Blocked("PowerShell introduces an unapproved external module directory");moduleEvidence.push({insideWorktree:inside,knownSystemIndex:installed>=0?installed:optional?2:null,exists:row.exists});}
  await capture("terminal-safety",{status:"preflight",probeReturnType:typeof probe,probeValidated:true,shellResolved:true,mainRunEnvironmentEqual:true,hostInheritance:"current source contract plus actual Main environment",sourceSha256:sources.map(({path,text})=>({path,sha256:createHash("sha256").update(text).digest("hex")})),profiles:profileEvidence,modules:moduleEvidence});
}
async function terminalCommand(command:string,output:string) {
  await $('[data-workspace-side-frame] .xterm-screen').waitForDisplayed({timeout:20_000});await click('[data-workspace-side-frame] .xterm-screen');
  await browser.waitUntil(async()=>await $('[data-workspace-side-frame] .xterm-helper-textarea').isFocused(),{timeout:5000});await browser.keys(command);await browser.keys("Enter");
  await browser.waitUntil(()=>browser.execute(marker=>[...document.querySelectorAll('[data-workspace-side-frame] .xterm-rows > div')].some(row=>row.textContent?.trim()===marker),output),{timeout:20_000,timeoutMsg:"SLM actual terminal output missing"});
}

const CHAT_FIND='input[placeholder="Search messages..."],input[placeholder="搜索消息..."]';
async function openChatFind() {
  await activateTask();await click('[data-testid="v4-composer-input"]');
  await browser.action("key").down(Key.Control).down("f").up("f").up(Key.Control).perform();
  await $(CHAT_FIND).waitForDisplayed({timeout:15_000});
}
async function findSnapshot() {
  return browser.execute(()=>{
    const viewport=document.querySelector<HTMLElement>('[data-testid="v4-timeline"]');const input=document.querySelector<HTMLInputElement>('input[placeholder="Search messages..."],input[placeholder="搜索消息..."]');
    const registry=(CSS as unknown as {highlights?:Map<string,Iterable<Range>>}).highlights;const range=registry?.get("zcode-v4-conversation-find-active")?.[Symbol.iterator]().next().value as Range|undefined;
    const rect=range?.getBoundingClientRect();const vp=viewport?.getBoundingClientRect();
    return{counter:input?.parentElement?.textContent?.trim()||"",activeText:range?.toString()||null,scrollTop:viewport?.scrollTop||0,height:vp?.height||0,distance:rect&&vp?Math.abs(rect.top+rect.height/2-vp.top-vp.height/2):null,rangeTop:rect?.top??null};
  });
}
async function findCentered(index:number) {
  await browser.waitUntil(async()=>{const state=await findSnapshot();return state.counter.includes(`${index}/3`)&&state.activeText===FIND_MARKER&&state.distance!==null&&state.distance<=Math.max(120,state.height*.3);},{timeout:20_000,timeoutMsg:`SLM chat find result ${index}/3 did not center`});return findSnapshot();
}
async function moveFind(action:"next"|"previous"|"enter"|"shift-enter") {
  if(action==="next"||action==="previous")await click(action==="next"?'button[aria-label="Next result"],button[aria-label="下一个结果"]':'button[aria-label="Previous result"],button[aria-label="上一个结果"]');
  else{await $(CHAT_FIND).click();if(action==="enter")await browser.keys("Enter");else await browser.action("key").down(Key.Shift).down(Key.Enter).up(Key.Enter).up(Key.Shift).perform();}
}

describe("SLM 当前fork最短剩余本地菜单（外置pending）",()=>{
  before(async function(){
    this.timeout(180_000);
    try {
      await preparePaths();await prepareV4ConversationE2E({skipProvider:true});await setCurrentElectronRendererContentSize(1280,900);preferences=await browser.execute(()=>({locale:localStorage.getItem("zcode-locale-preference")||"system",mode:localStorage.getItem("zcode-interface-mode")==="office"?"office":"coding"}));await presentation("locale","en-US");await presentation("mode","coding");await installAdapters();await installLocalQaRpcProbe();baselineRequests=await countUpstreamRequests({});
    } catch (error) {
      if (evidence) {
        try { await capture("beforeAll-failure",{status:"setup-failed",error:error instanceof Error ? error.message : String(error)}); }
        catch (evidenceError) { throw new AggregateError([error,evidenceError],"SLM setup failed; failure evidence also failed"); }
      }
      throw error;
    }
  });
  afterEach(async()=>{await closeOverlays();await browser.releaseActions();});
  after(async function(){this.timeout(60_000);if(preferences){await presentation("mode",preferences.mode);await presentation("locale",preferences.locale);}await browser.execute(()=>{window.__qaShortAdapters?.restore();window.__remoteProjectHandoffRpc?.restore();});await browser.electron.restoreAllMocks();});

  it("SLM01: 原生帮助更新日志只请求本fork mock链接",async function(){await runCase(this,"SLM01",async()=>{
    const external=await browser.electron.mock("shell","openExternal");await external.mockResolvedValue(undefined);
    try{const menu=await nativeClick("changelog");await browser.waitUntil(async()=>{await external.update();return external.mock.calls.length===1;},{timeout:15_000});expect(external.mock.calls[0]?.[0]).toBe("https://github.com/No-ni/ZCodium/blob/main/CHANGELOG.md");await capture("SLM01-native-callback",{status:"passed",menu,url:external.mock.calls[0]?.[0],externalOpened:false});}
    finally{await external.mockRestore();}
  });});
  it("SLM02: 原生开发者工具真实打开关闭并恢复",async function(){await runCase(this,"SLM02",async()=>{
    const original=await devtoolsOpen();try{if(original){await nativeClick("devtools");await browser.waitUntil(async()=>!await devtoolsOpen(),{timeout:10_000});}await nativeClick("devtools");await browser.waitUntil(()=>devtoolsOpen(),{timeout:10_000});await capture("SLM02-open",{status:"passed",opened:true});await nativeClick("devtools");await browser.waitUntil(async()=>!await devtoolsOpen(),{timeout:10_000});}
    finally{if((await devtoolsOpen())!==original){await nativeClick("devtools");await browser.waitUntil(async()=>(await devtoolsOpen())===original,{timeout:10_000});}}
  });});
  it("SLM03: 原生清除所有数据受控取消保留本地数据",async function(){await runCase(this,"SLM03",async()=>{
    const beforeIds=(await indexRows()).map(row=>row.task_id).sort();const settingsPath=await safe(join(home,".zcodium/v2/setting.json"));const beforeHash=await fingerprint(settingsPath);expect(beforeHash).not.toBeNull();
    const dialog=await browser.electron.mock("dialog","showMessageBox");await dialog.mockResolvedValue({response:0,checkboxChecked:false});
    const relaunch=await browser.electron.mock("app","relaunch");await relaunch.mockReturnValue(undefined);const exit=await browser.electron.mock("app","exit");await exit.mockReturnValue(undefined);
    try{await nativeClick("clear");await browser.waitUntil(async()=>{await dialog.update();return dialog.mock.calls.length===1;},{timeout:10_000});const options=dialog.mock.calls[0]?.at(-1) as Electron.MessageBoxOptions;expect(options.buttons).toEqual(["Cancel","Clear All"]);expect(options.defaultId).toBe(0);expect(options.cancelId).toBe(0);await relaunch.update();await exit.update();expect(relaunch.mock.calls).toHaveLength(0);expect(exit.mock.calls).toHaveLength(0);expect((await indexRows()).map(row=>row.task_id).sort()).toEqual(beforeIds);expect(await fingerprint(settingsPath)).toBe(beforeHash);await capture("SLM03-cancel",{status:"passed",dialog:options,response:0,relaunchCalls:0,exitCalls:0,beforeHash});}
    finally{await dialog.mockRestore();await relaunch.mockRestore();await exit.mockRestore();}
  });});
  it("SLM04: 两个合成项目键盘排序持久化并反向恢复",async function(){await runCase(this,"SLM04",async()=>{
    const suffix=String(Date.now());const a=await createProject(`SLM_SORT_A_${suffix}`);const b=await createProject(`SLM_SORT_B_${suffix}`);const original=await projectOrder();
    if(Math.abs(original.ids.indexOf(a)-original.ids.indexOf(b))!==1)throw new Error("SLM newly created project pair is not adjacent");
    const first=original.ids.indexOf(a)<original.ids.indexOf(b)?a:b;const second=first===a?b:a;
    try{await moveProject(first,"ArrowDown");await browser.waitUntil(async()=>{const order=await projectOrder();return order.ids.indexOf(first)>order.ids.indexOf(second)&&Boolean(order.stored?.includes(JSON.stringify(["local",first])));},{timeout:15_000});await capture("SLM04-reordered",{status:"passed",original,current:await projectOrder(),syntheticIds:[a,b]});}
    finally{if((await projectOrder()).ids.indexOf(first)>(await projectOrder()).ids.indexOf(second)){await moveProject(first,"ArrowUp");await browser.waitUntil(async()=>JSON.stringify((await projectOrder()).ids)===JSON.stringify(original.ids),{timeout:15_000});}}
  });});
  it("SLM05: 公开completed归档真实导入并复制assistant正文",async function(){await runCase(this,"SLM05",async()=>{
    await activateTask();const row=await browser.execute(marker=>[...document.querySelectorAll<HTMLElement>('[data-row-id]')].find(el=>el.textContent?.includes(marker)&&el.querySelector('[data-testid^="v4-copy-"]'))?.dataset.rowId||null,COPY_MARKER);
    if(!row) {
      const readonly = await browser.execute(marker => ({notice:document.querySelector('[data-conversation-share-import-notice="true"]')?.textContent?.includes(marker) === true, runtimeCopies:document.querySelectorAll('[data-testid^="v4-copy-"]').length}), COPY_MARKER);
      expect(readonly.notice).toBe(true);await capture("SLM05-readonly-fixture-boundary",{status:"blocked",readonly});
      throw new Blocked("Public archive renders readonly rows; no runtime assistant copy action. Needs separate finite replay runtime fixture");
    }
    const copy=`[data-testid="v4-copy-${row}"]`;await $(copy).scrollIntoView({block:"center"});const before=await clipCount();await click(copy);const clip=await newClip(before);expect(clip.method).toBe("writeText");expect(clip.text).toBe(ASSISTANT_TEXT);
    await browser.waitUntil(async()=>Boolean(await $(`${copy} svg.lucide-check`).isExisting()),{timeout:5000});await browser.waitUntil(async()=>!await $(`${copy} svg.lucide-check`).isExisting(),{timeout:5000});await capture("SLM05-assistant-copy",{status:"passed",rowId:row,method:clip.method,textLength:clip.text.length,sha256:createHash("sha256").update(clip.text).digest("hex")});
  });});
  it("SLM06: 引导侧栏和通用页两个入口进入退出",async function(){await runCase(this,"SLM06",async()=>{
    await openSettings();await click('[data-testid="settings-page"] button',/^(Onboard|引导)$/u);await closeOnboarding();await capture("SLM06-sidebar-return",{status:"passed"});
    await click('[data-settings-section-nav="general"]');await click('[data-testid="settings-page"] main button',/^(Open onboarding|打开引导)$/u);await closeOnboarding();await capture("SLM06-general-return",{status:"passed"});
  });});
  it("SLM07: 机器人管理新增渠道选择前取消无新增Bot",async function(){await runCase(this,"SLM07",async()=>{
    await activateTask();const before=await callHandoffHost<{bots:unknown[]}>(ServiceChannels.Bots,"getConfig",[]);if(before.bots.length)throw new Blocked("Synthetic run Bot configuration is not empty; no registration UI entered");
    const botConfig=await safe(join(home,".zcodium/v2/bot-config.v3.json"));const initialHash=await fingerprint(botConfig);
    await click('button[aria-label="Mobile remote control"],button[aria-label="移动端远程控制"]');await click('[role="dialog"] button',/^(Manage bots|机器人管理)$/u);
    await click('[role="dialog"] button',/^(New bot|新建机器人)$/u);await browser.waitUntil(()=>browser.execute(()=>document.body.innerText.includes("Choose a channel on the right to create a bot.")||document.body.innerText.includes("在右侧选择一个渠道来创建机器人。")),{timeout:15_000});await capture("SLM07-provider-choice",{status:"passed",providerChosen:false});
    await browser.keys("Escape");await browser.waitUntil(async()=>!await visible('[role="dialog"]'),{timeout:15_000});expect(await callHandoffHost(ServiceChannels.Bots,"getConfig",[])).toEqual(before);expect(await fingerprint(botConfig)).toBe(initialHash);
  });});
  it("SLM08: 文件树绝对相对路径复制只写mock剪贴板",async function(){await runCase(this,"SLM08",async()=>{
    await activateTask();for(const entry of [{label:/^(Copy absolute path|复制绝对路径)$/u,expected:filePath},{label:/^(Copy relative path|复制相对路径)$/u,expected:FILE_NAME}]){const before=await clipCount();await fileMenu(entry.label);const clip=await newClip(before);expect(clip.text).toBe(entry.expected);await capture("SLM08-path",{status:"passed",pathKind:entry.expected===filePath?"absolute":"relative",method:clip.method,text:clip.text});}
  });});
  it("SLM09: 文件加入聊天及另存为取消保留源文件",async function(){await runCase(this,"SLM09",async()=>{
    await activateTask();const originalText=await browser.execute(()=>document.querySelector<HTMLElement>('[data-testid="v4-composer-input"]')?.innerText||"");const hash=await fingerprint(filePath);const ids=(await indexRows()).map(row=>row.task_id).sort();
    const save=await browser.electron.mock("dialog","showSaveDialog");await save.mockResolvedValue({canceled:true,filePath:undefined});
    try{await fileMenu(/^(Add to chat|添加到聊天|添加到对话)$/u);await browser.waitUntil(()=>browser.execute(name=>document.querySelector<HTMLElement>('[data-testid="v4-composer-input"]')?.innerText.includes(name)===true,FILE_NAME),{timeout:15_000});await capture("SLM09-file-mentioned",{status:"passed",file:filePath,providerSent:false});
      await fileMenu(/^(Save as…|Save as\.\.\.|另存为…|另存为\.\.\.)$/u);await browser.waitUntil(async()=>{await save.update();return save.mock.calls.length===1;},{timeout:20_000});expect(await fingerprint(filePath)).toBe(hash);expect((await indexRows()).map(row=>row.task_id).sort()).toEqual(ids);await capture("SLM09-save-cancel",{status:"passed",sourceHash:hash,canceled:true,options:save.mock.calls[0]?.at(-1)});
    }finally{await save.mockRestore();await setV4ComposerText(originalText);}
  });});
  it("SLM10: Review真实Git入口空态或列表与tab关闭",async function(){await runCase(this,"SLM10",async()=>{
    const current=await activateTask();await presentation("mode","coding");const own=await openReview();
    try{await $('[data-testid="git-pane"]').waitForDisplayed({timeout:30_000});const text=await $('[data-testid="git-pane"]').getText();expect(text.length).toBeGreaterThan(0);expect((await getV4PaneSnapshot()).sessionId).toBe(current.id);await capture("SLM10-review",{status:"passed",content:text.slice(0,2000),coverage:"real Review route and Git pane content/empty state; no diff/commit/push"});}
    finally{if(own)await closeTab("git");}
  });});
  it("SLM11: 办公模式隐藏新Review终端且保留已有Review",async function(){await runCase(this,"SLM11",async()=>{
    const current=await activateTask();await presentation("mode","coding");const own=await openReview();
    try{await presentation("mode","office");expect((await paneTabs()).some(tab=>tab.id==="git")).toBe(true);await launcher();expect(await visible('[data-side-pane-open-tab-item="review"]')).toBeUndefined();expect(await visible('[data-side-pane-open-tab-item="terminal"]')).toBeUndefined();await closeMenus();await click('[data-side-pane-tab-id="git"]');await $('[data-testid="git-pane"]').waitForDisplayed({timeout:15_000});expect((await getV4PaneSnapshot()).sessionId).toBe(current.id);await capture("SLM11-office-existing-review",{status:"passed",ptyCovered:false});}
    finally{await presentation("mode","coding");if(own)await closeTab("git");}
  });});
  it("SLM12: 真实侧栏launcher不提供Whiteboard入口",async function(){await runCase(this,"SLM12",async()=>{
    await activateTask();await presentation("mode","coding");await launcher();expect(await visible('[data-side-pane-open-tab-item="browser"]')).toBeDefined();expect(await visible('[data-side-pane-open-tab-item="whiteboard"]')).toBeUndefined();expect(await visible('[role="menuitem"]',/^(Whiteboard|白板)$/u)).toBeUndefined();await capture("SLM12-no-whiteboard",{status:"passed",coverage:"current launcher absence only"});await closeMenus();
  });});
  it("SLM13: 安全门禁后的本地Terminal读取echo与办公PTY保留",async function(){await runCase(this,"SLM13",async()=>{
    await terminalGate();const current=await activateTask();await audit(current.executionPath);await presentation("mode","coding");const prior=new Set((await paneTabs()).map(tab=>tab.id));await launcher();await click('[data-side-pane-open-tab-item="terminal"]');
    let id:string|undefined;await browser.waitUntil(async()=>Boolean(id=(await paneTabs()).find(tab=>tab.id.startsWith("terminal:")&&!prior.has(tab.id))?.id),{timeout:20_000});
    try{await terminalCommand("echo 'SLM_TERMINAL_ALIVE_01'","SLM_TERMINAL_ALIVE_01");await terminalCommand(`if ($PSHOME -eq 'C:\\Program Files\\PowerShell\\7') { echo 'SLM_TERMINAL_PWSH_MATCH' }`,"SLM_TERMINAL_PWSH_MATCH");
      const inputFile=await safe(join(current.executionPath,"SLM_TERMINAL_INPUT.txt"));await writeFile(inputFile,"SLM_TERMINAL_FILE_CONTENT\n",{flag:"wx"});
      await terminalCommand(`Get-Content -LiteralPath '${inputFile.replace(/'/gu,"''")}'`,"SLM_TERMINAL_FILE_CONTENT");
      await terminalCommand(`if ((Get-Location).Path -eq '${current.executionPath.replace(/'/gu,"''")}') { echo 'SLM_TERMINAL_CWD_MATCH' }`,"SLM_TERMINAL_CWD_MATCH");
      await presentation("mode","office");await click(`[data-side-pane-tab-id=${JSON.stringify(id)}]`);await terminalCommand("echo 'SLM_TERMINAL_ALIVE_02'","SLM_TERMINAL_ALIVE_02");await capture("SLM13-office-pty",{status:"passed",sameTab:id,pwshActualMatch:true,cwdActualMatch:true,fileRead:true});
    }finally{await presentation("mode","coding");if(id&&(await paneTabs()).some(tab=>tab.id===id))await closeTab(id);}
  });});
  it("SLM14: 公开长会话三命中查找导航与重开居中",async function(){await runCase(this,"SLM14",async()=>{
    await activateTask();
    const source = await browser.execute(marker => ({readonlyOccurrences:(document.querySelector('[data-conversation-share-import-notice="true"]')?.textContent || "").split(marker).length-1, runtimeRow:[...document.querySelectorAll('[data-row-id]')].some(element=>element.textContent?.includes(marker))}), FIND_MARKER);
    if (!source.runtimeRow) { expect(source.readonlyOccurrences).toBe(3);await capture("SLM14-readonly-fixture-boundary",{status:"blocked",source});throw new Blocked("Public archive header rows are outside runtime conversation Find index; needs finite replay runtime history"); }
    await openChatFind();await $(CHAT_FIND).setValue(FIND_MARKER);await findCentered(1);let index=1;
    for(const action of ["next","previous","enter","shift-enter"] as const){await browser.execute(()=>{const viewport=document.querySelector<HTMLElement>('[data-testid="v4-timeline"]')!;viewport.scrollTop=0;viewport.dispatchEvent(new Event("scroll",{bubbles:true}));});await moveFind(action);index=(action==="next"||action==="enter")?index%3+1:(index+1)%3+1;await findCentered(index);await capture(`SLM14-${action}`,{status:"passed",find:await findSnapshot()});}
    await browser.keys("Escape");await $(CHAT_FIND).waitForExist({reverse:true,timeout:10_000});await openChatFind();expect(await $(CHAT_FIND).getValue()).toBe("");await $(CHAT_FIND).setValue(FIND_MARKER);await findCentered(1);await capture("SLM14-reopened",{status:"passed",queryResetOnClose:true,find:await findSnapshot()});await browser.keys("Escape");
  });});
  it("SLM15: 长text真实预览滚动与当前无局部Find边界",async function(){await runCase(this,"SLM15",async()=>{
    const selector=await fileRow();await clickPaintedControl(selector);await $('[data-testid="preview-pane"]').waitForDisplayed({timeout:30_000});
    await browser.waitUntil(async()=>(await readQaPreviewLines()).lines.some(line=>line.line==="1"&&line.normalized==="合成文件查找行 1：仅本树离线QA。"),{timeout:30_000});await capture("SLM15-shadow-first-line",{status:"loaded",preview:await readQaPreviewLines()});
    const metrics=await browser.execute(()=>{const pane=document.querySelector<HTMLElement>('[data-testid="preview-pane"]')!;const scroll=[...pane.querySelectorAll<HTMLElement>("*")].find(el=>el.scrollHeight>el.clientHeight+100&&["auto","scroll"].includes(getComputedStyle(el).overflowY));if(!scroll)return null;scroll.scrollTop=Math.min(5000,scroll.scrollHeight-scroll.clientHeight);scroll.dispatchEvent(new Event("scroll",{bubbles:true}));return{top:scroll.scrollTop,height:scroll.clientHeight,total:scroll.scrollHeight,findInputs:[...pane.querySelectorAll<HTMLInputElement>("input")].map(input=>({type:input.type,placeholder:input.placeholder})),};});
    expect(metrics?.top).toBeGreaterThan(0);expect(metrics?.findInputs.some(input=>input.type==="search"||/search|find|查找|搜索/iu.test(input.placeholder))).toBe(false);await capture("SLM15-preview-scroll",{status:"passed",coverage:"FILE03 preview partial; local file Find currently unavailable",metrics});
    await browser.action("key").down(Key.Control).down("f").up("f").up(Key.Control).perform();await $(CHAT_FIND).waitForDisplayed({timeout:15_000});expect(await $('[data-testid="preview-pane"]').isDisplayed()).toBe(true);await capture("SLM15-task-find-route",{status:"passed",scope:"task conversation, not filepreview search"});await browser.keys("Escape");
  });});
});
