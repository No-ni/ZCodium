import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Key } from "webdriverio";
import { DEFAULT_WORKSPACE, setCurrentElectronRendererContentSize } from "../../../../../packages/desktop/test/e2e/helpers/desktop-app.js";
import { getV4PaneSnapshot, prepareV4ConversationE2E, sendV4PromptAndWaitAccepted, waitForV4AssistantMessageContaining } from "../../../../../packages/desktop/test/e2e/helpers/v4-conversation.js";
import { getUpstreamRequestEvidence, getUpstreamRequestRecordCount } from "../../../../../packages/desktop/test/e2e/helpers/conversation-session-network.js";
import { startElectronWindowRecording, type ElectronWindowRecordingSession } from "../../../../../packages/desktop/test/e2e/helpers/electron-window-recorder.js";
import { clickVisibleControl, closeVisibleMenus } from "../../qa-menu-dom.js";

// 外置QA只取原canonical的会话链；不调用其Git/清理函数，不写产品或旧夹具。
const ROOT = resolve(fileURLToPath(new URL("../../../../../", import.meta.url)));
const FIXTURE = join(ROOT,"packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-chat-find-refocus.json");
const COMMON = join(ROOT,"packages/desktop/test/e2e/fixtures/upstream/common.json");
const TITLE_FIXTURE = join(ROOT,"docs/testing/qa-2026-11-06/fixtures/qa-runtime-copy-find-title.json");
const TITLE_FIXTURE_ID = "qa-runtime-copy-find-setup-title";
const TITLE_INSTRUCTION = "Generate a concise title for this coding session.";
const TITLE_TASK_INSTRUCTION = "This is a title-generation task, not a conversation.";
const SETUP = "E2E_CHAT_FIND_REFOCUS_SETUP";
const PROMPT = "E2E_CHAT_FIND_REFOCUS_SETUP 请返回查找回归长正文。";
const MARKER = "E2E_CHAT_FIND_REFOCUS_NEEDLE";
const FIND = 'input[placeholder="Search messages..."],input[placeholder="搜索消息..."]';
const PANE = '[data-testid="v4-session-pane-workspace-main"]';
let artifacts:string;
let evidence:string;
let expectedBody:string;
let fixtureSha:string;
let taskId:string;
let readyRecordCount=0;
let sequence=0;
let initialRequestIndex=-1;
interface RfcClipboard { texts:string[]; clips:Array<{method:"write"|"writeText";text:string}>; attempts:Array<"write"|"writeText">; rejectClipboard:boolean; restore():void }
declare global { interface Window { __qaRuntimeClipboard?:RfcClipboard } }

async function safe(candidate:string) {
  if(!isAbsolute(candidate))throw new Error("RFC requires absolute path");
  const path=resolve(candidate);const rel=relative(ROOT,path);
  if(!rel||isAbsolute(rel)||rel===".."||rel.startsWith(`..${sep}`))throw new Error("RFC path escapes worktree");
  for(let cursor=path;;cursor=dirname(cursor)) {
    try {if((await lstat(cursor)).isSymbolicLink()||(await realpath(cursor)).toLowerCase()!==cursor.toLowerCase())throw new Error("RFC link/redirect ancestor rejected");}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    if(cursor===dirname(cursor))break;
  }
  return path;
}
async function audit(candidate:string) {
  const target=await safe(candidate);const guard=await safe(join(ROOT,"docs/testing/qa-2026-11-06/qa-reparse-children.ps1"));
  const script=readFileSync(guard,"utf8")+"\n$ErrorActionPreference='Stop';$target=$env:RFC_AUDIT_TARGET;$cursor=[IO.Path]::GetFullPath($target);while($cursor){if(Test-Path -LiteralPath $cursor){if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'RFC reparse ancestor'}};$cursor=[IO.Path]::GetDirectoryName($cursor)};if(Test-Path -LiteralPath $target -PathType Container){$queue=[Collections.Generic.Queue[string]]::new();$queue.Enqueue($target);while($queue.Count){foreach($item in Get-QaAuditChildren $queue.Dequeue()){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'RFC reparse descendant'};if($item.PSIsContainer){$queue.Enqueue($item.FullName)}}}}";
  execFileSync("C:\\Program Files\\PowerShell\\7\\pwsh.exe",["-NoProfile","-NonInteractive","-Command",script],{env:{...process.env,RFC_AUDIT_TARGET:target,QA_REPARSE_WORKTREE:ROOT},windowsHide:true,stdio:"pipe",timeout:30_000});
}
async function preparePaths() {
  if(process.platform!=="win32"||process.env.E2E_PROVIDER_HTTP_MODE!=="replay"||process.env.E2E_PROVIDER_CAPTURE_MODE==="capture"||process.env.ZCODE_E2E_MANUAL_REVIEW!=="1")throw new Error("RFC requires isolated Windows finite replay");
  if(process.env.E2E_PROVIDER_API_KEY&&process.env.E2E_PROVIDER_API_KEY!=="e2e-fixture-key")throw new Error("RFC refuses nonfixture provider key");
  for(const name of ["HOME","USERPROFILE","TEMP","TMP","TMPDIR","APPDATA","LOCALAPPDATA","COREPACK_HOME","PNPM_HOME","npm_config_cache","npm_config_store_dir","npm_config_userconfig","TSX_CACHE_DIR","NODE_COMPILE_CACHE","XDG_CACHE_HOME","XDG_CONFIG_HOME","XDG_DATA_HOME","ZCODE_E2E_HOME_DIR","ZCODE_E2E_ARTIFACT_DIR","ZCODE_E2E_NETWORK_CAPTURE_DIR","E2E_PROVIDER_CAPTURE_PATH"])await safe(process.env[name]||"");
  const home=await safe(process.env.ZCODE_E2E_HOME_DIR!);artifacts=await safe(process.env.ZCODE_E2E_ARTIFACT_DIR!);
  if(resolve(DEFAULT_WORKSPACE)!==join(home,"ZCodeProject"))throw new Error("RFC fixed workspace differs from run home");
  await audit(home);await audit(artifacts);await audit(process.env.ZCODE_E2E_NETWORK_CAPTURE_DIR!);
  const worker=(process.env.WDIO_WORKER_ID||String(process.pid)).replace(/[^a-zA-Z0-9_-]/gu,"_");
  const names=(await readdir(artifacts)).filter(name=>name.startsWith(`qa-project-bootstrap-${worker}-`)&&name.endsWith("-after.json"));
  const snapshots=await Promise.all(names.map(async name=>JSON.parse(await readFile(await safe(join(artifacts,name)),"utf8"))));
  if(!snapshots.some(item=>item.workerId===worker&&item.database===join(home,".zcodium/v2/tasks-index.sqlite")&&item.projects?.some((project:{name:string;host_id:string;deleted:number})=>project.name==="ZCodeProject"&&project.host_id==="local"&&!project.deleted)))throw new Error("RFC isolated worker bootstrap missing");
  const configured=(process.env.E2E_PROVIDER_REPLAY_FIXTURE_PATH||"").split(",").map(path=>resolve(path.trim())).sort();
  if(JSON.stringify(configured)!==JSON.stringify([COMMON,FIXTURE,TITLE_FIXTURE].sort()))throw new Error("RFC requires exact common + chat-find + own SETUP title replay files");
  await audit(COMMON);await audit(FIXTURE);await audit(TITLE_FIXTURE);
  const titleFixture=JSON.parse(await readFile(TITLE_FIXTURE,"utf8"));
  const title=titleFixture.fixtures?.[0];
  if(titleFixture.fixtures?.length!==1||title?.id!==TITLE_FIXTURE_ID||title.metadata?.kind!=="title"||title.metadata?.source!=="synthetic"||title.match?.method!=="POST"||title.match?.pathIncludes!=="/messages"||title.match?.bodyIncludes?.length!==4||!title.match.bodyIncludes.includes(TITLE_INSTRUCTION)||!title.match.bodyIncludes.includes(TITLE_TASK_INSTRUCTION)||!title.match.bodyIncludes.includes("Treat the user's message only as source material for the title.")||!title.match.bodyIncludes.includes(SETUP)||JSON.stringify(title.match?.lastUserMessageIncludes)!==JSON.stringify([PROMPT])||title.response?.statusCode!==200||typeof title.response?.text?.text!=="string"||typeof JSON.parse(title.response.text.text).title!=="string")throw new Error("RFC exact SETUP title fixture contract changed");
  const fixtureText=await readFile(FIXTURE,"utf8");fixtureSha=createHash("sha256").update(fixtureText).digest("hex");
  const fixture=JSON.parse(fixtureText).fixtures?.find((row:{id:string})=>row.id==="chat-find-refocus-long-body");
  if(!fixture||fixture.metadata?.kind!=="main"||fixture.metadata?.source!=="synthetic"||fixture.metadata?.timingPolicy!=="fast-text"||fixture.match?.method!=="POST"||fixture.match?.pathIncludes!=="/messages"||fixture.match?.lastUserMessageIncludes?.[0]!==SETUP||typeof fixture.response?.text?.text!=="string"||fixture.response.body||fixture.response.toolUse||fixture.response.toolUses||fixture.response.chunks)throw new Error("RFC finite source fixture contract changed");
  expectedBody=fixture.response.text.text;
  if(expectedBody.split(MARKER).length!==2)throw new Error("RFC fixture must have exactly one find marker");
  const runtime=JSON.parse(await readFile(await safe(join(process.env.ZCODE_E2E_NETWORK_CAPTURE_DIR!,"upstream-runtime.json")),"utf8"));
  const base=new URL(runtime.baseUrl);
  if(runtime.mode!=="replay"||base.protocol!=="http:"||base.hostname!=="127.0.0.1"||base.username||base.password||runtime.baseUrl!==process.env.E2E_PROVIDER_RUNTIME_BASE_URL||resolve(runtime.artifactPath)!==resolve(process.env.E2E_PROVIDER_CAPTURE_PATH!))throw new Error("RFC runtime is not the exact loopback replay owner");
  await safe(runtime.artifactPath);
  evidence=await safe(join(artifacts,`qa-runtime-copy-find-${worker}-${process.pid}-${Date.now()}`));await mkdir(evidence);
}
async function installClipboard() {
  await browser.execute(`
    const clipboard=navigator.clipboard;if(!clipboard)throw new Error("RFC clipboard unavailable");
    const original=Object.getOwnPropertyDescriptor(clipboard,"writeText"), originalWrite=Object.getOwnPropertyDescriptor(clipboard,"write");
    const state={texts:[],clips:[],attempts:[],rejectClipboard:false,restore(){if(original)Object.defineProperty(clipboard,"writeText",original);else delete clipboard.writeText;if(originalWrite)Object.defineProperty(clipboard,"write",originalWrite);else delete clipboard.write;delete window.__qaRuntimeClipboard;}};
    Object.defineProperty(clipboard,"writeText",{configurable:true,value:async text=>{state.attempts.push("writeText");if(state.rejectClipboard)throw new Error("RFC synthetic clipboard rejection");const plain=await text;state.texts.push(plain);state.clips.push({method:"writeText",text:plain});}});
    Object.defineProperty(clipboard,"write",{configurable:true,value:async items=>{state.attempts.push("write");if(state.rejectClipboard)throw new Error("RFC synthetic clipboard rejection");if(items.length!==1||items[0].types.length!==1||items[0].types[0]!=="text/plain")throw new Error("RFC accepts one synthetic plain text ClipboardItem only");const plain=await(await items[0].getType("text/plain")).text();state.texts.push(plain);state.clips.push({method:"write",text:plain});}});window.__qaRuntimeClipboard=state;
  `);
}
async function requestSummary() {
  return (await getUpstreamRequestEvidence({includeTitle:true},{afterIndex:initialRequestIndex})).map(record=>({fixtureId:record.fixtureId,status:record.status,statusCode:record.statusCode,bodyBytes:record.responseBodyBytes,path:record.path,loopback:record.requestHost?.startsWith("127.0.0.1:")===true,...classifyRfcRequest(record.requestJson)}));
}
export function classifyRfcRequest(value: unknown) {
  const body=value&&typeof value==="object"?value as {messages?:unknown;system?:unknown;tools?:unknown}:null;
  const messages=Array.isArray(body?.messages)?body.messages:[];
  const texts=(part:unknown):string=>typeof part==="string"?part:Array.isArray(part)?part.map(item=>item&&typeof item==="object"&&typeof (item as {text?:unknown}).text==="string"?String((item as {text:string}).text):"").join("\n"):"";
  const roles=messages.map(item=>item&&typeof item==="object"?String((item as {role?:unknown}).role??"unknown"):"unknown").map(role=>["system","user","assistant","tool"].includes(role)?role:"unknown");
  const system=[texts(body?.system),...messages.filter(item=>item&&typeof item==="object"&&(item as {role?:unknown}).role==="system").map(item=>texts((item as {content?:unknown}).content))].join("\n");
  const latest=messages.slice().reverse().find(item=>item&&typeof item==="object"&&(item as {role?:unknown}).role==="user") as {content?:unknown}|undefined;
  const user=texts(latest?.content);
  const titleInstruction=system.includes(TITLE_INSTRUCTION)&&system.includes(TITLE_TASK_INSTRUCTION);
  const setup=user.includes(SETUP),exactPrompt=user===PROMPT;
  return {queryKind:titleInstruction&&exactPrompt?"title":!titleInstruction&&setup?"main":"unknown",markers:{titleInstruction,setup,exactPrompt},shape:{object:Boolean(body),messageCount:messages.length,roles,systemType:Array.isArray(body?.system)?"array":typeof body?.system,toolCount:Array.isArray(body?.tools)?body.tools.length:0}};
}
async function capture(name:string,details:Record<string,unknown>) {
  const stem=await safe(join(evidence,`${String(++sequence).padStart(3,"0")}-${name}`));
  const state=await browser.execute(()=>({dpr:devicePixelRatio,activePane:document.querySelector('[data-testid="v4-session-pane-workspace-main"]')?.getAttribute("data-session-id"),activeTag:document.activeElement?.tagName,findQuery:document.querySelector<HTMLInputElement>('input[placeholder="Search messages..."],input[placeholder="搜索消息..."]')?.value??null,headings:[...document.querySelectorAll("h1,h2,h3")].filter(element=>element.checkVisibility()).map(element=>element.textContent),toast:document.querySelector<HTMLElement>("#zcode-toast-host")?.innerText??null,copiedLengths:window.__qaRuntimeClipboard?.texts.map(text=>text.length)??[],clipboardMethods:window.__qaRuntimeClipboard?.clips.map(clip=>clip.method)??[],clipboardAttempts:window.__qaRuntimeClipboard?.attempts??[]}));
  const reservation=await open(stem+".png","wx");await reservation.close();await browser.saveScreenshot(stem+".png");
  await writeFile(stem+".json",JSON.stringify({capturedAt:new Date().toISOString(),evidenceKind:"finite synthetic loopback runtime UI; no real clipboard/Git/network provider",...details,state,fixtureSource:FIXTURE,fixtureSha256:fixtureSha,expectedBodyLength:expectedBody?.length,expectedBodySha256:expectedBody?createHash("sha256").update(expectedBody).digest("hex"):null,requests:await requestSummary()},null,2)+"\n",{flag:"wx"});
}
async function runCase(context:Mocha.Context,id:string,action:()=>Promise<void>) {
  context.timeout(150_000);const frameDir=await safe(join(evidence,`${id}-frames`));await audit(frameDir);let recording:ElectronWindowRecordingSession|undefined;
  try {await capture(id+"-before",{status:"before"});recording=await startElectronWindowRecording({browser,frameDir,outputPath:join(evidence,`${id}-unencoded.webm`),frameIntervalMs:1000,preRollDurationMs:0,cleanupFrames:false,encodeVideo:async()=>{throw new Error("No standard video encoder; PNG/time sequence retained");}});await action();expect(await getUpstreamRequestRecordCount()).toBe(readyRecordCount);expect((await getV4PaneSnapshot()).sessionId).toBe(taskId);await capture(id,{status:"passed"});await audit(frameDir);await recording.discard();recording=undefined;}
  catch(error){let frames:unknown;try{if(recording){await audit(frameDir);frames=await recording.stop({tailDurationMs:500});}}catch(failure){frames={format:"PNG/time sequence; unencoded WebM",frameDir,error:failure instanceof Error?failure.message:String(failure)};}await capture(id,{status:"failed",error:error instanceof Error?error.message:String(error),frames});throw error;}
}
async function openFind() {
  await clickVisibleControl(`${PANE} [data-testid="v4-composer-input"]`,undefined,"RFC");
  await browser.action("key").down(Key.Control).down("f").up("f").up(Key.Control).perform();await $(FIND).waitForDisplayed({timeout:15_000});
}
async function findSnapshot() {
  return await browser.execute(`
    const viewport=document.querySelector('[data-testid="v4-timeline"]');
    const input=document.querySelector('input[placeholder="Search messages..."],input[placeholder="搜索消息..."]');
    const ranges=CSS.highlights?.get("zcode-v4-conversation-find-active");
    const range=ranges?.[Symbol.iterator]().next().value;
    const rect=range?.getBoundingClientRect(), vp=viewport?.getBoundingClientRect();
    return {counter:input?.parentElement?.textContent?.trim()||"",activeText:range?.toString()||null,scrollTop:viewport?.scrollTop||0,height:vp?.height||0,distance:rect&&vp?Math.abs(rect.top+rect.height/2-vp.top-vp.height/2):null,rangeTop:rect?.top??null,dpr:devicePixelRatio};
  `) as {counter:string;activeText:string|null;scrollTop:number;height:number;distance:number|null;rangeTop:number|null;dpr:number};
}
async function waitCentered() {
  await browser.waitUntil(async()=>{const state=await findSnapshot();return state.counter.includes("1/1")&&state.activeText===MARKER&&state.scrollTop>0&&state.distance!==null&&state.distance<=Math.max(120,state.height*.3);},{timeout:20_000,timeoutMsg:"RFC same runtime find result did not recenter"});
}
async function scrollAway() {
  await browser.execute(()=>{const viewport=document.querySelector<HTMLElement>('[data-testid="v4-timeline"]');if(!viewport)throw new Error("RFC runtime viewport missing");viewport.scrollTop=0;viewport.dispatchEvent(new Event("scroll",{bubbles:true}));});
  await browser.waitUntil(async()=>{const state=await findSnapshot();return state.distance!==null&&state.distance>state.height/2;},{timeout:10_000,timeoutMsg:"RFC marker did not scroll out of viewport"});
}

const MARKDOWN_TOAST_SUCCESS = /Copied as Markdown|已复制为 Markdown/u;
const MARKDOWN_TOAST_FAILURE = /Copy failed\. Check the connection and clipboard permissions, then try again\.|复制失败，请检查连接和剪贴板权限后重试。/u;
async function waitMarkdownToast(pattern: RegExp, gone = false) {
  await browser.waitUntil(() => browser.execute((source, absent) => {
    const text = document.querySelector<HTMLElement>("#zcode-toast-host")?.innerText || "";
    return new RegExp(source, "u").test(text) !== absent;
  }, pattern.source, gone), { timeout: 15_000, timeoutMsg: gone ? "RMC previous toast did not disappear" : "RMC current Markdown result toast not observed" });
}
async function markdownMenu() {
  await closeVisibleMenus("RMC");
  await clickVisibleControl('[data-testid="workspace-more-button"]', undefined, "RMC");
  await browser.waitUntil(() => browser.execute(() => {
    const item = document.querySelector('[data-testid="task-copy-markdown"]');
    return Boolean(item?.checkVisibility()) && item?.getAttribute("aria-disabled") !== "true" && !item?.hasAttribute("disabled");
  }), { timeout: 15_000, timeoutMsg: "RMC Markdown menu remained unavailable or pending" });
}
async function markdownCopy() { await markdownMenu(); await clickVisibleControl('[data-testid="task-copy-markdown"]', undefined, "RMC"); }
async function clipboardCount() { return browser.execute(() => window.__qaRuntimeClipboard!.texts.length); }
async function newMarkdown(before: number) {
  await browser.waitUntil(async () => (await clipboardCount()) === before + 1, { timeout: 20_000, timeoutMsg: "RMC one Markdown text was not captured" });
  const clip = await browser.execute(index => window.__qaRuntimeClipboard!.clips[index]!, before);
  // 中文说明：只验用户正文与既有replay回复保真/单次，不调用或复制产品formatter作为预期。
  expect(clip.text.split(PROMPT).length - 1).toBe(1);
  expect(clip.text.split(expectedBody).length - 1).toBe(1);
  expect(clip.text.split(MARKER).length - 1).toBe(1);
  expect(clip.text).toContain("## User"); expect(clip.text).toContain("## Assistant");
  await waitMarkdownToast(MARKDOWN_TOAST_SUCCESS);
  return clip;
}

describe("RFC finite runtime assistant复制与会话查找（外置pending）",()=>{
  before(async function(){
    this.timeout(180_000);
    try {
      await preparePaths();await prepareV4ConversationE2E();await setCurrentElectronRendererContentSize(1280,900);await installClipboard();
      // 网络 helper 的 afterIndex 是排他下标；空artifact首条记录的下标是0。
      initialRequestIndex=(await getUpstreamRequestRecordCount())-1;
      await sendV4PromptAndWaitAccepted(PROMPT,SETUP,"RFC one finite prompt was not accepted",30_000);
      await waitForV4AssistantMessageContaining(MARKER);
      await browser.waitUntil(async()=>{const pane=await getV4PaneSnapshot();return Boolean(pane.sessionId&&pane.sessionId!=="draft"&&!pane.canStop);},{timeout:90_000});
      taskId=(await getV4PaneSnapshot()).sessionId!;
      await browser.waitUntil(async()=>{const records=await getUpstreamRequestEvidence({lastUserMessageIncludes:[SETUP]},{afterIndex:initialRequestIndex});return records.length===1&&records[0]?.fixtureId==="chat-find-refocus-long-body"&&records[0].status==="complete"&&records[0].statusCode===200;},{timeout:20_000,timeoutMsg:"RFC exact existing finite replay request not completed once"});
      // 标题旁路独立完成后才冻结action请求基线，未知/失败请求完整拒绝。
      await browser.waitUntil(async()=>{const rows=await requestSummary();return rows.length===2&&rows.filter(row=>row.queryKind==="main"&&row.fixtureId==="chat-find-refocus-long-body").length===1&&rows.filter(row=>row.queryKind==="title"&&row.fixtureId===TITLE_FIXTURE_ID).length===1&&rows.every(row=>row.status==="complete"&&row.statusCode===200&&row.loopback&&row.fixtureId);},{timeout:20_000,timeoutMsg:"RFC exact main and SETUP title replay chain did not complete once"});
      const requests=await requestSummary();expect(requests.every(record=>record.status==="complete"&&record.statusCode===200&&record.loopback&&record.fixtureId)).toBe(true);
      readyRecordCount=await getUpstreamRequestRecordCount();
      await capture("runtime-fixture-ready",{status:"fixture",taskId,mainRequests:1,titleRequests:1,titleFixtureSource:TITLE_FIXTURE,titleFixtureSha256:createHash("sha256").update(await readFile(TITLE_FIXTURE)).digest("hex"),provider:"finite loopback replay"});
    } catch(error) {
      if(evidence){try{await capture("beforeAll-failure",{status:"setup-failed",error:error instanceof Error?error.message:String(error)});}catch(evidenceError){throw new AggregateError([error,evidenceError],"RFC setup failed; evidence failed");}}
      throw error;
    }
  });
  afterEach(async()=>{if(await $(FIND).isExisting())await browser.keys("Escape");await closeVisibleMenus("RFC");await browser.releaseActions();});
  after(async()=>{await browser.execute(()=>window.__qaRuntimeClipboard?.restore());});
  it("RFC01: finite runtime assistant正文真实复制并恢复勾选反馈",async function(){await runCase(this,"RFC01",async()=>{
    // 当前正常轮次把复制动作移到同轮尾部；不能要求 marker 正文 row 内仍有旧动作。
    const probe=await browser.execute(`
      const paneSelector=arguments[0],marker=arguments[1];
      const panes=document.querySelectorAll(paneSelector);
      if(panes.length!==1)throw new Error('RFC runtime PANE owner is not unique');
      const pane=panes[0];
      const rows=[...pane.querySelectorAll('[data-row-id]')].filter(element=>element.classList.contains('group/assistant-row')&&element.textContent?.includes(marker));
      if(rows.length!==1)throw new Error('RFC runtime marker assistant row is not unique');
      const section=rows[0].closest('section[data-turn-id]');
      if(!section||section.closest(paneSelector)!==pane)throw new Error('RFC marker turn escapes its PANE');
      const turns=[...section.querySelectorAll('div')].filter(element=>element.classList.contains('group/assistant-turn'));
      if(turns.length!==1||!turns[0].contains(rows[0]))throw new Error('RFC marker assistant-turn owner is not unique');
      const turnId=section.getAttribute('data-turn-id');
      if(!turnId)throw new Error('RFC actual turn identity invalid');
      const assistantIds=[...turns[0].querySelectorAll('[data-row-id]')].filter(element=>element.classList.contains('group/assistant-row')).map(element=>element.getAttribute('data-row-id'));
      const copyCandidates=[...turns[0].querySelectorAll('button[data-testid^="v4-copy-"]')].map(element=>{
        const row=element.closest('[data-row-id]'),rect=element.getBoundingClientRect();
        return {testId:element.getAttribute('data-testid'),nearestRowId:row?.getAttribute('data-row-id')??null,nearestRowKind:row?.classList.contains('group/assistant-row')?'assistant':row?.classList.contains('group/user-row')?'user':row?'other':'turn-footer',visible:element.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&rect.width>0&&rect.height>0,disabled:element.disabled,sameTurn:element.closest('section[data-turn-id]')===section};
      });
      return {turnId,markerRowId:rows[0].getAttribute('data-row-id'),assistantIds,copyCandidates};
    `,PANE,MARKER) as {turnId:string;markerRowId:string|null;assistantIds:Array<string|null>;copyCandidates:Array<{testId:string|null;nearestRowId:string|null;nearestRowKind:string;visible:boolean;disabled:boolean;sameTurn:boolean}>};
    await capture("RFC01-copy-candidates",{status:"probe",...probe,samePane:true});
    // 同轮也有 user copy；本 pure 单助手夹具只按唯一 marker 助手 rowId 选择，不数整轮前缀。
    if(!probe.markerRowId||!/^\d+$/u.test(probe.markerRowId))throw new Error("RFC marker assistant row identity invalid");
    expect(probe.assistantIds).toEqual([probe.markerRowId]);
    const copyTestId=`v4-copy-${probe.markerRowId}`,matching=probe.copyCandidates.filter(candidate=>candidate.testId===copyTestId);
    if(matching.length!==1)throw new Error("RFC exact assistant row copy action is not unique");
    expect(matching[0]!.sameTurn).toBe(true);expect(matching[0]!.disabled).toBe(false);
    const owner={turnId:probe.turnId,rowId:probe.markerRowId,markerRowId:probe.markerRowId,copyTestId};
    const turnSelector=`${PANE} section[data-turn-id=${JSON.stringify(owner.turnId)}]`;
    const selector=`${turnSelector} [data-testid="${owner.copyTestId}"]`;
    await $(`${turnSelector} [class~="group/assistant-turn"]`).moveTo();
    await capture("RFC01-same-turn-owner",{status:"step",...owner,samePane:true,hovered:true});
    const before=await browser.execute(()=>window.__qaRuntimeClipboard!.texts.length);
    await clickVisibleControl(selector,undefined,"RFC");await browser.waitUntil(()=>browser.execute(count=>window.__qaRuntimeClipboard!.texts.length===count+1,before),{timeout:15_000});
    const copied=await browser.execute(index=>window.__qaRuntimeClipboard!.texts[index]!,before);expect(copied).toBe(expectedBody);
    await browser.waitUntil(()=>browser.execute(query=>Boolean(document.querySelector(`${query} svg.lucide-check`)),selector),{timeout:5000});
    await capture("RFC01-copied-check",{status:"step",...owner,copySha256:createHash("sha256").update(copied).digest("hex"),systemClipboard:false});
    await browser.waitUntil(()=>browser.execute(query=>!document.querySelector(`${query} svg.lucide-check`),selector),{timeout:5000});
  });});
  it("RFC02: runtime会话唯一命中滚离后四种导航与重开居中",async function(){await runCase(this,"RFC02",async()=>{
    expect((await getV4PaneSnapshot()).sessionId).toBe(taskId);await openFind();await $(FIND).setValue(MARKER);await waitCentered();await capture("RFC02-initial",{status:"step",find:await findSnapshot()});
    for(const action of ["next","previous","enter","shift-enter"] as const) {
      await scrollAway();await capture(`RFC02-${action}-away`,{status:"step",find:await findSnapshot()});
      if(action==="next"||action==="previous")await clickVisibleControl(action==="next"?'button[aria-label="Next result"],button[aria-label="下一个结果"]':'button[aria-label="Previous result"],button[aria-label="上一个结果"]',undefined,"RFC");
      else {await clickVisibleControl(FIND,undefined,"RFC");if(action==="shift-enter")await browser.action("key").down(Key.Shift).down(Key.Enter).up(Key.Enter).up(Key.Shift).perform();else await browser.keys("Enter");}
      await waitCentered();await capture(`RFC02-${action}-centered`,{status:"step",find:await findSnapshot()});
    }
    await browser.keys("Escape");await $(FIND).waitForExist({reverse:true,timeout:10_000});await openFind();expect(await $(FIND).getValue()).toBe("");await $(FIND).setValue(MARKER);await waitCentered();await capture("RFC02-reopened",{status:"step",queryResetOnClose:true,find:await findSnapshot()});await browser.keys("Escape");
  });});
  it("RMC03: runtime任务Markdown完整复制、受控拒绝与恢复重试", async function () { await runCase(this, "RMC03", async () => {
    let firstMarkdown = "";
    try {
      for (let repeat = 0; repeat < 2; repeat++) {
        await waitMarkdownToast(MARKDOWN_TOAST_SUCCESS, true);
        const before = await clipboardCount(); await markdownCopy(); const clip = await newMarkdown(before);
        if (repeat === 0) firstMarkdown = clip.text; else expect(clip.text).toBe(firstMarkdown);
        await capture(`RMC03-copied-${repeat + 1}`, { status: "step", method: clip.method, textLength: clip.text.length, sha256: createHash("sha256").update(clip.text).digest("hex"), promptOccurrences: 1, assistantOccurrences: 1, systemClipboard: false });
        await markdownMenu(); await closeVisibleMenus("RMC");
      }
      await waitMarkdownToast(MARKDOWN_TOAST_SUCCESS, true);
      const before = await clipboardCount();
      const attempts = await browser.execute(() => { window.__qaRuntimeClipboard!.rejectClipboard = true; return window.__qaRuntimeClipboard!.attempts.length; });
      await markdownCopy();
      await browser.waitUntil(() => browser.execute(count => window.__qaRuntimeClipboard!.attempts.length === count + 1, attempts), { timeout: 15_000 });
      await waitMarkdownToast(MARKDOWN_TOAST_FAILURE); expect(await clipboardCount()).toBe(before);
      await capture("RMC03-rejected", { status: "expected-clipboard-error", successfulWritesAdded: 0, mockedWriteAttemptsAdded: 1, systemClipboard: false });
      await markdownMenu(); await closeVisibleMenus("RMC");
      await browser.execute(() => { window.__qaRuntimeClipboard!.rejectClipboard = false; });
      await markdownCopy(); const recovered = await newMarkdown(before); expect(recovered.text).toBe(firstMarkdown);
      await capture("RMC03-recovered", { status: "step", method: recovered.method, sha256: createHash("sha256").update(recovered.text).digest("hex"), sameRuntimeTask: taskId, requestsAdded: 0, systemClipboard: false });
      await markdownMenu(); await closeVisibleMenus("RMC");
    } finally { await browser.execute(() => { if (window.__qaRuntimeClipboard) window.__qaRuntimeClipboard.rejectClipboard = false; }); }
  }); });
});
