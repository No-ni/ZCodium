import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ConversationArchiveContent } from "@zcode/shared";
import type { ConversationArchiveInput } from "../../../../../packages/services/src/node.js";
import { DEFAULT_WORKSPACE } from "../../../../../packages/desktop/test/e2e/helpers/desktop-app.js";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
} from "../../../../../packages/desktop/test/e2e/helpers/v4-conversation.js";
import { getUpstreamRequestRecordCount } from "../../../../../packages/desktop/test/e2e/helpers/conversation-session-network.js";
import {
  startElectronWindowRecording,
  type ElectronWindowRecordingSession,
} from "../../../../../packages/desktop/test/e2e/helpers/electron-window-recorder.js";
import { clickVisibleControl, closeVisibleMenus, visibleControls } from "../../qa-menu-dom.js";

// 本轮QA：只导入公开合成会话并读历史JSONL，不恢复已移除自动recorder、不发prompt。
const ROOT = resolve(fileURLToPath(new URL("../../../../../", import.meta.url)));
const IMPORT =
  '[data-testid="task-new-button"] button[aria-label="Conversation options"], [data-testid="task-new-button"] button[aria-label="对话选项"]';
const TIMELINE = '[data-trajectory-timeline=""]';
const SEARCH = '[data-trajectory-search-bar=""] input';
const MARKER = "QA_HIST_SHARED_NEEDLE";
const LONG = "QA_HIST_VIRTUAL_FOLDED_NEEDLE";
const RECENT = "QA_HIST_RECENT_TAIL";
const BODY = "QA_HIST_IMPORTED_USER";
let artifacts: string;
let evidence: string;
let home: string;
let historyPath: string;
let taskId: string;
let sequence = 0;
let baselineRequests = 0;
let firstCaseCompleted = false;
let historySha256 = "";
let encode: typeof import("../../../../../packages/services/src/node.js").encodeConversationArchive;
let decode: typeof import("../../../../../packages/services/src/node.js").decodeConversationArchive;
interface HistoricalAdapters {
  clips: string[];
  selected?: HTMLInputElement;
  restore(): void;
}
declare global {
  interface Window {
    __qaHistoricalAdapters?: HistoricalAdapters;
  }
}
type HistoricalMessage = {
  role: string;
  content: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};
interface HistoricalRecord {
  type: "model_io";
  sessionId: string;
  requestId: string;
  querySource: string;
  attempt: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  model: { modelId: string; providerId: string };
  request: { messages: HistoricalMessage[]; toolNames: string[] };
  response: {
    reasoningText: string;
    text: string;
    finishReason: string;
    usage: { inputTokens: number; outputTokens: number };
    toolCalls: Array<{
      toolCallId: string;
      toolName: string;
      input: { value: string };
    }>;
  };
}

async function safe(candidate: string): Promise<string> {
  if (!isAbsolute(candidate)) throw new Error("HIST requires absolute path");
  const target = resolve(candidate);
  const rel = relative(ROOT, target);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
    throw new Error("HIST outside worktree");
  for (let cursor = target; ; cursor = dirname(cursor)) {
    try {
      if (
        (await lstat(cursor)).isSymbolicLink() ||
        (await realpath(cursor)).toLowerCase() !== cursor.toLowerCase()
      )
        throw new Error("HIST reparse/redirected ancestor");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (cursor.toLowerCase() === ROOT.toLowerCase()) break;
  }
  return target;
}
async function audit(candidate: string) {
  const target = await safe(candidate);
  const guard = await safe(join(ROOT, "docs/testing/qa-2026-11-06/qa-reparse-children.ps1"));
  const script =
    readFileSync(guard, "utf8") +
    "\n$ErrorActionPreference='Stop';$target=$env:HIST_AUDIT_TARGET;$cursor=[IO.Path]::GetFullPath($target);while($cursor){if(Test-Path -LiteralPath $cursor){if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'HIST reparse ancestor'}};$cursor=[IO.Path]::GetDirectoryName($cursor)};if(Test-Path -LiteralPath $target -PathType Container){$queue=[Collections.Generic.Queue[string]]::new();$queue.Enqueue($target);while($queue.Count){foreach($item in Get-QaAuditChildren $queue.Dequeue()){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'HIST reparse descendant'};if($item.PSIsContainer){$queue.Enqueue($item.FullName)}}}}";
  execFileSync(
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: {
        ...process.env,
        HIST_AUDIT_TARGET: target,
        QA_REPARSE_WORKTREE: ROOT,
      },
      windowsHide: true,
      stdio: "pipe",
      timeout: 30_000,
    },
  );
}
async function preparePaths() {
  if (
    process.platform !== "win32" ||
    process.env.E2E_PROVIDER_HTTP_MODE !== "replay" ||
    process.env.E2E_PROVIDER_CAPTURE_MODE === "capture" ||
    process.env.ZCODE_E2E_MANUAL_REVIEW !== "1"
  )
    throw new Error("HIST requires isolated Windows pending replay");
  for (const name of [
    "HOME",
    "USERPROFILE",
    "TEMP",
    "TMP",
    "TMPDIR",
    "APPDATA",
    "LOCALAPPDATA",
    "COREPACK_HOME",
    "PNPM_HOME",
    "npm_config_cache",
    "npm_config_store_dir",
    "npm_config_userconfig",
    "TSX_CACHE_DIR",
    "NODE_COMPILE_CACHE",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "ZCODE_E2E_HOME_DIR",
    "ZCODE_E2E_ARTIFACT_DIR",
  ])
    await safe(process.env[name] || "");
  home = await safe(process.env.ZCODE_E2E_HOME_DIR!);
  artifacts = await safe(process.env.ZCODE_E2E_ARTIFACT_DIR!);
  if (
    resolve(process.env.HOME!) !== home ||
    resolve(process.env.USERPROFILE!) !== home ||
    resolve(DEFAULT_WORKSPACE) !== join(home, "ZCodeProject")
  )
    throw new Error("HIST HOME/workspace identity differs");
  await audit(home);
  await audit(artifacts);
  const worker = (process.env.WDIO_WORKER_ID || String(process.pid)).replace(
    /[^a-zA-Z0-9_-]/gu,
    "_",
  );
  evidence = await safe(
    join(artifacts, `qa-historical-trajectory-${worker}-${process.pid}-${Date.now()}`),
  );
  await mkdir(evidence);
  const desktopRequire = createRequire(join(ROOT, "packages/desktop/package.json"));
  const entry = await safe(desktopRequire.resolve("@zcode/services/node"));
  await audit(entry);
  const codec = (await import(
    pathToFileURL(entry).href
  )) as typeof import("../../../../../packages/services/src/node.js");
  if (resolve(codec.getDataBaseDir()) !== home)
    throw new Error("HIST public data root differs from run HOME");
  encode = codec.encodeConversationArchive;
  decode = codec.decodeConversationArchive;
}
async function installAdapters() {
  await browser.execute(`
    if(window.__qaHistoricalAdapters)throw new Error("HIST existing adapter");
    const clipboard=navigator.clipboard;if(!clipboard)throw new Error("HIST Clipboard API unavailable");
    const descriptor=Object.getOwnPropertyDescriptor(clipboard,"writeText");const inputClick=HTMLInputElement.prototype.click;
    const state={clips:[],restore(){if(this.selected?.isConnected)this.selected.dispatchEvent(new Event("cancel"));HTMLInputElement.prototype.click=inputClick;if(descriptor)Object.defineProperty(clipboard,"writeText",descriptor);else delete clipboard.writeText;delete window.__qaHistoricalAdapters;}};
    Object.defineProperty(clipboard,"writeText",{configurable:true,value:async text=>{state.clips.push(text);}});
    HTMLInputElement.prototype.click=function(){if(this.type==="file"&&this.accept===".zcodium"){state.selected=this;return;}inputClick.call(this);};window.__qaHistoricalAdapters=state;
  `);
}
async function importedTask() {
  // 本轮QA：离线archive必须已经经过公开ID投影，原hist-*会被fail-closed校验拒绝。
  const base = { turnId: "share-turn-1", productTurnId: "share-product-turn-1" };
  const rows: ConversationArchiveContent["rows"] = [
    {
      ...base,
      rowId: 1,
      entityId: "share-entity-1",
      createdAt: 1,
      createdAtSeq: 1,
      kind: "turnHeader",
      origin: "userInput",
      state: "completedSuccess",
      startedAt: 1,
      endedAt: 3,
    },
    {
      ...base,
      rowId: 2,
      entityId: "share-entity-2",
      createdAt: 2,
      createdAtSeq: 2,
      kind: "userInput",
      origin: "realUser",
      text: BODY,
    },
    {
      ...base,
      rowId: 3,
      entityId: "share-entity-3",
      createdAt: 3,
      createdAtSeq: 3,
      kind: "assistantText",
      state: "complete",
      text: "QA_HIST_IMPORTED_ASSISTANT",
    },
  ];
  const input: ConversationArchiveInput = {
    title: `QA_HIST_${process.pid}_${Date.now()}`,
    selectedProductTurnIds: [base.productTurnId],
    rows,
    artifacts: [],
  };
  const bytes = await encode(input);
  const decoded = await decode(bytes);
  expect(decoded.content.rows).toEqual(rows);
  expect(decoded.content.selectedProductTurnIds).toEqual(input.selectedProductTurnIds);
  expect(decoded.artifacts.size).toBe(0);
  const file = await safe(join(evidence, "historical-task.zcodium"));
  await writeFile(file, bytes, { flag: "wx" });
  await closeVisibleMenus("HIST");
  await clickVisibleControl(IMPORT, undefined, "HIST");
  await clickVisibleControl('[role="menuitem"]', /^(Import from file…|从文件导入…)$/u, "HIST");
  await browser.waitUntil(
    () => browser.execute("return Boolean(window.__qaHistoricalAdapters?.selected?.isConnected)"),
    { timeout: 15_000, timeoutMsg: "HIST actual archive input missing" },
  );
  await browser.execute(
    `
    const input=window.__qaHistoricalAdapters?.selected;if(!input?.isConnected||input.accept!==".zcodium")throw new Error("HIST picker contract changed");
    const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(arguments[0])],"historical-task.zcodium",{type:"application/octet-stream"}));input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));
  `,
    Array.from(bytes),
  );
  await browser.waitUntil(
    async () => {
      const pane = await getV4PaneSnapshot();
      const rendered = await browser.execute(
        "return document.querySelector('[data-conversation-share-import-notice=\"true\"]')?.innerText.includes(arguments[0])===true",
        BODY,
      );
      return Boolean(pane.sessionId && pane.sessionId !== "draft" && rendered);
    },
    {
      timeout: 45_000,
      timeoutMsg: "HIST public imported task did not render its readonly rows",
    },
  );
  taskId = (await getV4PaneSnapshot()).sessionId!;
  if (!/^[a-zA-Z0-9_-]+$/u.test(taskId))
    throw new Error("HIST imported taskId is not filename safe");
  const task = `[data-testid="task-item-${taskId}"]`;
  if (!(await visibleControls(task)).length) {
    await clickVisibleControl('[data-testid="sidebar-view-menu"]', undefined, "HIST");
    await clickVisibleControl('[data-testid="sidebar-view-timeline"]', undefined, "HIST");
  }
  await clickVisibleControl(task, undefined, "HIST");
  await browser.waitUntil(async () => (await getV4PaneSnapshot()).sessionId === taskId, {
    timeout: 20_000,
    timeoutMsg: "HIST actual imported task activation failed",
  });
}
function record(index: number, sessionId = taskId): HistoricalRecord {
  const user =
    index === 1 || index === 42
      ? `user ${MARKER} ${index}`
      : index === 55
        ? `prefix\n${LONG}\nsuffix`
        : `user ${index}`;
  // 本轮QA：main历史按累计消息数投影增量；等长独立单条input会隐藏42的第二命中。
  const messages: HistoricalMessage[] = index === 0
    ? [
        {
          role: "system",
          content: `QA_HIST_SYSTEM\n${"synthetic line\n".repeat(80)}QA_HIST_SYSTEM_END`,
        },
        { role: "user", content: user },
        {
          role: "tool",
          content: "QA_HIST_TOOL_RESULT",
          toolCallId: "qa-hist-call-0",
          toolName: "qa_synthetic_tool",
        },
      ]
    : [...record(index - 1, sessionId).request.messages, { role: "user", content: user }];
  return {
    type: "model_io",
    sessionId,
    requestId: `qa-hist-${index}`,
    querySource: "main_turn",
    attempt: 1,
    startedAt: new Date(Date.UTC(2026, 10, 6, 0, 0, index)).toISOString(),
    completedAt: new Date(Date.UTC(2026, 10, 6, 0, 0, index, 250)).toISOString(),
    durationMs: 250,
    model: {
      modelId: "qa-historical-model",
      providerId: "qa-historical-provider",
    },
    request: { messages, toolNames: ["qa_synthetic_tool"] },
    response: {
      reasoningText: `QA_HIST_REASONING_${index}`,
      text: `QA_HIST_ASSISTANT_${index}`,
      finishReason: index === 0 ? "length" : "tool-calls",
      usage: { inputTokens: 10, outputTokens: 2 },
      toolCalls: [
        {
          toolCallId: `qa-hist-call-${index}`,
          toolName: "qa_synthetic_tool",
          input: { value: "QA_HIST_INPUT" },
        },
      ],
    },
  };
}
async function seedHistory() {
  const directory = await safe(join(home, ".zcodium/cli/debug"));
  await audit(directory);
  await mkdir(directory, { recursive: true });
  await audit(directory);
  historyPath = await safe(join(directory, `model-io-${taskId.slice(0, 80)}.jsonl`));
  const records = Array.from({ length: 80 }, (_, index) => record(index));
  const foreign = record(900, "qa-foreign-session");
  foreign.response.text = "QA_HIST_FOREIGN_SESSION_RECORD";
  // 仅新建本人合成文件；foreign-session记录用于精确过滤，不复制任何真实历史。
  await writeFile(
    historyPath,
    records.map((value) => JSON.stringify(value)).join("\n") +
      "\n" +
      JSON.stringify(foreign) +
      "\n",
    { flag: "wx" },
  );
  await audit(historyPath);
  historySha256 = createHash("sha256")
    .update(await readFile(historyPath))
    .digest("hex");
  await capture("synthetic-history-created", {
    source: historyPath,
    records: 80,
    foreignRecords: 1,
    sourceSha256: createHash("sha256")
      .update(await readFile(historyPath))
      .digest("hex"),
    autoRecorder: false,
  });
}
async function openViewer() {
  const row = $(`[data-testid="task-item-${taskId}"]`);
  await row.waitForDisplayed({ timeout: 15_000 });
  await row.click({ button: "right" });
  await clickVisibleControl('[role="menuitem"]', /^(View model trajectory|查看调用轨迹)$/u, "HIST");
  await $(TIMELINE).waitForDisplayed({ timeout: 20_000 });
  // QA六角色只存在首条历史；虚拟列表中任意六个展开行不能证明首条已挂载。
  await browser.execute(String.raw`
    const timeline=document.querySelector('[data-trajectory-timeline=""]');
    const owner=timeline?.parentElement;if(!owner)throw new Error("HIST timeline scroll owner missing");
    owner.scrollTo({top:0});
  `);
  await browser.waitUntil(
    () => browser.execute(String.raw`
      const timeline=document.querySelector('[data-trajectory-timeline=""]');
      const first=timeline?.querySelector('[data-trajectory-virtual-row=""][data-index="0"]');
      return Boolean(first?.querySelector('[data-trajectory-expandable-role="system"][data-state="open"]')&&first.querySelector('[data-trajectory-expandable-role="tool-result"][data-state="open"]'));
    `),
    { timeout: 15_000, timeoutMsg: "HIST first call roles did not mount after real owner scroll" },
  );
  await capture("HIST01-first-call-mounted", { status: "step", targetIndex: 0 });
}
interface Snapshot {
  calls: number;
  virtual: number;
  expanded: number;
  roles: string[];
  text: string;
  expandedText: string;
  truncated: number;
  counter: string | null;
  registered: boolean;
  activeMatches: number;
  clips: string[];
  scrollTop: number | null;
  indices: number[];
}
async function snapshot(): Promise<Snapshot> {
  return browser.execute(String.raw`
    const root=document.querySelector('[data-trajectory-timeline=""]');const expanded=[...document.querySelectorAll('[data-trajectory-message-expanded=""][data-state="open"]')];
    const bar=document.querySelector('[data-trajectory-search-bar=""]');const counter=[...bar?.querySelectorAll('span')??[]].find(element=>/\d+\s*\/\s*\d+/.test(element.textContent??""));
    return {calls:document.querySelectorAll('[data-trajectory-call=""]').length,virtual:document.querySelectorAll('[data-trajectory-virtual-row=""]').length,expanded:expanded.length,roles:[...document.querySelectorAll('[data-trajectory-message-collapsible=""][data-state="open"]')].map(element=>element.dataset.trajectoryExpandableRole??""),text:root?.textContent??"",expandedText:expanded.map(element=>element.textContent??"").join("\n"),truncated:[...document.querySelectorAll('p')].filter(element=>/Too many records|记录过多/.test(element.textContent??"")).length,counter:counter?.textContent??null,registered:Boolean(CSS.highlights?.has("zcode-model-trajectory-find")||CSS.highlights?.has("zcode-model-trajectory-find-active")),activeMatches:CSS.highlights?.get("zcode-model-trajectory-find-active")?.size??0,clips:window.__qaHistoricalAdapters?.clips??[],scrollTop:root?.parentElement?.scrollTop??null,indices:[...root?.querySelectorAll('[data-trajectory-virtual-row=""]')??[]].map(element=>Number(element.dataset.index))};
  `) as Promise<Snapshot>;
}
async function capture(name: string, details: Record<string, unknown>) {
  const stem = await safe(join(evidence, `${String(++sequence).padStart(3, "0")}-${name}`));
  const reservation = await open(stem + ".png", "wx");
  await reservation.close();
  await browser.saveScreenshot(stem + ".png");
  await writeFile(
    stem + ".json",
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        evidenceKind:
          "synthetic history via real Host/UI; no recorder/provider/native picker/system clipboard",
        taskId,
        ...details,
        state: await snapshot(),
        requests: await getUpstreamRequestRecordCount(),
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
}
async function runCase(context: Mocha.Context, id: string, action: () => Promise<void>) {
  context.timeout(180_000);
  let recording: ElectronWindowRecordingSession | undefined;
  const frameDir = await safe(join(evidence, `${id}-frames`));
  await audit(frameDir);
  try {
    await capture(id + "-before", { status: "before" });
    recording = await startElectronWindowRecording({
      browser,
      frameDir,
      outputPath: join(evidence, `${id}-unencoded.webm`),
      frameIntervalMs: 1000,
      preRollDurationMs: 0,
      cleanupFrames: false,
      encodeVideo: async () => {
        throw new Error("No standard video encoder; timestamped PNG sequence retained");
      },
    });
    await action();
    expect(await getUpstreamRequestRecordCount()).toBe(baselineRequests);
    await capture(id, { status: "passed" });
    await audit(frameDir);
    await recording.discard();
    recording = undefined;
  } catch (error) {
    let frames: unknown;
    try {
      if (recording) {
        await audit(frameDir);
        frames = await recording.stop({ tailDurationMs: 500 });
      }
    } catch (failure) {
      frames = {
        frameDir,
        error: failure instanceof Error ? failure.message : String(failure),
        format: "PNG/time sequence; no encoded video",
      };
    }
    await capture(id, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      frames,
    });
    throw error;
  }
}
async function search(query: string) {
  if (!(await $(SEARCH).isExisting()))
    await clickVisibleControl('[data-trajectory-search-trigger=""]', undefined, "HIST");
  await $(SEARCH).waitForDisplayed({ timeout: 10_000 });
  await $(SEARCH).setValue(query);
}
async function expandedOverrideSurvives() {
  await search(MARKER);
  await $(SEARCH).click();
  await browser.keys("Enter");
  await browser.waitUntil(async () => (await snapshot()).counter?.match(/2\s*\/\s*2/u) != null, {
    timeout: 15_000,
    timeoutMsg: "HIST second result did not mount",
  });
  await browser.keys("Escape");
  const selector = '[data-index="42"] [data-trajectory-expandable-role="user"]';
  await browser.waitUntil(
    () => browser.execute("return Boolean(document.querySelector(arguments[0]))", selector),
    { timeout: 15_000 },
  );
  const info = (await browser.execute(
    `const row=document.querySelector(arguments[0]);return {state:row.dataset.state,key:row.dataset.trajectorySearchTargetKey,scroll:document.querySelector('[data-trajectory-timeline=""]')?.parentElement?.scrollTop};`,
    selector,
  )) as { state: string; key: string; scroll: number };
  if (info.state !== "open")
    await clickVisibleControl(
      `${selector} [data-trajectory-message-trigger=""]`,
      undefined,
      "HIST",
    );
  const isOpen = () =>
    browser.execute(
      "return [...document.querySelectorAll('[data-trajectory-search-target-key]')].find(element=>element.dataset.trajectorySearchTargetKey===arguments[0])?.dataset.state==='open'",
      info.key,
    );
  await browser.waitUntil(isOpen, { timeout: 10_000 });
  await browser.execute(
    "document.querySelector('[data-trajectory-timeline=\"\"]')?.parentElement?.scrollTo({top:0})",
  );
  await browser.waitUntil(
    () =>
      browser.execute(
        "return ![...document.querySelectorAll('[data-trajectory-search-target-key]')].some(element=>element.dataset.trajectorySearchTargetKey===arguments[0])",
        info.key,
      ),
    { timeout: 15_000, timeoutMsg: "HIST target never left virtual window" },
  );
  await browser.execute(
    "document.querySelector('[data-trajectory-timeline=\"\"]')?.parentElement?.scrollTo({top:arguments[0]})",
    info.scroll,
  );
  await browser.waitUntil(isOpen, {
    timeout: 15_000,
    timeoutMsg: "HIST user override lost after virtual remount",
  });
  await capture("HIST02-virtual-override", { status: "step", targetIndex: 42 });
}
async function oversizedTail() {
  const exact = await safe(historyPath);
  await audit(exact);
  if (
    createHash("sha256")
      .update(await readFile(exact))
      .digest("hex") !== historySha256
  )
    throw new Error("HIST owned history changed before tail extension");
  if (exact !== join(home, ".zcodium/cli/debug", `model-io-${taskId.slice(0, 80)}.jsonl`))
    throw new Error("HIST exactPath ownership changed");
  const handle = await open(exact, "r+");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new Error("HIST refuses nonowned/oversized history before truncate");
    await handle.truncate(33 * 1024 * 1024);
  } finally {
    await handle.close();
  }
  const recent = record(901);
  recent.requestId = "qa-hist-recent";
  recent.request.messages = [{ role: "user", content: RECENT }];
  recent.response.text = RECENT + "_RESPONSE";
  await audit(exact);
  await appendFile(exact, "\n" + JSON.stringify(recent) + "\n", "utf8");
  await clickVisibleControl(
    'button[aria-label="Refresh"],button[aria-label="刷新"]',
    undefined,
    "HIST",
  );
  await browser.waitUntil(
    async () => {
      const value = await snapshot();
      return value.text.includes(RECENT) && value.truncated === 1;
    },
    {
      timeout: 20_000,
      timeoutMsg: "HIST bounded tail did not show recent record/truncated notice",
    },
  );
  await capture("HIST02-bounded-tail", {
    status: "step",
    bytes: (await lstat(exact)).size,
    requestedReadBound: 32 * 1024 * 1024,
  });
}

describe("QA historical model trajectory (public import, no automatic recorder)", () => {
  before(async () => {
    try {
      await preparePaths();
      await prepareV4ConversationE2E({ skipProvider: true });
      await installAdapters();
      baselineRequests = await getUpstreamRequestRecordCount();
    } catch (error) {
      if (evidence) {
        try {
          await capture("beforeAll-failure", {
            status: "setup-failed",
            error: error instanceof Error ? error.message : String(error),
          });
        } catch (failure) {
          throw new AggregateError([error, failure], "HIST setup and evidence failed");
        }
      }
      throw error;
    }
  });
  afterEach(async () => {
    if (await $(SEARCH).isExisting()) await browser.keys("Escape");
    await closeVisibleMenus("HIST");
    await browser.releaseActions();
  });
  after(async () => {
    await browser.execute("window.__qaHistoricalAdapters?.restore()");
  });
  it("HIST01: public imported synthetic history renders six roles, collapse, expansion and captured copy", async function () {
    await runCase(this, "HIST01", async () => {
      await importedTask();
      await seedHistory();
      await openViewer();
      await browser.waitUntil(async () => (await snapshot()).expanded >= 6, {
        timeout: 15_000,
        timeoutMsg: "HIST six expanded roles not projected",
      });
      const initial = await snapshot();
      expect(initial.roles).toEqual(
        expect.arrayContaining([
          "system",
          "user",
          "reasoning",
          "assistant",
          "tool-call",
          "tool-result",
        ]),
      );
      expect(initial.calls).toBeGreaterThan(0);
      expect(initial.calls).toBeLessThan(80);
      expect(initial.text).not.toContain("QA_HIST_FOREIGN_SESSION_RECORD");
      const system = '[data-trajectory-expandable-role="system"]';
      await clickVisibleControl(`${system} [data-trajectory-message-copy=""]`, undefined, "HIST");
      await browser.waitUntil(
        async () =>
          (await snapshot()).clips.some(
            (value) => value.startsWith("QA_HIST_SYSTEM\n") && value.endsWith("QA_HIST_SYSTEM_END"),
          ),
        {
          timeout: 10_000,
          timeoutMsg: "HIST copy did not preserve full synthetic system body",
        },
      );
      await capture("HIST01-captured-copy", {
        status: "step",
        systemClipboard: false,
      });
      await clickVisibleControl(
        `${system} [data-trajectory-message-trigger=""]`,
        undefined,
        "HIST",
      );
      await browser.waitUntil(
        () =>
          browser.execute(
            "return document.querySelector(arguments[0])?.dataset.state==='closed'",
            system,
          ),
        { timeout: 10_000 },
      );
      expect((await visibleControls(`${system} [data-trajectory-message-copy=""]`)).length).toBe(0);
      await clickVisibleControl(
        `${system} [data-trajectory-message-trigger=""]`,
        undefined,
        "HIST",
      );
      await browser.waitUntil(
        () =>
          browser.execute(
            "return document.querySelector(arguments[0])?.dataset.state==='open'",
            system,
          ),
        { timeout: 10_000 },
      );
      await clickVisibleControl('[data-trajectory-toggle-all=""]', undefined, "HIST");
      await browser.waitUntil(async () => (await snapshot()).expanded === 0, {
        timeout: 10_000,
      });
      await clickVisibleControl('[data-trajectory-custom-expansion=""]', undefined, "HIST");
      await clickVisibleControl('[data-trajectory-expansion-kind="reasoning"]', undefined, "HIST");
      await clickVisibleControl(
        '[data-trajectory-expansion-kind="tool-result"]',
        undefined,
        "HIST",
      );
      await browser.keys("Escape");
      await browser.waitUntil(
        async () => {
          const roles = (await snapshot()).roles;
          return (
            roles.includes("reasoning") &&
            roles.includes("tool-result") &&
            roles.every((role) => role === "reasoning" || role === "tool-result")
          );
        },
        {
          timeout: 10_000,
          timeoutMsg: "HIST custom expansion did not restrict roles",
        },
      );
    });
    firstCaseCompleted = true;
  });
  it("HIST02: historical virtual matches navigate, retain expansion and bounded tail refresh", async function () {
    await runCase(this, "HIST02", async () => {
      if (!firstCaseCompleted || !taskId || !historyPath)
        throw new Error("HIST02 requires successful HIST01 fixture; no repair or fabricated task");
      expect((await snapshot()).virtual).toBeLessThan(80);
      await expandedOverrideSurvives();
      await search(MARKER);
      await browser.waitUntil(
        async () => (await snapshot()).counter?.match(/1\s*\/\s*2/u) != null,
        { timeout: 15_000 },
      );
      await $(SEARCH).click();
      await browser.keys("Enter");
      await browser.waitUntil(
        async () => (await snapshot()).counter?.match(/2\s*\/\s*2/u) != null,
        { timeout: 15_000 },
      );
      await browser.keys(["Shift", "Enter"]);
      await browser.waitUntil(
        async () => (await snapshot()).counter?.match(/1\s*\/\s*2/u) != null,
        { timeout: 15_000 },
      );
      expect((await snapshot()).activeMatches).toBe(1);
      await capture("HIST02-search-navigation", { status: "step" });
      await search("QA_HIST_NO_MATCH");
      await browser.waitUntil(
        async () => (await snapshot()).counter?.match(/0\s*\/\s*0/u) != null,
        { timeout: 10_000 },
      );
      await browser.keys("Escape");
      await browser.waitUntil(async () => !(await snapshot()).registered, {
        timeout: 10_000,
      });
      await search(LONG);
      await browser.waitUntil(async () => (await snapshot()).expandedText.includes(LONG), {
        timeout: 15_000,
        timeoutMsg: "HIST virtual folded match did not expand",
      });
      await capture("HIST02-virtual-folded-match", { status: "step" });
      await browser.keys("Escape");
      await oversizedTail();
    });
  });
});
