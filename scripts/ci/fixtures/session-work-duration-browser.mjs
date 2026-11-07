import assert from "node:assert/strict";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { build, stop } from "esbuild";
import ts from "typescript";
import { chromium } from "playwright-core";
import { assertProjectPath, projectRoot } from "../project-test-sandbox.mjs";

const sandbox = await assertProjectPath(process.env.PROJECT_TEST_SANDBOX_ROOT);
const output = await assertProjectPath(join(sandbox, "browser-bundle"));
const profile = await assertProjectPath(join(sandbox, "chrome-profile"));
await mkdir(output);
await mkdir(profile);
const fixture = `
import {useState} from "react";
import {createRoot} from "react-dom/client";
import {ZCodeIntlProvider} from "@/i18n/IntlProvider.js";
import {ChatLoading, ConversationWorkingPlaceholder} from "@/components/ai-elements/chat-loading.js";
import {useConversationWorkDuration} from "@/hooks/useConversationWorkDuration.js";
import {buildConversationTurnRenderUnits} from "@/v4/conversationTurnRenderUnits.js";
import {resolveConversationLatestTurnSummary,isSameConversationLatestTurnSummary} from "@/v4/conversationTimelineLiveTail.js";
const params=new URLSearchParams(location.search);
document.documentElement.className=params.get('theme')+' theme-zai-'+params.get('theme');
let now=100000; Date.now=()=>now;
let outerRenders=0;
function unit(startedAt=70000,extra={}) {
 const rows=[{kind:'turnHeader',rowId:1,turnId:'turn-a',createdAt:startedAt,createdAtSeq:1,origin:'userInput',executionKind:'agent',startedAt,state:'running',...extra}];
 // 空的终态轮本来不会进入时间线；完成态夹具保留实际输入和结果，运行态继续验证空轮回退。
 if(extra.state&&extra.state!=='running') rows.push(
  {kind:'userInput',rowId:2,turnId:'turn-a',createdAt:startedAt,createdAtSeq:2,text:'Synthetic input'},
  {kind:'assistantText',rowId:3,turnId:'turn-a',createdAt:extra.endedAt,createdAtSeq:3,text:'Synthetic response',state:extra.state==='completedInterrupted'?'interrupted':'complete'}
 );
 return buildConversationTurnRenderUnits(rows,{nowMs:now,sessionPhase:'running'})[0];
}
function guidedUnit() {
 const rows=[
  {kind:'turnHeader',rowId:1,turnId:'turn-guide',createdAt:70000,createdAtSeq:1,origin:'userInput',executionKind:'agent',startedAt:70000,state:'running',workSegments:[{segmentId:'initial',startedAt:70000,endedAt:105000,activeMs:35000},{segmentId:'guided',triggerEntityId:'guided-input',startedAt:105000}]},
  {kind:'userInput',rowId:2,turnId:'turn-guide',createdAt:70000,createdAtSeq:2,text:'Synthetic initial input',entityId:'initial-input'},
  {kind:'userInput',rowId:3,turnId:'turn-guide',createdAt:105000,createdAtSeq:3,text:'Synthetic guided input',entityId:'guided-input',guided:true},
 ];
 return buildConversationTurnRenderUnits(rows,{nowMs:now,sessionPhase:'running'})[0];
}
Object.assign(window,{workFixture:{setTime(value){now=value},unit,guidedUnit,summary:resolveConversationLatestTurnSummary,same:isSameConversationLatestTurnSummary}});
function Clock({status,visible}) {
 const elapsed=useConversationWorkDuration(status,100);
 return <><output id='elapsed'>{elapsed===undefined?'unknown':elapsed}</output>{visible?<ChatLoading loading elapsedMs={elapsed} data-testid='loading'/>:null}</>;
}
function Fixture(){
 outerRenders++;
 const [session,setSession]=useState('a');
 const [mounted,setMounted]=useState(true);
 const [visible,setVisible]=useState(true);
 const [revision,setRevision]=useState(0);
 const [mode,setMode]=useState('live');
 const source=mode==='guide'?guidedUnit():unit(session==='a'?70000:90000, mode==='fixed'?{activeMs:2400}:mode==='ended'?{state:'completedSuccess',endedAt:72500}:mode==='interrupted'?{state:'completedInterrupted',endedAt:72500}:mode==='future'?{startedAt:now+1000}:{});
 const status=mode==='unknown'?undefined:source.workSegments?.at(-1)?.workStatus??source.workStatus;
 return <main className='p-4 bg-background text-foreground min-h-screen'>
 <button id='switch' onClick={()=>setSession(value=>value==='a'?'b':'a')}>Switch session</button>
 <button id='mount' onClick={()=>setMounted(value=>!value)}>Toggle mounted</button>
 <button id='visible' onClick={()=>setVisible(value=>!value)}>Toggle loading</button>
 <button id='revision' onClick={()=>setRevision(value=>value+1)}>Projection update</button>
 <button id='fixed' onClick={()=>setMode('fixed')}>Fixed</button>
 <button id='ended' onClick={()=>setMode('ended')}>Completed</button>
 <button id='guide' onClick={()=>setMode('guide')}>Guided segment</button>
 <button id='interrupted' onClick={()=>setMode('interrupted')}>Interrupted</button>
 <button id='future' onClick={()=>setMode('future')}>Future clock</button>
 <button id='unknown' onClick={()=>setMode('unknown')}>Unknown timing</button>
 <output id='revision-value'>{revision}</output><output id='outer-renders'>{outerRenders}</output>
 {mounted?<Clock key={session} status={status} visible={visible}/>:null}
 <p id='floating'><ConversationWorkingPlaceholder status={status} fallback='Waiting for timing'/></p>
 </main>;
}
createRoot(document.getElementById('root')).render(<ZCodeIntlProvider initialLocale={params.get('locale')}><Fixture/></ZCodeIntlProvider>);
`;
const entry = await assertProjectPath(join(output, "fixture.tsx"));
await writeFile(entry, fixture);
// AST 验证真实生产接线；行为回放使用同一 hook、组件与纯投影，没有复制其实现。
function walk(node, predicate, found = []) {
  if (predicate(node)) found.push(node);
  ts.forEachChild(node, (child) => {
    walk(child, predicate, found);
  });
  return found;
}
async function source(path) {
  const text = await readFile(await assertProjectPath(join(projectRoot, path)), "utf8");
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function elements(root, tag) {
  return walk(
    root,
    (node) => ts.isJsxSelfClosingElement(node) && node.tagName.getText(root) === tag,
  );
}
function expression(element, name) {
  const attribute = element.attributes.properties.find(
    (node) => ts.isJsxAttribute(node) && node.name.text === name,
  );
  assert.ok(
    attribute?.initializer && ts.isJsxExpression(attribute.initializer),
    `Missing ${name} expression`,
  );
  return attribute.initializer.expression;
}
const group = await source("packages/ui/src/v4/ConversationTurnGroup.tsx");
const slots = elements(group, "TurnChatLoadingSlot");
assert.equal(slots.length, 3);
for (const slot of slots)
  assert.equal(
    expression(slot, "workStatus").getText(group),
    "unit.workSegments?.at(-1)?.workStatus ?? unit.workStatus",
  );
const composer = await source("packages/ui/src/v4/ConversationComposer.tsx");
const placeholder = elements(composer, "ConversationWorkingPlaceholder");
assert.equal(placeholder.length, 1);
assert.equal(expression(placeholder[0], "status").getText(composer), "workingStatus");
assert.equal(expression(placeholder[0], "fallback").getText(composer), "placeholder");
const editor = await source("packages/ui/src/prompt-editor/ChatPromptEditor.tsx");
assert.equal(
  expression(elements(editor, "LexicalChatInput")[0], "placeholderContent").getText(editor),
  "placeholderContent",
);
const lexical = await source("packages/ui/src/LexicalChatInput.tsx");
assert.equal(
  walk(
    lexical,
    (node) =>
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      node.getText(lexical) === "placeholderContent ?? placeholder",
  ).length,
  1,
);
console.log("WSC01-04: production AST bindings passed");

let server;
let browser;
let closing;
async function bounded(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const cleanup = () => {
  closing ??= (async () => {
    stop();
    let closeError;
    try {
      await bounded(browser?.close() ?? Promise.resolve(), 10_000, "BROWSER_CLOSE_TIMEOUT");
    } catch (error) {
      closeError = error;
    }
    if (server) {
      server.closeAllConnections();
      await bounded(
        new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
        5_000,
        "HTTP_CLOSE_TIMEOUT",
      );
    }
    if (closeError) throw closeError;
  })();
  return closing;
};
const watchdog = setTimeout(() => {
  console.error("SESSION_DURATION_FIXTURE_TIMEOUT");
  void cleanup().finally(() => process.exit(1));
}, 90_000);
const evidence = [];
try {
  const { outputFiles } = await bounded(
    build({
      stdin: { contents: fixture, resolveDir: projectRoot, loader: "tsx" },
      outfile: join(output, "fixture.js"),
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      alias: { "@": join(projectRoot, "packages/ui/src") },
      define: { "process.env.NODE_ENV": '"production"' },
    }),
    20_000,
    "BUNDLE_TIMEOUT",
  );
  const bundle = outputFiles[0].contents;
  await writeFile(await assertProjectPath(join(output, "fixture.js")), bundle);
  stop();
  const html =
    '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:14px system-ui;margin:16px}button{margin:4px}output{display:block;margin:8px}#loading{display:flex;gap:12px;align-items:center}#loading>span:first-child{display:grid;width:13px;height:13px;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(3,1fr);gap:1px}#loading>span:first-child>span{background:currentColor}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>';
  server = createServer((request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    if (path === "/fixture.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(bundle);
    } else if (path === "/fixture") {
      response.setHeader("Content-Type", "text/html");
      response.end(html);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await bounded(
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    }),
    5_000,
    "HTTP_LISTEN_TIMEOUT",
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string" && address.address === "127.0.0.1");
  const origin = `http://127.0.0.1:${address.port}`;
  await writeFile(
    await assertProjectPath(join(sandbox, "fixture.json")),
    JSON.stringify({ origin, entry }),
  );
  const downloads = await assertProjectPath(join(sandbox, "downloads"));
  await mkdir(downloads);
  browser = await chromium.launchPersistentContext(profile, {
    executablePath: await assertProjectPath(process.env.PROJECT_TEST_BROWSER_EXECUTABLE),
    headless: true,
    env: process.env,
    timeout: 15_000,
    downloadsPath: downloads,
    args: [
      `--disk-cache-dir=${join(sandbox, "cache")}`,
      "--disable-breakpad",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  await browser.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  for (const mobile of [false, true])
    for (const theme of ["light", "dark"])
      for (const locale of ["zh-CN", "en-US"]) {
        const page = await browser.newPage();
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        await page.setViewportSize({ width: mobile ? 390 : 1280, height: 800 });
        await page.goto(`${origin}/fixture?theme=${theme}&locale=${locale}`, { timeout: 15_000 });
        const expectMs = async (value) => {
          try {
            await page.waitForFunction(
              (expected) => document.querySelector("#elapsed")?.textContent === String(expected),
              value,
            );
          } catch (error) {
            assert.fail(
              `Expected elapsed=${value}; actual=${await page
                .locator("#elapsed")
                .textContent()
                .catch(() => "missing")}; pageErrors=${JSON.stringify(errors)}; ${error.message}`,
            );
          }
        };
        await expectMs(30000);
        assert.match(await page.locator("#floating").textContent(), /30/);
        await page.evaluate(() => window.workFixture.setTime(105000));
        await expectMs(35000);
        await page.waitForFunction(() =>
          document.querySelector("#floating").textContent.includes("35"),
        );
        const initialRenders = await page.locator("#outer-renders").textContent();
        await page.evaluate(() => window.workFixture.setTime(106000));
        await expectMs(36000);
        assert.equal(
          await page.locator("#outer-renders").textContent(),
          initialRenders,
          "Leaf clocks must not render the parent",
        );
        await page.locator("#switch").click();
        await expectMs(16000);
        await page.locator("#switch").click();
        await expectMs(36000);
        await page.locator("#mount").click();
        await page.evaluate(() => window.workFixture.setTime(110000));
        await page.locator("#mount").click();
        await expectMs(40000);
        await page.locator("#visible").click();
        await page.evaluate(() => window.workFixture.setTime(112000));
        await page.locator("#visible").click();
        await expectMs(42000);
        await page.locator("#revision").click();
        await expectMs(42000);
        await page.evaluate(() => {
          window.workFixture.setTime(115000);
          window.dispatchEvent(new Event("focus"));
        });
        await expectMs(45000);
        await page.waitForFunction(() =>
          document.querySelector("#floating").textContent.includes("45"),
        );
        await page.evaluate(() => {
          window.workFixture.setTime(116000);
          Object.defineProperty(document, "hidden", { configurable: true, value: false });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await expectMs(46000);
        await page.waitForFunction(() =>
          document.querySelector("#floating").textContent.includes("46"),
        );
        const summaryCheck = await page.evaluate(() => {
          const unit = window.workFixture.unit();
          const summary = window.workFixture.summary([unit]);
          return {
            anchor: summary.workStatus?.liveStartedAt,
            same: window.workFixture.same(summary, {
              ...summary,
              workStatus: { ...summary.workStatus, liveStartedAt: 80000 },
            }),
          };
        });
        assert.deepEqual(summaryCheck, { anchor: 70000, same: false });
        await page.screenshot({
          path: await assertProjectPath(
            join(sandbox, `${mobile ? "mobile" : "desktop"}-${theme}-${locale}.png`),
          ),
        });
        await page.locator("#fixed").click();
        await expectMs(2400);
        await page.evaluate(() => {
          window.workFixture.setTime(120000);
          window.dispatchEvent(new Event("focus"));
        });
        await expectMs(2400);
        await page.locator("#ended").click();
        await expectMs(2500);
        await page.locator("#future").click();
        await expectMs(0);
        await page.locator("#guide").click();
        await expectMs(15000);
        const guide = await page.evaluate(() => {
          const unit = window.workFixture.guidedUnit();
          return unit.workSegments.map((segment) => ({
            state: segment.workStatus.state,
            startedAt: segment.workStatus.liveStartedAt,
            durationMs: segment.workStatus.durationMs,
          }));
        });
        assert.deepEqual(guide, [
          { state: "completed", startedAt: undefined, durationMs: 35000 },
          { state: "running", startedAt: 105000, durationMs: 15000 },
        ]);
        await page.evaluate(() => {
          window.workFixture.setTime(125000);
          window.dispatchEvent(new Event("focus"));
        });
        await expectMs(20000);
        await page.locator("#revision").click();
        await expectMs(20000);
        await page.locator("#interrupted").click();
        await expectMs(2500);
        await page.evaluate(() => {
          window.workFixture.setTime(130000);
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await expectMs(2500);
        await page.locator("#unknown").click();
        await expectMs("unknown");
        assert.equal(await page.locator("#floating").textContent(), "Waiting for timing");
        assert.ok(
          !(await page.locator('[data-testid="loading"]').textContent()).includes("0.0"),
          "Missing facts must not fabricate zero seconds",
        );
        assert.deepEqual(errors, []);
        evidence.push({
          mobile,
          theme,
          locale,
          cases: ["WSC01", "WSC02", "WSC03", "WSC04"],
          guidedStartedAt: 105000,
          interruptedDurationMs: 2500,
          sourceBindings: true,
          screenshot: `${mobile ? "mobile" : "desktop"}-${theme}-${locale}.png`,
        });
        await page.close();
      }
  await writeFile(join(sandbox, "results.json"), JSON.stringify(evidence, null, 2));
  console.log("WSC01-04: 8 variants passed");
} finally {
  clearTimeout(watchdog);
  await cleanup();
}
