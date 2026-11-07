import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Key } from "webdriverio";
import { ServiceChannels, sanitizeZCodeRuntimeEnv, type BotConfig, type GitDiffResult, type GitFileChange } from "@zcode/shared";
import type { VirtualProject } from "../../../../../packages/services/src/index.js";
import { DEFAULT_WORKSPACE, readSettings, setCurrentElectronRendererContentSize } from "../../../../../packages/desktop/test/e2e/helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "../../../../../packages/desktop/test/e2e/helpers/v4-conversation.js";
import { startDraftFromProject, selectNativeProjectDirectories } from "../../../../../packages/desktop/test/e2e/helpers/project-sidebar.js";
import { callHandoffHost } from "../../../../../packages/desktop/test/e2e/helpers/remote-project-handoff-probe.js";
import { countUpstreamRequests } from "../../../../../packages/desktop/test/e2e/helpers/conversation-session-network.js";
import { startElectronWindowRecording, type ElectronWindowRecordingSession } from "../../../../../packages/desktop/test/e2e/helpers/electron-window-recorder.js";
import { installLocalQaRpcProbe } from "../../qa-local-rpc-probe.js";
import { visibleControl, clickVisibleControl, closeVisibleMenus } from "../../qa-menu-dom.js";

// 外置QA仅通过真实UI和公开Host读取事实；写入只有独占合成输入，禁止清理或提交。
const ROOT=resolve(fileURLToPath(new URL("../../../../../",import.meta.url)));
const PWSH="C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const GIT="C:\\Program Files\\Git\\cmd\\git.exe";
const REQUIRED=["HOME","USERPROFILE","TEMP","TMP","TMPDIR","APPDATA","LOCALAPPDATA","COREPACK_HOME","PNPM_HOME","npm_config_cache","npm_config_store_dir","npm_config_userconfig","TSX_CACHE_DIR","NODE_COMPILE_CACHE","XDG_CACHE_HOME","XDG_CONFIG_HOME","XDG_DATA_HOME","ZCODE_E2E_HOME_DIR","ZCODE_E2E_ARTIFACT_DIR"];
const SETTINGS='[data-testid="settings-page"]';
let home:string,evidence:string,fixtures:string,suffix:string;
let sequence=0,requests=0;
let locale:string;
interface GapClipboard {clips:Array<{method:string;text:string}>;restore():void}
declare global {interface Window {__qaGapClipboard?:GapClipboard}}
class Blocked extends Error {}
async function safe(candidate:string){
  if(!isAbsolute(candidate))throw new Error("FLG requires absolute tree path");
  const path=resolve(candidate),rel=relative(ROOT,path);
  if(!rel||isAbsolute(rel)||rel===".."||rel.startsWith(`..${sep}`))throw new Error("FLG path outside worktree");
  for(let cursor=path;;cursor=dirname(cursor)){
    try{if((await lstat(cursor)).isSymbolicLink()||(await realpath(cursor)).toLowerCase()!==cursor.toLowerCase())throw new Error("FLG reparse/redirect ancestor rejected");}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    if(cursor===dirname(cursor))break;
  }
  return path;
}
async function audit(candidate:string){
  const target=await safe(candidate),guard=await safe(join(ROOT,"docs/testing/qa-2026-11-06/qa-reparse-children.ps1"));
  const script=readFileSync(guard,"utf8")+"\n$ErrorActionPreference='Stop';$cursor=$env:FLG_AUDIT_TARGET;while($cursor){if(Test-Path -LiteralPath $cursor){if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'FLG reparse ancestor'}};$cursor=[IO.Path]::GetDirectoryName($cursor)};if(Test-Path -LiteralPath $env:FLG_AUDIT_TARGET -PathType Container){$q=[Collections.Generic.Queue[string]]::new();$q.Enqueue($env:FLG_AUDIT_TARGET);while($q.Count){foreach($i in Get-QaAuditChildren $q.Dequeue()){if($i.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'FLG reparse descendant'};if($i.PSIsContainer){$q.Enqueue($i.FullName)}}}}";
  execFileSync(PWSH,["-NoProfile","-NonInteractive","-Command",script],{env:{...process.env,FLG_AUDIT_TARGET:target,QA_REPARSE_WORKTREE:ROOT},windowsHide:true,stdio:"pipe",timeout:30_000});
}
async function paths(){
  if(process.platform!=="win32"||process.env.E2E_PROVIDER_HTTP_MODE!=="replay"||process.env.ZCODE_E2E_MANUAL_REVIEW!=="1"||process.env.E2E_PROVIDER_CAPTURE_MODE==="capture")throw new Error("FLG requires isolated Windows finite replay");
  for(const name of REQUIRED)await safe(process.env[name]||"");
  home=await safe(process.env.ZCODE_E2E_HOME_DIR!);const artifacts=await safe(process.env.ZCODE_E2E_ARTIFACT_DIR!);
  if(resolve(DEFAULT_WORKSPACE)!==join(home,"ZCodeProject"))throw new Error("FLG workspace differs from own HOME");
  await audit(home);await audit(artifacts);
  const worker=(process.env.WDIO_WORKER_ID||String(process.pid)).replace(/[^a-zA-Z0-9_-]/gu,"_");
  const files=(await readdir(artifacts)).filter(name=>name.startsWith(`qa-project-bootstrap-${worker}-`)&&name.endsWith("-after.json"));
  const snapshots=await Promise.all(files.map(async name=>JSON.parse(await readFile(await safe(join(artifacts,name)),"utf8"))));
  if(!snapshots.some(item=>item.workerId===worker&&item.database===join(home,".zcodium/v2/tasks-index.sqlite")&&item.projects?.some((p:{name:string;host_id:string;deleted:number})=>p.name==="ZCodeProject"&&p.host_id==="local"&&!p.deleted)))throw new Error("FLG own worker bootstrap missing");
  suffix=`${worker}-${process.pid}-${Date.now()}`;evidence=await safe(join(artifacts,`qa-final-local-gaps-${suffix}`));fixtures=await safe(join(home,"ZCodeProject/.zcode-e2e",`qa-final-${suffix}`));
  await mkdir(evidence);await mkdir(fixtures,{recursive:true});
}
async function click(selector:string,pattern?:RegExp){await clickVisibleControl(selector,pattern,"FLG");}
async function close(){await closeVisibleMenus("FLG");for(let i=0;i<3&&await visibleControl('[role="dialog"]');i++)await browser.keys("Escape");if(await visibleControl(SETTINGS))await click('[data-testid="settings-back-button"]');}
async function presentation(value:string){
  await close();await click('[data-testid="sidebar-preferences-trigger"]');await click('[role="menuitem"][aria-haspopup="menu"]',/^(Language|界面语言)$/u);
  await click('[role="menuitemradio"]',value==="en-US"?/^English$/u:value==="zh-CN"?/^中文简体$/u:/^(System default|跟随系统|系统默认)$/u);
  await closeVisibleMenus("FLG");await browser.waitUntil(async()=>{const settings=await readSettings();return settings.localePreference===value&&(value==="system"||settings.locale===value);},{timeout:15_000});
}
async function settings(section="general"){
  await close();await click('[data-testid="task-settings-button"]');await click(`[data-settings-section-nav="${section}"]`);
  await browser.waitUntil(()=>browser.execute(()=>{const main=document.querySelector('[data-testid="settings-page"] main');return main&&!/^(Loading…|Loading\.\.\.|加载中…|加载中\.\.\.)$/u.test((main.textContent||"").trim());}),{timeout:20_000});
}
async function adapters(){await browser.execute(`
  const clipboard=navigator.clipboard;if(!clipboard)throw new Error('FLG clipboard unavailable');
  const text=Object.getOwnPropertyDescriptor(clipboard,'writeText'),write=Object.getOwnPropertyDescriptor(clipboard,'write');
  const state={clips:[],restore(){if(text)Object.defineProperty(clipboard,'writeText',text);else delete clipboard.writeText;if(write)Object.defineProperty(clipboard,'write',write);else delete clipboard.write;delete window.__qaGapClipboard;}};
  Object.defineProperty(clipboard,'writeText',{configurable:true,value:async value=>{state.clips.push({method:'writeText',text:await value});}});
  Object.defineProperty(clipboard,'write',{configurable:true,value:async items=>{if(items.length!==1||items[0].types.length!==1||items[0].types[0]!=='text/plain')throw new Error('FLG requires one plain synthetic ClipboardItem');state.clips.push({method:'write',text:await(await items[0].getType('text/plain')).text()});}});window.__qaGapClipboard=state;
`);}
async function capture(name:string,details:Record<string,unknown>){
  const stem=await safe(join(evidence,`${String(++sequence).padStart(3,"0")}-${name}`));
  const state=await browser.execute(()=>({dpr:devicePixelRatio,section:document.querySelector('[data-settings-section-nav][data-state="active"]')?.getAttribute("data-settings-section-nav"),activeTag:document.activeElement?.tagName,headings:[...document.querySelectorAll("h1,h2,h3")].filter(el=>el.checkVisibility()).map(el=>el.textContent),clipboardLengths:window.__qaGapClipboard?.clips.map(clip=>clip.text.length)||[]}));
  const reservation=await open(stem+".png","wx");await reservation.close();await browser.saveScreenshot(stem+".png");
  await writeFile(stem+".json",JSON.stringify({capturedAt:new Date().toISOString(),evidenceKind:"isolated synthetic public inputs; real UI; mocked native/clipboard exits",...details,state},null,2)+"\n",{flag:"wx"});
}
async function run(context:Mocha.Context,id:string,action:()=>Promise<void>){
  context.timeout(180_000);let recording:ElectronWindowRecordingSession|undefined;
  try{await capture(id+"-before",{status:"before"});recording=await startElectronWindowRecording({browser,frameDir:await safe(join(evidence,id+"-frames")),outputPath:await safe(join(evidence,id+"-unencoded.webm")),frameIntervalMs:1000,preRollDurationMs:0,cleanupFrames:false,encodeVideo:async()=>{throw new Error("Standard encoder unavailable; PNG/time sequence retained");}});await action();expect(await countUpstreamRequests({})).toBe(requests);await capture(id,{status:"passed"});await recording.discard();recording=undefined;}
  catch(error){await capture(id,{status:error instanceof Blocked?"blocked":"failed",reason:error instanceof Error?error.message:String(error)});if(error instanceof Blocked){context.skip();return;}throw error;}
  finally{if(recording){try{await recording.stop({tailDurationMs:0,timeoutMs:10_000});}catch(error){await capture(id+"-recording-limit",{status:"evidence-limited",reason:error instanceof Error?error.message:String(error),encodedVideo:false});}}}
}
type Preferences=Awaited<ReturnType<typeof readSettings>>;
type BooleanField="askUserQuestionAutoResolutionEnabled"|"messageStreamShowReasoning"|"messageStreamShowTodos"|"toolGroupingExploreEnabled"|"toolGroupingTerminalEnabled"|"toolGroupingChangesEnabled"|"memoryEnabled";
async function toggle(selector:string,key:BooleanField,value:boolean){
  await browser.waitUntil(async()=>Boolean(await visibleControl(selector)),{timeout:15_000});
  if(await $(selector).getAttribute("aria-checked")!==String(value))await click(selector);
  await browser.waitUntil(async()=>(await readSettings())[key]===value&&(await $(selector).getAttribute("aria-checked"))===String(value),{timeout:15_000,timeoutMsg:`FLG ${key} did not persist`});
}
async function behavior(value:"queue"|"guide"){
  const selector='[data-testid="settings-page"] main button[role="combobox"]';
  const index=await browser.execute(()=>{const label=[...document.querySelectorAll('[data-testid="settings-page"] main div')].find(el=>el.childElementCount===0&&el.textContent?.trim()==="Interaction behavior");const row=label?.parentElement?.parentElement;const select=row?.querySelector('button[role="combobox"]');return select?[...document.querySelectorAll('[data-testid="settings-page"] main button[role="combobox"]')].indexOf(select):-1;});
  if(index<0)throw new Error("FLG current behavior row control missing");await (await $$(selector))[index]!.click();await click('[role="option"]',value==="queue"?/^Queue$/u:/^Guide$/u);
  await browser.waitUntil(async()=>(await readSettings()).zcodeInteractionBehavior===value&&(await (await $$(selector))[index]!.getText()).trim()===(value==="queue"?"Queue":"Guide"),{timeout:15_000});
}
async function fingerprint(path:string){return createHash("sha256").update(await readFile(await safe(path))).digest("hex");}
async function copied(before:number){await browser.waitUntil(()=>browser.execute(index=>window.__qaGapClipboard!.clips.length===index+1,before),{timeout:15_000});return browser.execute(index=>window.__qaGapClipboard!.clips[index]!,before);}
async function nativeSafeMocks(){
  const external=await browser.electron.mock("shell","openExternal");await external.mockResolvedValue(undefined);
  const openPath=await browser.electron.mock("shell","openPath");await openPath.mockResolvedValue("");
  const reveal=await browser.electron.mock("shell","showItemInFolder");await reveal.mockReturnValue(undefined);
  return {external,openPath,reveal};
}
async function gitGate(){
  if(resolve(process.env.QA_SAFE_GIT_WORKTREE||"")!==ROOT||!process.env.QA_SAFE_GIT_ROOT)throw new Blocked("SafeGit startup controls absent");
  const root=await safe(process.env.QA_SAFE_GIT_ROOT);await audit(root);
  const expected={GIT_CONFIG_GLOBAL:join(root,"global.gitconfig"),GIT_CONFIG_SYSTEM:join(root,"system.gitconfig"),GIT_CONFIG_NOSYSTEM:"1",GIT_TEMPLATE_DIR:join(root,"templates")};
  if(Object.keys(process.env).some(key=>key.startsWith("GIT_")&&!Object.hasOwn(expected,key)))throw new Blocked("Unknown inherited Git environment key rejected");
  for(const [key,value]of Object.entries(expected))if(process.env[key]!==value)throw new Blocked("SafeGit worker value mismatch");
  for(const name of ["global.gitconfig","system.gitconfig","attributes"])if((await readFile(await safe(join(root,name)))).length!==0)throw new Blocked("SafeGit config input is not empty");
  for(const name of ["templates","hooks"])if((await readdir(await safe(join(root,name)))).length!==0)throw new Blocked("SafeGit directory is not empty");
  const main=await browser.electron.execute((_electron,keys:string[])=>({values:Object.fromEntries(keys.map(key=>[key,process.env[key]??null])),gitKeys:Object.keys(process.env).filter(key=>key.startsWith("GIT_"))}),[...REQUIRED,...Object.keys(expected),"QA_SAFE_GIT_ROOT","QA_SAFE_GIT_WORKTREE"]);
  if(main.gitKeys.length!==Object.keys(expected).length||main.gitKeys.some(key=>!Object.hasOwn(expected,key)))throw new Blocked("Unknown Main Git environment key rejected");
  const inherited=main.values;
  for(const key of [...REQUIRED,...Object.keys(expected),"QA_SAFE_GIT_ROOT","QA_SAFE_GIT_WORKTREE"])if(inherited[key]!==process.env[key])throw new Blocked("SafeGit Main environment differs from worker");
  const clean=sanitizeZCodeRuntimeEnv(Object.fromEntries(Object.entries(inherited).filter((entry):entry is [string,string]=>typeof entry[1]==="string")));
  for(const [key,value]of Object.entries(expected))if(clean[key]!==value)throw new Blocked("Host sanitization does not preserve SafeGit");
  const host=await readFile(join(ROOT,"packages/desktop/src/main/desktopHostProcess.ts"),"utf8"),runtime=await readFile(join(ROOT,"packages/desktop/src/main/desktopRuntimeEnv.ts"),"utf8"),gitEnv=await readFile(join(ROOT,"packages/services/src/git/config.ts"),"utf8");
  if(!host.includes("...buildHostProcessEnv(dependencies.hostProcessLocalEnv)")||!runtime.includes("...sanitizeZCodeRuntimeEnv(rawInheritedEnv)")||!runtime.includes("...inheritedEnv")||!gitEnv.includes("...process.env"))throw new Blocked("Current Host/Git inheritance source contract changed");
  const check="$ErrorActionPreference='Stop';$cursor=$env:FLG_GIT_EXE;while($cursor){if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Git executable reparse ancestor'};$cursor=[IO.Path]::GetDirectoryName($cursor)}";
  execFileSync(PWSH,["-NoProfile","-NonInteractive","-Command",check],{env:{...process.env,FLG_GIT_EXE:GIT},stdio:"pipe",windowsHide:true,timeout:30_000});
  await capture("FLG06-safe-git",{status:"preflight",expected,mainInherited:true,hostSourceSha:createHash("sha256").update(host).digest("hex"),runtimeSourceSha:createHash("sha256").update(runtime).digest("hex"),gitEnvSourceSha:createHash("sha256").update(gitEnv).digest("hex"),hostEnvironmentProof:"actual Main equality + current Host sanitizer/source propagation; public Git command checked next"});return root;
}
function git(repo:string,args:string[]){return execFileSync(GIT,args,{cwd:repo,env:process.env,windowsHide:true,encoding:"utf8",timeout:30_000});}
async function review(){await close();if(!await visibleControl('[data-side-pane-add-tab-trigger],[data-side-pane-add-trigger]'))await click('[data-testid="side-pane-toggle"]');await click('[data-side-pane-add-tab-trigger],[data-side-pane-add-trigger]');await click('[data-side-pane-open-tab-item="review"]');await $('[data-testid="git-pane"]').waitForDisplayed({timeout:30_000});}
async function diffText(){return browser.execute(`const pane=document.querySelector('[data-testid="git-pane"]');const roots=pane?[pane]:[],texts=[];while(roots.length){const root=roots.shift();for(const code of root.querySelectorAll('[data-code]'))texts.push(code.textContent||'');for(const host of root.querySelectorAll('*'))if(host.shadowRoot)roots.push(host.shadowRoot);}return texts;`) as Promise<string[]>;}

describe("FLG 最后本地设置与菜单缺口（外置pending）",()=>{
  before(async function(){this.timeout(180_000);try{await paths();await prepareV4ConversationE2E({skipProvider:true});await setCurrentElectronRendererContentSize(1440,1000);locale=(await readSettings()).localePreference||"system";await presentation("en-US");await adapters();await installLocalQaRpcProbe();requests=await countUpstreamRequests({});}catch(error){if(evidence)await capture("beforeAll-failure",{status:"setup-failed",reason:error instanceof Error?error.message:String(error)});throw error;}});
  afterEach(async()=>{await close();await browser.releaseActions();});
  after(async function(){this.timeout(60_000);if(locale)await presentation(locale);await browser.execute(()=>{window.__qaGapClipboard?.restore();window.__remoteProjectHandoffRpc?.restore();});await browser.electron.restoreAllMocks();});
  it("FLG01: 交互Queue和Guide设置持久化重开并恢复",async function(){await run(this,"FLG01",async()=>{
    const original=(await readSettings()).zcodeInteractionBehavior||"queue";try{await settings();await behavior(original==="queue"?"guide":"queue");await capture("FLG01-changed",{status:"persisted",value:(await readSettings()).zcodeInteractionBehavior});await settings();await behavior(original==="queue"?"guide":"queue");}finally{await settings();await behavior(original);}
  });});
  it("FLG02: 六项回答消息和工具分组开关保存重开与恢复",async function(){await run(this,"FLG02",async()=>{
    const controls:Array<{key:BooleanField;selector:string;fallback:boolean}>=[{key:"askUserQuestionAutoResolutionEnabled",selector:'[data-testid="settings-ask-user-question-auto-resolution-switch"]',fallback:true},{key:"messageStreamShowReasoning",selector:'[role="switch"][aria-label="Show reasoning"]',fallback:true},{key:"messageStreamShowTodos",selector:'[role="switch"][aria-label="Show todos"]',fallback:false},{key:"toolGroupingExploreEnabled",selector:'[role="switch"][aria-label="Group exploration tools"]',fallback:true},{key:"toolGroupingTerminalEnabled",selector:'[role="switch"][aria-label="Group terminal commands"]',fallback:true},{key:"toolGroupingChangesEnabled",selector:'[role="switch"][aria-label="Group file changes"]',fallback:false}];
    const original:Preferences=await readSettings();for(const control of controls){const value=original[control.key]??control.fallback;try{await settings();await toggle(control.selector,control.key,!value);await settings();expect(await $(control.selector).getAttribute("aria-checked")).toBe(String(!value));await capture("FLG02-"+control.key,{status:"persisted-reopened",value:!value});}finally{await settings();await toggle(control.selector,control.key,value);}}
  });});
  it("FLG03: 数据目录浏览取消及本树选择草稿取消无迁移",async function(){await run(this,"FLG03",async()=>{
    await settings();const before=(await readSettings()).dataBaseDir,input='[data-testid="settings-data-base-dir-input"]',save='[data-testid="settings-data-base-dir-save"]';const effective=await $(input).getValue();await safe(effective);expect(await $(save).isEnabled()).toBe(false);const target=await safe(join(fixtures,"data-directory-draft"));await mkdir(target);
    const picker=await browser.electron.mock("dialog","showOpenDialog");try{await picker.mockResolvedValueOnce({canceled:true,filePaths:[]});await click('[data-testid="settings-data-base-dir-browse"]');await browser.waitUntil(async()=>{await picker.update();return picker.mock.calls.length===1&&(await $(input).getValue())===effective;},{timeout:15_000});expect(await $(save).isEnabled()).toBe(false);expect((await readSettings()).dataBaseDir).toBe(before);await capture("FLG03-cancel",{status:"passed",canceled:true});
      await picker.mockResolvedValueOnce({canceled:false,filePaths:[target]});await click('[data-testid="settings-data-base-dir-browse"]');await browser.waitUntil(async()=>(await $(input).getValue())===target&&(await $(save).isEnabled()),{timeout:15_000});expect((await readSettings()).dataBaseDir).toBe(before);await capture("FLG03-draft",{status:"draft-only",target});await settings();expect(await $(input).getValue()).toBe(effective);expect(await $(save).isEnabled()).toBe(false);expect((await readSettings()).dataBaseDir).toBe(before);expect(await readdir(target)).toHaveLength(0);
    }finally{await picker.mockRestore();}
  });});
  it("FLG04: 合成已有AstrBot管理名称Escape及路径复制不连接",async function(){await run(this,"FLG04",async()=>{
    await close();const config=await callHandoffHost<{bots:BotConfig[]}>(ServiceChannels.Bots,"getConfig",[]);if(config.bots.length!==1||config.bots[0]!.provider!=="astrbot"||config.bots[0]!.providerUserId||config.bots[0]!.credentialRef||config.bots[0]!.webhookSecretRef||config.bots[0]!.webhookUrl||config.bots[0]!.feishuAppId)throw new Blocked("Existing isolated unbound AstrBot configuration not proven");
    const bot=config.bots[0]!,configPath=await safe(join(home,".zcodium/v2/bot-config.v3.json")),hash=await fingerprint(configPath),mocks=await nativeSafeMocks();
    // 当前名称合同会 trim 并用英文 New bot 回退，QA 不猜旧名称文案。
    const namePattern=new RegExp(`^${(bot.name.trim()||"New bot").replace(/[.*+?^${}()|[\]\\]/gu,"\\$&")}$`,"u");
    try{await click('button[aria-label="Mobile remote control"],button[aria-label="移动端远程控制"]');await click('[role="dialog"] button',/^Manage bots$/u);await browser.waitUntil(async()=>Boolean(await visibleControl('[role="dialog"] section button',namePattern)),{timeout:20_000});await click('[role="dialog"] section button',namePattern);const editor='[role="dialog"] section input',draft="FLG_ASTROBOT_NAME_CANCEL_中文";
      // 名称 input 的 blur 是提交入口；clear 协议会卸载它，改用真实聚焦键盘替换后 Escape。
      await click(editor);await browser.waitUntil(()=>browser.execute(query=>{const inputs=document.querySelectorAll(query);return inputs.length===1&&document.activeElement===inputs[0];},editor),{timeout:15_000});
      await browser.action("key").down(Key.Ctrl).down("a").up("a").up(Key.Ctrl).perform();await browser.keys(draft);
      await browser.waitUntil(()=>browser.execute((query,value)=>{const inputs=document.querySelectorAll<HTMLInputElement>(query);return inputs.length===1&&document.activeElement===inputs[0]&&inputs[0]!.value===value;},editor,draft),{timeout:15_000});
      expect(await callHandoffHost(ServiceChannels.Bots,"getConfig",[])).toEqual(config);expect(await fingerprint(configPath)).toBe(hash);await capture("FLG04-name-draft",{status:"draft-only",id:bot.id,configSha256:hash,saveTriggered:false});
      await browser.keys("Escape");await browser.waitUntil(()=>browser.execute(query=>document.querySelectorAll(query).length===0,editor),{timeout:15_000});expect(await callHandoffHost(ServiceChannels.Bots,"getConfig",[])).toEqual(config);expect(await fingerprint(configPath)).toBe(hash);
      const before=await browser.execute(()=>window.__qaGapClipboard!.clips.length);await click('[role="dialog"] section button',/^Copy config path$/u);expect((await copied(before)).text).toBe(".zcodium/v2/bots-bridge.runtime.v2.json");await capture("FLG04-astrbot-cancel-copy",{status:"passed",id:bot.id,configSha256:hash,connectedAction:false});await browser.keys("Escape");await mocks.external.update();expect(mocks.external.mock.calls).toHaveLength(0);
    }finally{await mocks.external.mockRestore();await mocks.openPath.mockRestore();await mocks.reveal.mockRestore();}
  });});
  it("FLG05: 本run合成记忆catalog切scope搜索清空与刷新",async function(){await run(this,"FLG05",async()=>{
    const prefs=await readSettings();if(prefs.dataBaseDir&&resolve(prefs.dataBaseDir)!==home)throw new Blocked("Memory dataBaseDir is not owned HOME");const root=await safe(join(home,".zcodium/cli/memories/projects"));await audit(root);await mkdir(root,{recursive:true});
    const ids=[`flg-a-${suffix}-0000000000000001`,`flg-b-${suffix}-0000000000000002`];for(const id of ids){const dir=await safe(join(root,id,"memory"));await mkdir(dir,{recursive:true});await writeFile(await safe(join(dir,"MEMORY.md")),`# ${id}\nFLG_MEMORY_INDEX_中文\n`,{flag:"wx"});await writeFile(await safe(join(dir,"owned.md")),"FLG_MEMORY_OWNED_中文\n",{flag:"wx"});}
    type Catalog=Array<{id:string;files:Array<{name:string;path:string}>}>;const catalog=await callHandoffHost<Catalog>(ServiceChannels.Memory,"listProjectMemories",[]);for(const id of ids){const row=catalog.find(item=>item.id===id);expect(row?.files.map(file=>file.name).sort()).toEqual(["MEMORY.md","owned.md"]);for(const file of row!.files){await safe(file.path);expect(file.path).toBe(join(root,id,"memory",file.name));}expect((await callHandoffHost<{content:string}>(ServiceChannels.Memory,"readProjectMemoryFile",[{workspaceId:id,fileName:"owned.md"}])).content).toBe("FLG_MEMORY_OWNED_中文\n");}
    // Memory viewer 使用 workspaceOptions 的平铺菜单，没有设备 projects 子菜单。
    const enabled=prefs.memoryEnabled===true;try{await settings("memory");await toggle('[data-testid="settings-memory-switch"]',"memoryEnabled",true);await $('[data-testid="settings-memory-scope-trigger"]').waitForDisplayed({timeout:20_000});for(const id of ids){await click('[data-testid="settings-memory-scope-trigger"]');await click(`[role="menuitemradio"][data-testid="settings-memory-workspace-${id}"][data-plugin-scope-key="${id}"]`);await browser.waitUntil(async()=>(await $('[data-testid="settings-memory-scope-trigger"]').getAttribute("data-plugin-scope-key"))===id,{timeout:15_000});expect(await $$('[data-testid^="settings-memory-file-"] [data-testid^="settings-memory-file-name"]')).toHaveLength(2);await capture("FLG05-scope",{status:"passed",workspaceId:id});}
      const added=await safe(join(root,ids[1]!,"memory","refresh.md"));await writeFile(added,"FLG_MEMORY_REFRESH_中文\n",{flag:"wx"});await click('[data-testid="settings-memory-refresh"]');await $('[data-testid="settings-memory-file-refresh.md"]').waitForDisplayed({timeout:20_000});expect(await $('[data-testid="settings-memory-count"]').getText()).toMatch(/3/u);await $('[data-testid="settings-memory-search-input"]').setValue("refresh");expect(await $('[data-testid="settings-memory-file-refresh.md"]').isDisplayed()).toBe(true);expect(await $('[data-testid="settings-memory-file-owned.md"]').isExisting()).toBe(false);await click('[data-testid="settings-memory-search-clear"]');await $('[data-testid="settings-memory-file-owned.md"]').waitForDisplayed({timeout:15_000});await capture("FLG05-refresh-search",{status:"passed",newFileSha256:await fingerprint(added)});
    }finally{await settings("memory");await toggle('[data-testid="settings-memory-switch"]',"memoryEnabled",enabled);}
  });});
  it("FLG06: 无commit合成Git index未暂存diff与四个文件菜单",async function(){await run(this,"FLG06",async()=>{
    const isolation=await gitGate(),repo=await safe(join(fixtures,"FLG_INDEX_REPO"));await mkdir(repo);git(repo,["init","--template",join(isolation,"templates")]);git(repo,["config","core.hooksPath",join(isolation,"hooks")]);git(repo,["config","core.attributesFile",join(isolation,"attributes")]);git(repo,["config","commit.gpgsign","false"]);
    const name="FLG_DIFF_中文.txt",file=await safe(join(repo,name)),before="FLG_INDEX_BEFORE_中文\n",after="FLG_WORKTREE_AFTER_中文\n";await writeFile(file,before,{flag:"wx"});git(repo,["add","--",name]);await writeFile(file,after);await audit(repo);
    expect(git(repo,["status","--porcelain"])).toContain("AM ");const diff=await callHandoffHost<GitDiffResult>(ServiceChannels.Git,"getDiff",[{workspacePath:repo,path:file,sourceId:"unstaged"}]);expect(diff.availability).toBe("patch");expect(diff.beforeContent).toBe(before);expect(diff.afterContent).toBe(after);const changes=await callHandoffHost<GitFileChange[]>(ServiceChannels.Git,"getChanges",[{workspacePath:repo,sourceId:"unstaged"}]);expect(changes.some(change=>change.path===file||change.workspaceRelativePath===name)).toBe(true);
    const mocks=await nativeSafeMocks();try{await close();await $('[data-testid="project-section"]').moveTo();await click('[data-testid="virtual-project-add"]');await $('[data-testid="virtual-project-name"]').setValue("FLG_INDEX_REPO");await selectNativeProjectDirectories([repo]);await click('[data-testid="virtual-project-save"]');await startDraftFromProject(repo);await browser.waitUntil(async()=>await browser.execute(expected=>window.__zcodeTabStoreE2E?.getState().activeWorkspacePath===expected,repo),{timeout:20_000});await review();await click('[data-testid="git-pane"] button[role="combobox"]');await click('[role="option"]',/^(Unstaged|未暂存)$/u);
      const cardSelector='[data-testid="git-pane"] button[aria-expanded]';await browser.waitUntil(async()=>Boolean(await visibleControl(cardSelector,new RegExp(name,"u"))),{timeout:30_000});await click(cardSelector,new RegExp(name,"u"));await browser.waitUntil(async()=>(await diffText()).some(text=>text.includes("FLG_WORKTREE_AFTER_中文")),{timeout:30_000});await capture("FLG06-expanded-diff",{status:"passed",repo,diff:{availability:diff.availability,beforeSha256:createHash("sha256").update(before).digest("hex"),afterSha256:createHash("sha256").update(after).digest("hex")},commitCreated:false});
      for(const entry of [{label:/^Copy absolute path$/u,text:file},{label:/^Copy relative path$/u,text:name}]){const count=await browser.execute(()=>window.__qaGapClipboard!.clips.length);const card=await visibleControl(cardSelector,new RegExp(name,"u"));await card!.click({button:"right"});await click('[role="menuitem"]',entry.label);expect((await copied(count)).text).toBe(entry.text);await capture("FLG06-copy",{status:"passed",absolute:entry.text===file});}
      await (await visibleControl(cardSelector,new RegExp(name,"u")))!.click({button:"right"});await click('[role="menuitem"]',/^Open in file manager$/u);await browser.waitUntil(async()=>{await mocks.openPath.update();return mocks.openPath.mock.calls.length===1;},{timeout:15_000});expect(mocks.openPath.mock.calls[0]?.[0]).toBe(repo);
      await (await visibleControl(cardSelector,new RegExp(name,"u")))!.click({button:"right"});await click('[role="menuitem"]',/^Reveal in file tree$/u);await browser.waitUntil(()=>browser.execute(path=>[...document.querySelectorAll('[data-testid="workspace-file-tree-panel"] [title]')].some(el=>el.getAttribute("title")===path),file),{timeout:20_000});await capture("FLG06-reveal",{status:"passed",nativeOpened:false,file});
    }finally{await mocks.external.mockRestore();await mocks.openPath.mockRestore();await mocks.reveal.mockRestore();}
  });});
  it("FLG07: 项目管理51个合成项目分页筛选排序与选择恢复",async function(){await run(this,"FLG07",async()=>{
    const prefix=`FLG_PAGE_${suffix}_`,owned:VirtualProject[]=[];for(let i=1;i<=51;i++){const project=await callHandoffHost<VirtualProject>(ServiceChannels.Project,"saveProject",[{hostId:"local",name:prefix+String(i).padStart(2,"0"),roots:[]}]);expect(project.hostId).toBe("local");expect(project.id.length).toBeGreaterThan(0);expect(project.roots).toHaveLength(0);owned.push(project);}
    const all=await callHandoffHost<VirtualProject[]>(ServiceChannels.Project,"readProjects",[{hostId:"local"}]);expect(all.filter(project=>owned.some(item=>item.id===project.id)).map(project=>project.id).sort()).toEqual(owned.map(project=>project.id).sort());await capture("FLG07-owned-fixture",{status:"preflight",hostId:"local",ownedIds:owned.map(project=>project.id),rootCount:0,projectsCreated:51});
    await settings("projects");await $('[data-testid="project-management"]').waitForDisplayed({timeout:30_000});const search='[data-testid="project-management-search"]';await $(search).setValue(prefix);const rows='[data-testid="project-management-row"]';await browser.waitUntil(async()=>await $$(rows).length===50,{timeout:20_000});expect(await $('[data-testid="project-management-show-more"]').isDisplayed()).toBe(true);await click('[data-testid="project-management-show-more"]');await browser.waitUntil(async()=>await $$(rows).length===51,{timeout:20_000});expect(await $('[data-testid="project-management-show-more"]').isExisting()).toBe(false);
    const first=`[data-testid="project-management-row"][data-project-id="${owned[0]!.id}"] [data-testid="project-management-row-checkbox"]`;await click(first);await $('[data-testid="project-management-selection-bar"]').waitForDisplayed({timeout:10_000});for(const sort of ["name","sessions","lastActive"]){await click('[data-testid="project-management-sort"]');await click(`[data-testid="project-management-sort-${sort}"]`);expect(await $(first).getAttribute("aria-checked")).toBe("true");const order=await browser.execute(()=>[...document.querySelectorAll('[data-testid="project-management-row"]')].map(row=>row.getAttribute("data-project-id")));expect(order).toEqual(owned.map(project=>project.id));await capture("FLG07-sort",{status:"passed",sort,selectionPreserved:true,rowCount:await $$(rows).length,order,tieScenario:"all owned projects have zero tasks; name is documented tie break"});}
    await click('[data-testid="project-management-select-all"]');expect(await $('[data-testid="project-management-select-all"]').getAttribute("aria-checked")).toBe("true");await $(search).setValue(prefix+"01");await browser.waitUntil(async()=>await $$(rows).length===1,{timeout:15_000});expect(await $('[data-testid="project-management-selection-bar"]').isExisting()).toBe(false);await $(search).setValue(prefix);await browser.waitUntil(async()=>await $$(rows).length===50,{timeout:15_000});await click('[data-testid="project-management-filter"]');await click('[data-testid="project-management-filter-unused"]');await $('[data-testid="project-management-empty"]').waitForDisplayed({timeout:15_000});await capture("FLG07-unused-grace",{status:"passed",freshCreatedProjectsUnused:false});await click('[data-testid="project-management-filter"]');await click('[data-testid="project-management-filter-all"]');await $(search).setValue("");await click('[data-testid="project-management-sort"]');await click('[data-testid="project-management-sort-lastActive"]');expect(await $('[data-testid="project-management-selection-bar"]').isExisting()).toBe(false);await capture("FLG07-restored",{status:"passed",paginationPerformed:true,deleted:0});
  });});
});
