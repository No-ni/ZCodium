import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Key } from "webdriverio";
import { DEFAULT_WORKSPACE, readSettings, setCurrentElectronRendererContentSize } from "../../../../../packages/desktop/test/e2e/helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "../../../../../packages/desktop/test/e2e/helpers/v4-conversation.js";
import { countUpstreamRequests } from "../../../../../packages/desktop/test/e2e/helpers/conversation-session-network.js";
import { clickVisibleControl, closeVisibleMenus, visibleControl } from "../../qa-menu-dom.js";

// 对应 BUG-006/007/008；仅隔离草稿、工具栏 DOM 布局和本树公开文件输入，不触碰业务 store。
const ROOT = resolve(fileURLToPath(new URL("../../../../../", import.meta.url)));
const REQUIRED = ["HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "APPDATA", "LOCALAPPDATA", "COREPACK_HOME", "PNPM_HOME", "npm_config_cache", "npm_config_store_dir", "npm_config_userconfig", "TSX_CACHE_DIR", "NODE_COMPILE_CACHE", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "ZCODE_E2E_HOME_DIR", "ZCODE_E2E_ARTIFACT_DIR"];
const INPUT = '[data-testid="v4-composer-input"]';
const MODEL = '[data-testid="chat-model-select-trigger"]';
const HOST = '[data-testid="side-pane-full-view-host"]';
const CENTER = '[role="dialog"] [cmdk-input]';
const ITEMS = '[role="dialog"] [cmdk-item]';
let evidence: string;
let sequence = 0;
let originalLocale: string;
let requestBaseline = 0;
let previewFile: string;

async function safe(candidate: string) {
  if (!isAbsolute(candidate)) throw new Error("UIF requires an absolute worktree path");
  const target = resolve(candidate), rel = relative(ROOT, target);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("UIF path outside worktree");
  for (let cursor = target; ; cursor = dirname(cursor)) {
    try {
      if ((await lstat(cursor)).isSymbolicLink() || (await realpath(cursor)).toLowerCase() !== cursor.toLowerCase()) throw new Error("UIF redirected ancestor rejected");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (cursor === dirname(cursor)) break;
  }
  return target;
}

async function audit(candidate: string) {
  const target = await safe(candidate);
  const guard = await safe(join(ROOT, "docs/testing/qa-2026-11-06/qa-reparse-children.ps1"));
  const script = readFileSync(guard, "utf8") + "\n$ErrorActionPreference='Stop';$cursor=$env:UIF_AUDIT_TARGET;while($cursor){if(Test-Path -LiteralPath $cursor){if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'UIF reparse ancestor'}};$cursor=[IO.Path]::GetDirectoryName($cursor)};if(Test-Path -LiteralPath $env:UIF_AUDIT_TARGET -PathType Container){$q=[Collections.Generic.Queue[string]]::new();$q.Enqueue($env:UIF_AUDIT_TARGET);while($q.Count){foreach($item in Get-QaAuditChildren $q.Dequeue()){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'UIF reparse descendant'};if($item.PSIsContainer){$q.Enqueue($item.FullName)}}}}";
  execFileSync("C:\\Program Files\\PowerShell\\7\\pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, UIF_AUDIT_TARGET: target, QA_REPARSE_WORKTREE: ROOT }, windowsHide: true, stdio: "pipe", timeout: 30_000 });
}

async function paths() {
  if (process.platform !== "win32" || process.env.E2E_PROVIDER_HTTP_MODE !== "replay" || process.env.ZCODE_E2E_MANUAL_REVIEW !== "1" || process.env.E2E_PROVIDER_CAPTURE_MODE === "capture") throw new Error("UIF requires isolated Windows finite replay");
  for (const key of REQUIRED) await safe(process.env[key] || "");
  const home = await safe(process.env.ZCODE_E2E_HOME_DIR!);
  const artifacts = await safe(process.env.ZCODE_E2E_ARTIFACT_DIR!);
  if (resolve(DEFAULT_WORKSPACE) !== join(home, "ZCodeProject")) throw new Error("UIF workspace differs from owned HOME");
  await audit(home); await audit(artifacts); await audit(DEFAULT_WORKSPACE);
  const worker = (process.env.WDIO_WORKER_ID || String(process.pid)).replace(/[^a-zA-Z0-9_-]/gu, "_");
  const snapshots = await Promise.all((await readdir(artifacts)).filter(name => name.startsWith(`qa-project-bootstrap-${worker}-`) && name.endsWith("-after.json")).map(async name => JSON.parse(await readFile(await safe(join(artifacts, name)), "utf8"))));
  if (!snapshots.some(snapshot => snapshot.workerId === worker && snapshot.database === join(home, ".zcodium/v2/tasks-index.sqlite") && snapshot.projects?.some((project: { name: string; host_id: string; deleted: number }) => project.name === "ZCodeProject" && project.host_id === "local" && !project.deleted))) throw new Error("UIF current worker bootstrap not proven");
  const suffix = `${worker}-${process.pid}-${Date.now()}`;
  evidence = await safe(join(artifacts, `qa-ui-bugfix-${suffix}`)); await mkdir(evidence);
  previewFile = await safe(join(DEFAULT_WORKSPACE, `UIF_PREVIEW_${suffix}.txt`));
  // 独占公开文件前置；无终端/模型请求，也不清理已有文件或旧测试目录。
  await writeFile(previewFile, "UIF_SYNTHETIC_PREVIEW_中文\n", { flag: "wx" });
}

async function click(selector: string, pattern?: RegExp) { await clickVisibleControl(selector, pattern, "UIF"); }
async function close() {
  await closeVisibleMenus("UIF");
  for (let attempt = 0; attempt < 3 && await visibleControl('[role="dialog"]'); attempt++) await browser.keys("Escape");
  if (await visibleControl('[data-testid="settings-page"]')) await click('[data-testid="settings-back-button"]');
}

async function presentation(locale: string) {
  await close(); await click('[data-testid="sidebar-preferences-trigger"]');
  await click('[role="menuitem"][aria-haspopup="menu"]', /^(Language|界面语言)$/u);
  await click('[role="menuitemradio"]', locale === "en-US" ? /^English$/u : locale === "zh-CN" ? /^中文简体$/u : /^(System default|跟随系统|系统默认)$/u);
  await closeVisibleMenus("UIF");
  await browser.waitUntil(async () => { const settings = await readSettings(); return settings.localePreference === locale && (locale === "system" || settings.locale === locale); }, { timeout: 15_000 });
}

async function replaceQuery(text: string) {
  await click(CENTER);
  await browser.action("key").down(Key.Ctrl).down("a").up("a").up(Key.Ctrl).perform();
  await browser.keys("Backspace");
  if (text) await browser.keys(text);
  await browser.waitUntil(async () => (await $(CENTER).getValue()) === text, { timeout: 15_000 });
}

async function openCenter(scope: "commands" | "files", query: string) {
  await close(); await click('[data-testid="sidebar-search-open"]');
  await $(CENTER).waitForDisplayed({ timeout: 15_000 });
  await click('[role="dialog"] [role="tab"]', scope === "commands" ? /^(Actions|操作)$/u : /^(Files|文件)$/u);
  await replaceQuery(query);
}

async function state() {
  return await browser.execute(String.raw`
    function rect(node){if(!node)return null;const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,left:r.left,right:r.right,top:r.top,bottom:r.bottom};}
    const inputs=[...document.querySelectorAll('[data-testid="v4-composer-input"]')].filter(node=>node.checkVisibility());
    return {viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},active:{tag:document.activeElement?.tagName,testId:document.activeElement?.getAttribute('data-testid')},
      composers:inputs.map(input=>{const shell=input.closest('[data-composer-layout]'),toolbar=[...(shell?.children||[])].find(node=>node.classList.contains('group/toolbar')),model=toolbar?.querySelector('[data-testid="chat-model-select-trigger"]');return {layout:shell?.getAttribute('data-composer-layout'),shell:rect(shell),shellData:shell?{...shell.dataset}:null,toolbar:rect(toolbar),toolbarData:toolbar?{...toolbar.dataset}:null,leading:rect(toolbar?.querySelector('[data-composer-leading-actions]')),content:rect(toolbar?.querySelector('[data-composer-leading-content]')),trailing:rect(toolbar?.querySelector('[data-composer-trailing-actions]')),input:rect(input),model:rect(model),modelText:model?.textContent,modelChildren:model?[...model.children].map(child=>({tag:child.tagName,class:child.className,display:getComputedStyle(child).display})):[],compact:toolbar?[...toolbar.querySelectorAll('[data-composer-collapse-priority]')].map(control=>({priority:control.dataset.composerCollapsePriority,compact:control.dataset.composerCompact||null})):[],editorSame:!window.__qaUiFixEditor||window.__qaUiFixEditor===input};}),
      hostMode:document.querySelector('[data-testid="side-pane-full-view-host"]')?.getAttribute('data-side-pane-full-view-host'),host:rect(document.querySelector('[data-testid="side-pane-full-view-host"]')),
      center:{input:document.querySelector('[role="dialog"] [cmdk-input]')?.value,items:[...document.querySelectorAll('[role="dialog"] [cmdk-item]')].map(row=>({value:row.getAttribute('data-value'),text:row.textContent,selected:row.getAttribute('aria-selected')}))}};
  `);
}

async function capture(id: string, details: Record<string, unknown>) {
  const stem = await safe(join(evidence, `${String(++sequence).padStart(3, "0")}-${id}`));
  const reservation = await open(stem + ".png", "wx"); await reservation.close();
  await browser.saveScreenshot(stem + ".png");
  await writeFile(stem + ".json", JSON.stringify({ capturedAt: new Date().toISOString(), evidenceKind: "isolated real UI; synthetic preview/draft; no Provider or native clipboard", ...details, state: await state() }, null, 2) + "\n", { flag: "wx" });
}

async function run(context: Mocha.Context, id: string, action: () => Promise<void>) {
  context.timeout(180_000);
  try { await capture(id + "-before", { status: "before" }); await action(); expect(await countUpstreamRequests({})).toBe(requestBaseline); await capture(id, { status: "passed" }); }
  catch (error) { await capture(id, { status: "failed", reason: error instanceof Error ? error.message : String(error) }); throw error; }
}

async function waitHost(mode: string) {
  await browser.waitUntil(async () => (await $(HOST).getAttribute("data-side-pane-full-view-host")) === mode, { timeout: 15_000, timeoutMsg: `UIF full-view host did not become ${mode}` });
}

describe("UI 修复工具栏与命令身份（外置pending）", () => {
  before(async function () {
    this.timeout(180_000);
    try {
      await paths(); await prepareV4ConversationE2E({ skipProvider: true });
      await setCurrentElectronRendererContentSize(1280, 900);
      originalLocale = (await readSettings()).localePreference || "system";
      await presentation("en-US"); requestBaseline = await countUpstreamRequests({});
    } catch (error) { if (evidence) await capture("beforeAll-failure", { status: "setup-failed", reason: error instanceof Error ? error.message : String(error) }); throw error; }
  });
  afterEach(async () => { await close(); await browser.releaseActions(); });
  after(async () => {
    await browser.execute(String.raw`delete window.__qaUiFixEditor;delete window.__qaUiFixToolbar;`);
    if (originalLocale) await presentation(originalLocale);
    await browser.electron.restoreAllMocks();
  });

  it("UIF01: 普通工具栏240px压缩和恢复保留骨架菜单焦点与模型节点", async function () { await run(this, "UIF01", async () => {
    const input = await visibleControl(INPUT); expect(input).toBeDefined();
    await browser.execute(String.raw`
      const input=[...document.querySelectorAll('[data-testid="v4-composer-input"]')].find(node=>node.checkVisibility());
      const shell=input?.closest('[data-composer-layout]'),toolbar=[...(shell?.children||[])].find(node=>node.classList.contains('group/toolbar'));
      if(!shell||!toolbar)throw new Error('UIF toolbar owner missing');
      window.__qaUiFixToolbar={shell,toolbar,model:toolbar.querySelector('[data-testid="chat-model-select-trigger"]'),css:shell.style.cssText};
    `);
    try {
      await browser.waitUntil(() => browser.execute(String.raw`const state=window.__qaUiFixToolbar;return state?.toolbar.querySelector('[data-composer-leading-actions]')&&state.toolbar.querySelector('[data-composer-leading-content]')&&state.toolbar.querySelector('[data-composer-trailing-actions]')&&!state.toolbar.querySelector('[contenteditable]')&&!state.toolbar.dataset.composerModelIcon;`), { timeout: 15_000 });
      await click(MODEL); await browser.keys("ArrowDown");
      await browser.waitUntil(() => browser.execute(String.raw`const state=window.__qaUiFixToolbar,menu=[...document.querySelectorAll('[role="menu"]')].find(node=>node.checkVisibility());if(!menu||!menu.contains(document.activeElement))return false;state.menu=menu;state.focus=document.activeElement;return true;`), { timeout: 15_000, timeoutMsg: "UIF model menu did not take keyboard focus" });
      await capture("UIF01-menu-wide", { status: "step" });
      await browser.execute(String.raw`const state=window.__qaUiFixToolbar;state.shell.style.width='240px';state.shell.style.maxWidth='240px';state.shell.style.flexShrink='0';`);
      await browser.waitUntil(() => browser.execute(String.raw`const state=window.__qaUiFixToolbar;return state.toolbar.dataset.composerModelIcon==='true'&&state.model===state.toolbar.querySelector('[data-testid="chat-model-select-trigger"]')&&state.menu.isConnected&&state.menu.checkVisibility()&&state.focus===document.activeElement;`), { timeout: 15_000, timeoutMsg: "UIF narrow toolbar failed to compact or preserve menu/focus/node" });
      await capture("UIF01-narrow", { status: "step", forcedShellWidth: 240, normalWindowWidth: 1280 });
      await browser.execute(String.raw`const state=window.__qaUiFixToolbar;state.shell.style.cssText=state.css;`);
      await browser.waitUntil(() => browser.execute(String.raw`const state=window.__qaUiFixToolbar;return !state.toolbar.dataset.composerModelIcon&&!state.toolbar.dataset.composerProviderCompact&&!state.toolbar.querySelector('[data-composer-compact]')&&state.model===state.toolbar.querySelector('[data-testid="chat-model-select-trigger"]')&&state.menu.isConnected&&state.menu.checkVisibility()&&state.focus===document.activeElement;`), { timeout: 15_000, timeoutMsg: "UIF restored toolbar retained compact flags or remounted controls" });
      await capture("UIF01-restored", { status: "step", menuPreserved: true, focusPreserved: true, modelNodePreserved: true });
    } finally { await browser.execute(String.raw`const state=window.__qaUiFixToolbar;if(state?.shell.isConnected)state.shell.style.cssText=state.css;delete window.__qaUiFixToolbar;`); await closeVisibleMenus("UIF"); }
  }); });

  it("UIF02: 560px浮窗同owner紧凑模型和单行输入保留草稿编辑器", async function () { await run(this, "UIF02", async () => {
    const name = previewFile.slice(previewFile.lastIndexOf(sep) + 1);
    await openCenter("files", name);
    await click(ITEMS, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    await $(CENTER).waitForExist({ reverse: true, timeout: 15_000 });
    await browser.waitUntil(() => browser.execute(String.raw`return [...document.querySelectorAll('[data-side-pane-tab-id]')].some(tab=>tab.textContent.includes(arguments[0]));`, name), { timeout: 20_000, timeoutMsg: "UIF synthetic preview tab did not open" });
    await click('[data-testid="side-pane-full-view-toggle"]'); await waitHost("floating");
    try {
      await browser.waitUntil(() => browser.execute(String.raw`
        const host=document.querySelector('[data-testid="side-pane-full-view-host"]'),input=host?.querySelector('[data-testid="v4-composer-input"]'),shell=input?.closest('[data-composer-layout]'),toolbar=[...(shell?.children||[])].find(node=>node.classList.contains('group/toolbar'));
        if(!host||!input||!shell||!toolbar)return false;
        const model=toolbar.querySelector('[data-testid="chat-model-select-trigger"]'),plus=shell.querySelector('[data-composer-action-menu] button'),send=host.querySelector('[data-testid="v4-composer-send"]');if(!model||!plus||!send)return false;
        const h=host.getBoundingClientRect(),s=shell.getBoundingClientRect(),i=input.getBoundingClientRect(),p=plus.getBoundingClientRect(),b=send.getBoundingClientRect();
        const openLabel=model.querySelector('[data-composer-open-label]'),icon=model.querySelector('[data-composer-open-icon]')||model.querySelector('svg[class*="group-data-[composer-model-icon=true]/toolbar:inline-flex"]');
        const textHidden=openLabel?getComputedStyle(openLabel).display==='none':model.querySelector('[class*="group-data-[composer-model-icon=true]/toolbar:hidden"]')?getComputedStyle(model.querySelector('[class*="group-data-[composer-model-icon=true]/toolbar:hidden"]')).display==='none':false;
        return shell.dataset.composerLayout==='inline'&&toolbar.dataset.composerModelIcon==='true'&&!shell.dataset.composerModelIcon&&Math.abs(h.width-560)<=2&&i.width>=s.width/2-16&&p.right<=i.left+1&&i.right<=b.left+1&&Math.abs((p.top+p.height/2)-(b.top+b.height/2))<=2&&Math.abs((i.top+i.height/2)-(b.top+b.height/2))<=2&&textHidden&&icon?.checkVisibility();
      `), { timeout: 15_000, timeoutMsg: "UIF floating toolbar owner/CSS/560px single-line contract failed" });
      await capture("UIF02-inline-empty", { status: "step", expectedWidth: 560, singleRowGeometry: true, centerTolerancePx: 2, heightObservedOnly: true, noPrompt: true });
      await browser.execute(String.raw`window.__qaUiFixEditor=document.querySelector('[data-testid="side-pane-full-view-host"] [data-testid="v4-composer-input"]');`);
      await click(`${HOST} ${INPUT}`); await browser.keys("UIF_DRAFT_KEEP_中文");
      await browser.waitUntil(async () => (await $(`${HOST} ${INPUT}`).getText()).includes("UIF_DRAFT_KEEP_中文"), { timeout: 15_000 });
      await click('[data-testid="side-pane-full-view-conversation-tab"]'); await waitHost("conversation");
      await browser.waitUntil(() => browser.execute(String.raw`const input=document.querySelector('[data-testid="side-pane-full-view-host"] [data-testid="v4-composer-input"]'),shell=input?.closest('[data-composer-layout]'),toolbar=[...(shell?.children||[])].find(node=>node.classList.contains('group/toolbar'));return input===window.__qaUiFixEditor&&input.textContent.includes('UIF_DRAFT_KEEP_中文')&&shell.dataset.composerLayout==='stacked'&&!toolbar.dataset.composerModelIcon;`), { timeout: 15_000, timeoutMsg: "UIF conversation layout lost draft/editor or retained inline compact state" });
      await capture("UIF02-conversation", { status: "step", editorPreserved: true, draftPreserved: true });
    } finally {
      await click('[data-testid="side-pane-full-view-toggle"]'); await waitHost("normal");
      const current = await visibleControl(INPUT); if (current) { await current.click(); await browser.action("key").down(Key.Ctrl).down("a").up("a").up(Key.Ctrl).perform(); await browser.keys("Backspace"); }
      await browser.execute(String.raw`delete window.__qaUiFixEditor;`);
    }
  }); });

  it("UIF03: 中英文设置两个command ID唯一选择并由上下键Enter执行", async function () { await run(this, "UIF03", async () => {
    for (const locale of ["en-US", "zh-CN"]) {
      await presentation(locale);
      for (const id of ["suggested-settings", "settings"]) {
        await openCenter("commands", locale === "en-US" ? "Settings" : "设置");
        const target = `${ITEMS}[data-value="command:${id}"]`;
        await browser.waitUntil(async () => await $(`${ITEMS}[data-value="command:suggested-settings"]`).isDisplayed() && await $(`${ITEMS}[data-value="command:settings"]`).isDisplayed(), { timeout: 15_000 });
        expect(await $(`${ITEMS}[data-value="command:suggested-settings"]`).getText()).toBe(await $(`${ITEMS}[data-value="command:settings"]`).getText());
        await $(target).moveTo();
        await browser.waitUntil(async () => (await $(target).getAttribute("aria-selected")) === "true" && (await $$(`${ITEMS}[aria-selected="true"]`).length) === 1, { timeout: 15_000, timeoutMsg: "UIF same-title command hover selected multiple IDs" });
        await capture(`UIF03-${locale}-${id}-hover`, { status: "step", commandId: id });
        await browser.keys("ArrowDown");
        await browser.waitUntil(async () => (await $$(`${ITEMS}[aria-selected="true"]`).length) === 1 && (await $(`${ITEMS}[aria-selected="true"]`).getAttribute("data-value")) !== `command:${id}`, { timeout: 10_000 });
        await browser.keys("ArrowUp");
        await browser.waitUntil(async () => (await $(target).getAttribute("aria-selected")) === "true" && (await $$(`${ITEMS}[aria-selected="true"]`).length) === 1, { timeout: 10_000 });
        await capture(`UIF03-${locale}-${id}-keyboard`, { status: "step", commandId: id });
        await browser.keys("Enter"); await $('[data-testid="settings-page"]').waitForDisplayed({ timeout: 15_000 });
        // QA同步：设置先打开，Radix旧portal会等退场动画结束；等待卸载后保留原不存在断言。
        await $(CENTER).waitForExist({ reverse: true, timeout: 15_000 });
        expect(await $(CENTER).isExisting()).toBe(false);
        await capture(`UIF03-${locale}-${id}-executed`, { status: "step", commandId: id, settingsOpened: true });
        await close();
      }
    }
  }); });
});
