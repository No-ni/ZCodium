import { execFileSync } from "node:child_process";
import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_WORKSPACE,
  readSettings,
  setCurrentElectronRendererContentSize,
  waitForWorkspaceApp,
} from "../../../../../packages/desktop/test/e2e/helpers/desktop-app.js";
import { skipOccupationOnboardingIfPresent } from "../../../../../packages/desktop/test/e2e/helpers/occupation-onboarding.js";
import { visibleControl, visibleControls, clickVisibleControl, closeVisibleMenus } from "../../qa-menu-dom.js";
import {
  startElectronWindowRecording,
  type EncodeElectronWindowVideoInput,
  type ElectronWindowRecordingSession,
} from "../../../../../packages/desktop/test/e2e/helpers/electron-window-recorder.js";

// 中文说明：当前 fork 的只读合同与真实 UI 动作；不修改原 test、产品或真实用户配置。
const REPOSITORY = fileURLToPath(new URL("../../../../../", import.meta.url));
const MAIN = '[data-testid="settings-page"] main';
const PREFERENCES = '[data-testid="sidebar-preferences-trigger"]';
type Outcome = { status: "limited" | "blocked"; reason: string; covered: string[] };
type Locale = "system" | "en-US" | "zh-CN";
type Theme = "system" | "zai-dark" | "zai-light";
let evidenceDirectory: string;
let originalLocale: Locale;

async function auditPath(candidate: string): Promise<string> {
  if (!isAbsolute(candidate)) throw new Error("QLA requires absolute paths");
  const target = resolve(candidate);
  const suffix = relative(resolve(REPOSITORY), target);
  if (!suffix || isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) {
    throw new Error("QLA path escapes the authorized worktree");
  }
  for (let cursor = target; cursor; cursor = dirname(cursor)) {
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error("QLA refuses links/junctions");
      if ((await realpath(cursor)).toLowerCase() !== cursor.toLowerCase()) {
        throw new Error("QLA refuses redirected path ancestors");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (cursor === dirname(cursor)) break;
  }
  return target;
}

function auditReparseTree(target: string) {
  if (process.platform !== "win32") return;
  // 用户路径只经环境传递；同一 PowerShell 只读核对，递归清理只由 recorder 用于已审查本例目录。
  const guardPath = join(REPOSITORY, "docs/testing/qa-2026-11-06/qa-reparse-children.ps1");
  for (let cursor = guardPath; cursor; cursor = dirname(cursor)) {
    if (lstatSync(cursor).isSymbolicLink() || realpathSync(cursor).toLowerCase() !== cursor.toLowerCase()) throw new Error("QLA audit helper has redirected ancestors");
    if (cursor === dirname(cursor)) break;
  }
  const script = readFileSync(guardPath, "utf8") + "\n$ErrorActionPreference='Stop'; $target=$env:QLA_AUDIT_TARGET; $cursor=[IO.Path]::GetFullPath($target); while($cursor) { if(Test-Path -LiteralPath $cursor) { if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'QLA refuses reparse ancestors' } }; $cursor=[IO.Path]::GetDirectoryName($cursor) }; if(Test-Path -LiteralPath $target -PathType Container) { $queue=[Collections.Generic.Queue[string]]::new(); $queue.Enqueue($target); while($queue.Count) { foreach($child in Get-QaAuditChildren $queue.Dequeue()) { if($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'QLA refuses descendant reparse points' }; if($child.PSIsContainer) { $queue.Enqueue($child.FullName) } } } }";
  execFileSync("C:\\Program Files\\PowerShell\\7\\pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, QLA_AUDIT_TARGET: target, QA_REPARSE_WORKTREE: resolve(REPOSITORY) }, windowsHide: true, stdio: "pipe", timeout: 30_000,
  });
}

async function prepareEvidenceDirectory() {
  if (process.platform !== "win32") throw new Error("QLA is audited for local Windows only");
  if (process.env.E2E_PROVIDER_HTTP_MODE !== "replay" || process.env.ZCODE_E2E_MANUAL_REVIEW !== "1") {
    throw new Error("QLA requires external pending/manual-review with Provider replay");
  }
  const required = ["HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "APPDATA", "LOCALAPPDATA", "COREPACK_HOME", "PNPM_HOME", "npm_config_cache", "npm_config_store_dir", "npm_config_userconfig", "TSX_CACHE_DIR", "NODE_COMPILE_CACHE", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "ZCODE_E2E_HOME_DIR", "ZCODE_E2E_ARTIFACT_DIR"];
  for (const name of required) await auditPath(process.env[name] || "");
  const artifact = await auditPath(process.env.ZCODE_E2E_ARTIFACT_DIR || "");
  auditReparseTree(artifact);
  const worker = (process.env.WDIO_WORKER_ID || String(process.pid)).replace(/[^a-zA-Z0-9_-]/gu, "_");
  // 必须经过保留原 renderer preflight 的 bootstrap；没有它不能静默跳过路径/loader审查。
  const home = await auditPath(process.env.ZCODE_E2E_HOME_DIR || "");
  const bootstrapFiles = (await readdir(artifact)).filter((file) => file.startsWith(`qa-project-bootstrap-${worker}-`) && file.endsWith("-after.json"));
  const bootstraps = await Promise.all(bootstrapFiles.map(async (file) => JSON.parse(await readFile(await auditPath(join(artifact, file)), "utf8"))));
  const latest = bootstraps.filter((item) => item.workerId === worker && item.database === join(home, ".zcodium", "v2", "tasks-index.sqlite")).sort((left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt))[0];
  if (!latest || !latest.projects?.some((item: { host_id: string; name: string; deleted: number }) => item.host_id === "local" && item.name === "ZCodeProject" && !item.deleted)) throw new Error("QLA current worker has no successful isolated bootstrap evidence");
  if (resolve(DEFAULT_WORKSPACE) !== join(home, "ZCodeProject")) throw new Error("QLA helper root differs from isolated workspace");
  auditReparseTree(home);
  evidenceDirectory = await auditPath(join(artifact, `qa-local-menu-actions-${worker}`));
  await mkdir(evidenceDirectory, { recursive: true });
}

async function snapshot() {
  const ui = await browser.execute(() => {
    const main = document.querySelector('[data-testid="settings-page"] main');
    return {
      headings: Array.from(document.querySelectorAll<HTMLElement>("h1,h2,h3")).filter(element=>element.checkVisibility()).map((element) => element.innerText.trim()),
      navigation: Array.from(document.querySelectorAll<HTMLElement>("[data-settings-section-nav]")).filter(element=>element.checkVisibility()).map((element) => ({ id: element.dataset.settingsSectionNav, current: element.getAttribute("aria-current") })),
      controls: Array.from(document.querySelectorAll<HTMLElement>('button,[role="switch"],[role="checkbox"],[role="menuitem"],[role="menuitemradio"],[role="option"],input,textarea')).filter(element=>element.checkVisibility()).map((element) => ({
        testid: element.dataset.testid ?? null, role: element.getAttribute("role"), text: element.innerText.trim().slice(0, 140), label: element.getAttribute("aria-label"), checked: element.getAttribute("aria-checked"), state: element.dataset.state, disabled: element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true", value: "value" in element ? String(element.value) : undefined,
      })),
      preferences: { locale: localStorage.getItem("zcode-locale"), localePreference: localStorage.getItem("zcode-locale-preference"), theme: localStorage.getItem("zcode-theme"), interfaceMode: localStorage.getItem("zcode-interface-mode") },
      themeClasses: Array.from(document.documentElement.classList),
      settingsContent: main instanceof HTMLElement ? main.innerText.slice(0, 6000) : null,
      toast: document.querySelector<HTMLElement>("#zcode-toast-host")?.innerText ?? null,
    };
  });
  const settings = await readSettings();
  return { ui, settings: { localePreference: settings.localePreference, locale: settings.locale, memoryEnabled: settings.memoryEnabled, taskAutoArchiveEnabled: settings.taskAutoArchiveEnabled, taskAutoArchiveOlderThanDays: settings.taskAutoArchiveOlderThanDays, computerUseComposerEntryHidden: settings.computerUseComposerEntryHidden } };
}

async function saveEvidence(name: string, detail: Record<string, unknown>) {
  const png = await auditPath(join(evidenceDirectory, `${name}.png`));
  const json = await auditPath(join(evidenceDirectory, `${name}.json`));
  let state: Awaited<ReturnType<typeof snapshot>> | undefined;
  let captureError: string | undefined;
  try { state = await snapshot(); await browser.saveScreenshot(png); }
  catch (error) { captureError = error instanceof Error ? error.message : String(error); }
  await writeFile(json, JSON.stringify({ capturedAt: new Date().toISOString(), evidenceKind: "synthetic local Windows UI QA", ...detail, captureError, state }, null, 2) + "\n", "utf8");
  if (captureError && detail.status === "passed") throw new Error("QLA evidence capture failed: " + captureError);
}

// PATH 未提供 ffmpeg 时仍保存完整窗口时间序列；SVG SMIL 含嵌入帧，无网络字体/资源。
async function encodeAnimatedSvg(input: EncodeElectronWindowVideoInput) {
  const frames = await Promise.all(input.framePaths.map(async (file) => readFile(await auditPath(file))));
  const width = frames[0]!.readUInt32BE(16);
  const height = frames[0]!.readUInt32BE(20);
  const count = frames.length;
  const duration = count / input.frameRate;
  const images = frames.map((frame, index) => {
    const start = index / count;
    const end = (index + 1) / count;
    const epsilon = 0.000001;
    const values = index === 0 ? (count === 1 ? "1;1" : "1;1;0;0") : index === count - 1 ? "0;0;1;1" : "0;0;1;1;0;0";
    const times = index === 0 ? (count === 1 ? "0;1" : `0;${end};${end + epsilon};1`) : index === count - 1 ? `0;${start - epsilon};${start};1` : `0;${start - epsilon};${start};${end};${end + epsilon};1`;
    return `<image width="${width}" height="${height}" href="data:image/png;base64,${frame.toString("base64")}" opacity="${index === 0 ? 1 : 0}"><animate attributeName="opacity" values="${values}" keyTimes="${times}" dur="${duration}s" calcMode="discrete" repeatCount="indefinite"/></image>`;
  }).join("\n");
  await writeFile(await auditPath(input.outputPath), `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>QLA Electron window frame recording</title>${images}</svg>`, "utf8");
  await writeFile(await auditPath(input.outputPath + ".json"), JSON.stringify({ format: "animated SVG SMIL, not MP4/WebM", captureMode: "electron_capture_page", frameRate: input.frameRate, frameCount: count, durationSeconds: duration, frames: input.framePaths }, null, 2) + "\n");
}

async function withEvidence(context: Mocha.Context, name: string, action: () => Promise<Outcome | void>) {
  const frameDir = await auditPath(join(evidenceDirectory, `${name}-frames`));
  const outputPath = await auditPath(join(evidenceDirectory, `${name}-recording.svg`));
  auditReparseTree(frameDir);
  let recording: ElectronWindowRecordingSession | undefined;
  try {
    await saveEvidence(`${name}-before`, { case: name, status: "before" });
    recording = await startElectronWindowRecording({ browser, outputPath, frameDir, frameIntervalMs: 500, preRollDurationMs: 0, encodeVideo: encodeAnimatedSvg, cleanupFrames: false, encodeTimeoutMs: 30_000 });
    const outcome = await action();
    await saveEvidence(name, { case: name, ...outcome, status: outcome ? outcome.status : "passed" });
    await auditPath(frameDir); auditReparseTree(frameDir);
    await recording.discard();
    recording = undefined;
    if (outcome) context.skip();
  } catch (error) {
    // Mocha skip 属于已有 limited/blocked 结果，不能被错误路径改写成产品失败。
    if (!recording && context.test?.pending) throw error;
    let record: unknown;
    try { if (recording) { await auditPath(frameDir); auditReparseTree(frameDir); record = await recording.stop({ tailDurationMs: 500 }); } }
    catch (failure) { record = { captureMode: "electron_capture_page", encodingError: failure instanceof Error ? failure.message : String(failure), preservedFrames: frameDir }; }
    await saveEvidence(name, { case: name, status: "failed", error: error instanceof Error ? error.message : String(error), recording: record });
    throw error;
  }
}

async function displayed(selector: string, matches?: RegExp) {
  return visibleControl(selector, matches);
}
async function click(selector: string, matches?: RegExp) {
  await clickVisibleControl(selector, matches, "QLA");
}
async function closeMenus() {
  await closeVisibleMenus("QLA");
}
async function openSettings(section: string) {
  await closeMenus();
  if (!(await displayed('[data-testid="settings-page"]'))) await click('[data-testid="task-settings-button"]');
  await $('[data-testid="settings-page"]').waitForDisplayed({ timeout: 15_000 });
  const nav = `[data-testid="settings-section-nav-${section}"]`;
  await click(nav);
  await browser.waitUntil(async () => (await $(nav).getAttribute("aria-current")) === "page", { timeout: 15_000, timeoutMsg: `QLA settings section not selected: ${section}` });
}
async function footerSubmenu(kind: "locale" | "theme" | "mode" | "zoom") {
  await closeMenus();
  await click(PREFERENCES);
  const label = { locale: /^(Language|界面语言)$/u, theme: /^(App theme|界面主题)$/u, mode: /^(Interface mode|界面模式)$/u, zoom: /^(Interface zoom|界面缩放)$/u }[kind];
  const selector = '[role="menuitem"][aria-haspopup="menu"]';
  await click(selector, label);
  await browser.waitUntil(async () => (await visibleControls(selector, label))[0]?.state === "open", { timeout: 10_000, timeoutMsg: `QLA footer submenu did not open: ${kind}` });
}
const localeLabel = (locale: Locale) => ({ system: /^(System default|跟随系统|系统默认)$/u, "en-US": /^English$/u, "zh-CN": /^中文简体$/u })[locale];
const themeLabel = (theme: Theme) => ({ system: /^(System default|跟随系统|系统默认)$/u, "zai-light": /^(Light theme|浅色主题)$/u, "zai-dark": /^(Dark theme|深色主题)$/u })[theme];
async function chooseLocale(locale: Locale) {
  await footerSubmenu("locale"); await click('[role="menuitemradio"]', localeLabel(locale));
  await browser.waitUntil(async () => (await readSettings()).localePreference === locale, { timeout: 15_000, timeoutMsg: "QLA locale preference did not persist" });
  await footerSubmenu("locale");
  expect((await visibleControls('[role="menuitemradio"]', localeLabel(locale)))[0]?.checked).toBe("true");
  await closeMenus();
}
async function chooseTheme(theme: Theme) {
  await footerSubmenu("theme"); await click('[role="menuitemradio"]', themeLabel(theme));
  await browser.waitUntil(async () => browser.execute((expected) => localStorage.getItem("zcode-theme") === expected, theme), { timeout: 15_000, timeoutMsg: "QLA theme preference did not persist" });
  await browser.waitUntil(async () => browser.execute((expected) => document.documentElement.classList.contains(`theme-${expected === "system" ? matchMedia("(prefers-color-scheme: dark)").matches ? "zai-dark" : "zai-light" : expected}`), theme), { timeout: 15_000, timeoutMsg: "QLA actual theme did not converge" });
  await footerSubmenu("theme");
  expect((await visibleControls('[role="menuitemradio"]', themeLabel(theme)))[0]?.checked).toBe("true");
  await closeMenus();
}
async function chooseMode(mode: "coding" | "office") {
  await footerSubmenu("mode");
  const label = mode === "coding" ? /^(Coding mode|编程模式)$/u : /^(Office mode|办公模式)$/u;
  await click('[role="menuitemradio"]', label);
  await browser.waitUntil(async () => browser.execute((expected) => localStorage.getItem("zcode-interface-mode") === expected, mode), { timeout: 15_000, timeoutMsg: "QLA interface mode did not persist" });
  await footerSubmenu("mode"); expect((await visibleControls('[role="menuitemradio"]', label))[0]?.checked).toBe("true"); await closeMenus();
}
async function setSwitch(selector: string, checked: boolean) {
  await $(selector).waitForDisplayed({ timeout: 15_000 });
  await browser.waitUntil(async () => (await $(selector).getAttribute("disabled")) === null, { timeout: 20_000, timeoutMsg: "QLA switch never became actionable" });
  if ((await $(selector).getAttribute("aria-checked")) !== String(checked)) await click(selector);
  await browser.waitUntil(async () => (await $(selector).getAttribute("aria-checked")) === String(checked) && (await $(selector).getAttribute("disabled")) === null, { timeout: 20_000, timeoutMsg: "QLA switch change did not converge" });
}
async function expectSetting(key: "memoryEnabled" | "taskAutoArchiveEnabled" | "taskAutoArchiveOlderThanDays" | "computerUseComposerEntryHidden", value: boolean | number) {
  await browser.waitUntil(async () => (await readSettings())[key] === value, { timeout: 15_000, timeoutMsg: `QLA setting did not persist: ${key}` });
}
async function contentSettled(selector: string) {
  let previous = "";
  let stableSince = 0;
  await browser.waitUntil(async () => {
    const text = await $(selector).getText();
    if (/(^|\n)(Loading(?:\.\.\.|…)|Loading memories…|Connecting(?:\.\.\.|…)|加载中[.。…]*|连接中[.。…]*)($|\n)/u.test(text)) { previous = ""; stableSince = 0; return false; }
    if (text !== previous) { previous = text; stableSince = Date.now(); return false; }
    return Date.now() - stableSince > 800;
  }, { timeout: 30_000, interval: 300, timeoutMsg: "QLA settings content did not leave loading/connecting or converge" });
}
async function configFingerprints() {
  const home = process.env.ZCODE_E2E_HOME_DIR!;
  const candidates = [join(home, ".zcodium", "cli", "config.json"), join(home, ".zcodium", "plugins", "marketplaces.json"), join(home, ".zcodium", "plugins", "installed_plugins.json"), join(DEFAULT_WORKSPACE, "zcode.json"), join(DEFAULT_WORKSPACE, ".zcodium", "config.json"), join(DEFAULT_WORKSPACE, ".claude", "settings.json")];
  return Promise.all(candidates.map(async (candidate) => {
    const path = await auditPath(candidate);
    try { return { path: relative(home, path), sha256: createHash("sha256").update(await readFile(path)).digest("hex") }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: relative(home, path), sha256: null }; throw error; }
  }));
}
async function zoomLevel() {
  return browser.electron.execute((electron) => {
    const win = electron.BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed() && candidate.webContents.getURL().includes("/renderer/index.html"));
    if (!win) throw new Error("QLA renderer window missing");
    return win.webContents.getZoomLevel();
  });
}
async function zoomAction(action: "in" | "out" | "reset") {
  await footerSubmenu("zoom");
  await click('[role="menuitem"]', { in: /^(Zoom in|放大)(\s|$)/u, out: /^(Zoom out|缩小)(\s|$)/u, reset: /^(Actual size|实际大小)(\s|$)/u }[action]);
  await closeMenus();
}
async function restoreZoom(target: number) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await zoomLevel(); if (Math.abs(current - target) < 0.001) return;
    await zoomAction(current < target ? "in" : "out");
    await browser.waitUntil(async () => Math.abs((await zoomLevel()) - current) > 0.001, { timeout: 10_000, timeoutMsg: "QLA zoom restore did not change level" });
  }
  throw new Error("QLA could not restore original zoom through menus");
}

function insideTree(parent: string, candidate: string) {
  const suffix = relative(resolve(parent), resolve(candidate));
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

async function prepareStagedHelpConfig(): Promise<Outcome | void> {
  const runId = process.env.ZCODE_E2E_RUN_ID || "";
  if (!/^qa-[a-z0-9-]+$/u.test(runId)) throw new Error("QLA help configuration requires an exact QA run id");
  const stage = await auditPath(join(REPOSITORY, "packages/desktop/.e2e-cache", runId));
  const appRoot = join(stage, "app");
  const main = await browser.electron.execute((electron) => ({
    appPath: electron.app.getAppPath(), isPackaged: electron.app.isPackaged, resourcesPath: process.resourcesPath,
  }));
  // 中文说明：与产品 readDesktopHelpConfig 使用同一公式；只补本 run 缺失配置，不写共享 cache。
  const target = main.isPackaged ? join(main.resourcesPath, "config/default.json") : resolve(main.appPath, "../../config/default.json");
  if (!insideTree(appRoot, main.appPath) || !insideTree(stage, target)) {
    return { status: "blocked", reason: "实际 Main help 配置公式不在此 run 的 staged app 边界，未写配置", covered: ["readonly Main configuration path classification"] };
  }
  await auditPath(main.appPath); await auditPath(target); auditReparseTree(stage);
  if (!(await lstat(stage)).isDirectory()) throw new Error("QLA help staged run directory missing");
  try {
    await lstat(target);
    return { status: "blocked", reason: "本 run help 配置 target 已存在，拒绝覆写或替换", covered: ["readonly Main configuration path classification", "existing target refusal"] };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const source = await auditPath(join(REPOSITORY, "config/default.json")); auditReparseTree(source);
  if (!(await lstat(source)).isFile()) throw new Error("QLA help configuration source is not a regular file");
  const bytes = await readFile(source);
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  if (sourceSha256 !== "8540f76782cf74d436dacd0f9d8bbd612a713dc951da9e1a1d38d9fef0882a86") throw new Error("QLA audited help configuration source changed");
  const configuration = JSON.parse(bytes.toString("utf8")) as { community_urls: Record<string, string>; feedback_url: string; feedback_use_external_form: boolean };
  expect(configuration.community_urls).toEqual({ "zh-CN": "https://github.com/No-ni/ZCodium", "en-US": "https://github.com/No-ni/ZCodium" });
  expect(configuration.feedback_url).toBe("https://github.com/No-ni/ZCodium/issues/new");
  expect(configuration.feedback_use_external_form).toBe(true);
  const proof = await auditPath(join(evidenceDirectory, `QLA05-help-config-${process.pid}-${Date.now()}.json`));
  await writeFile(proof, JSON.stringify({ capturedAt: new Date().toISOString(), evidenceKind: "synthetic run-only help config precondition", main, stage, source, target, sourceSha256, targetExistsBefore: false }, null, 2) + "\n", { flag: "wx" });
  await auditPath(dirname(target)); auditReparseTree(dirname(target));
  await mkdir(dirname(target), { recursive: true });
  await auditPath(dirname(target)); auditReparseTree(dirname(target));
  await writeFile(await auditPath(target), bytes, { flag: "wx" });
  await auditPath(target); auditReparseTree(target);
  const targetSha256 = createHash("sha256").update(await readFile(target)).digest("hex");
  expect(targetSha256).toBe(sourceSha256);
  await saveEvidence("QLA05-help-config-created", { status: "passed", target, sourceSha256, targetSha256, targetExistsBefore: false, preconditionProof: proof });
}

describe("QLA 本轮外置 pending 本地菜单功能专项", () => {
  before(async function () {
    this.timeout(90_000);
    try {
      await prepareEvidenceDirectory(); await skipOccupationOnboardingIfPresent();
      await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000); await setCurrentElectronRendererContentSize(1280, 900);
      originalLocale = (await readSettings()).localePreference ?? "system";
      await chooseLocale("en-US");
    } catch (error) {
      if (evidenceDirectory) {
        try { await saveEvidence(`beforeAll-failure-${process.pid}-${Date.now()}`, {status:"setup-failed", error:error instanceof Error ? error.message : String(error)}); }
        catch (evidenceError) { throw new AggregateError([error,evidenceError],"QLA setup failed; failure evidence also failed"); }
      }
      throw error;
    }
  });
  after(async function () {
    this.timeout(60_000);
    if (evidenceDirectory && originalLocale) await chooseLocale(originalLocale);
  });

  it("QLA01: 底部偏好语言英文/中文/系统即时保存并恢复", async function () {
    await withEvidence(this, "QLA01-footer-language", async () => {
      try { for (const locale of ["zh-CN", "en-US", "system"] as const) { await chooseLocale(locale); await saveEvidence(`QLA01-${locale}`, { status: "passed", coverage: "real footer submenu + radio + shared persistence" }); } }
      finally { await chooseLocale("en-US"); }
    });
  });
  it("QLA02: 底部主题浅色/深色/系统生效并恢复", async function () {
    await withEvidence(this, "QLA02-footer-theme", async () => {
      const original = (await snapshot()).ui.preferences.theme as Theme | null;
      try { for (const theme of ["zai-light", "zai-dark", "system"] as const) { await chooseTheme(theme); await saveEvidence(`QLA02-${theme}`, { status: "passed", coverage: "real footer radio + theme classes + preference" }); } }
      finally { await chooseTheme(original ?? "zai-dark"); }
    });
  });
  it("QLA03: 底部办公/编码模式选择保存并恢复", async function () {
    await withEvidence(this, "QLA03-footer-interface-mode", async () => {
      const original = (await snapshot()).ui.preferences.interfaceMode === "office" ? "office" : "coding";
      try { for (const mode of ["office", "coding"] as const) { await chooseMode(mode); await saveEvidence(`QLA03-${mode}`, { status: "passed", coverage: "real footer radio + interface preference; no workflow execution" }); } }
      finally { await chooseMode(original); }
    });
  });
  it("QLA04: 底部缩放实际大小/放大/缩小与原值恢复", async function () {
    await withEvidence(this, "QLA04-footer-zoom", async () => {
      const original = await zoomLevel();
      try {
        if (Math.abs(original) > 0.001) { await zoomAction("reset"); await browser.waitUntil(async () => Math.abs(await zoomLevel()) < 0.001, { timeout: 10_000 }); }
        await zoomAction("in"); await browser.waitUntil(async () => (await zoomLevel()) > 0.001, { timeout: 10_000, timeoutMsg: "QLA Zoom in did not change main level" });
        await saveEvidence("QLA04-zoom-in", { status: "passed", zoomLevel: await zoomLevel() });
        await zoomAction("out"); await browser.waitUntil(async () => Math.abs(await zoomLevel()) < 0.001, { timeout: 10_000, timeoutMsg: "QLA Zoom out did not restore actual size" });
        await zoomAction("in"); await browser.waitUntil(async () => (await zoomLevel()) > 0.001, { timeout: 10_000 });
        await zoomAction("reset"); await browser.waitUntil(async () => Math.abs(await zoomLevel()) < 0.001, { timeout: 10_000, timeoutMsg: "QLA Actual size did not reset level" });
      } finally { await restoreZoom(original); }
    });
  });
  it("QLA05: 帮助四个fork链接只请求mock openExternal", async function () {
    await withEvidence(this, "QLA05-help-fork-links", async () => {
      const configurationOutcome = await prepareStagedHelpConfig();
      if (configurationOutcome) return configurationOutcome;
      const open = await browser.electron.mock("shell", "openExternal");
      await open.mockResolvedValue(undefined);
      const items = [{ label: /^Product docs$/u, url: "https://github.com/No-ni/ZCodium#readme" }, { label: /^User community$/u, url: "https://github.com/No-ni/ZCodium" }, { label: /^Report an issue$/u, url: "https://github.com/No-ni/ZCodium/issues/new" }, { label: /^Request a feature$/u, url: "https://github.com/No-ni/ZCodium/issues/new" }];
      try {
        for (const [index, item] of items.entries()) {
          await closeMenus(); await click('[data-testid="workspace-help-menu-trigger"]'); await click('[role="menuitem"]', item.label);
          await browser.waitUntil(async () => { await open.update(); return open.mock.calls.length === index + 1; }, { timeout: 15_000, timeoutMsg: `QLA help did not request mock openExternal for ${item.label.source}` });
          expect(String(open.mock.calls[index]?.[0])).toBe(item.url);
          await saveEvidence(`QLA05-link-${index + 1}`, { status: "passed", interceptedUrl: item.url, externalOpenMocked: true, requestSubmitted: false });
        }
      } finally { await open.mockRestore(); await closeMenus(); }
    });
  });
  it("QLA06: 无自有更新源隐藏入口，About ZCodium显示版本并关闭", async function () {
    await withEvidence(this, "QLA06-help-about-update-hidden", async () => {
      const sourceConfigured = await browser.electron.execute(() => Boolean(process.env.ZCODE_UPDATE_FEED_URL?.trim() || process.argv.some((arg) => arg.startsWith("--zcode-update-feed-url"))));
      if (sourceConfigured) throw new Error("QLA update-hidden precondition requires no custom update source");
      await click('[data-testid="workspace-help-menu-trigger"]');
      const menu = await snapshot();
      expect(menu.ui.controls.filter((item) => item.role === "menuitem").some((item) => /Check for updates|Restart to update|检查更新|重启以更新/u.test(item.text))).toBe(false);
      await saveEvidence("QLA06-help-menu", { status: "passed", updateSourceConfigured: false });
      try {
        await click('[role="menuitem"]', /^About ZCodium$/u);
        await browser.waitUntil(async () => browser.electron.execute(async (electron) => {
          const win = electron.BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().startsWith("data:text/html") && decodeURIComponent(candidate.webContents.getURL()).includes('id="about-title"'));
          if (!win?.isVisible()) return false;
          const title = await win.webContents.executeJavaScript('document.querySelector("#about-title")?.textContent');
          return typeof title === "string" && title.includes("ZCodium") && title.includes(electron.app.getVersion());
        }), { timeout: 15_000, timeoutMsg: "QLA About window did not display ZCodium and current version" });
        const about = await browser.electron.execute(async (electron) => {
          const win = electron.BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().startsWith("data:text/html") && decodeURIComponent(candidate.webContents.getURL()).includes('id="about-title"'))!;
          return { title: await win.webContents.executeJavaScript('document.querySelector("#about-title")?.textContent'), version: electron.app.getVersion(), png: (await win.webContents.capturePage()).toPNG().toString("base64") };
        });
        await writeFile(await auditPath(join(evidenceDirectory, "QLA06-about-window.png")), Buffer.from(about.png, "base64"));
        await writeFile(await auditPath(join(evidenceDirectory, "QLA06-about-window.json")), JSON.stringify({ status: "passed", title: about.title, version: about.version }, null, 2) + "\n");
      } finally {
        await browser.electron.execute((electron) => { for (const win of electron.BrowserWindow.getAllWindows()) { if (win.webContents.getURL().startsWith("data:text/html") && decodeURIComponent(win.webContents.getURL()).includes('id="about-title"')) win.close(); } });
      }
    });
  });
  it("QLA07: 记忆开关即时保存，scope/refresh或明确空catalog范围", async function () {
    await withEvidence(this, "QLA07-memory-switch-scope", async () => {
      await openSettings("memory"); await $('[data-testid="settings-memory-switch"]').waitForDisplayed({ timeout: 15_000 });
      const selector = `${MAIN} [data-testid="settings-memory-switch"]`;
      const original = (await $(selector).getAttribute("aria-checked")) === "true";
      try {
        await setSwitch(selector, !original); await expectSetting("memoryEnabled", !original);
        await saveEvidence("QLA07-switch-changed", { status: "passed", coverage: "immediate shared settings save" });
        await setSwitch(selector, true); await expectSetting("memoryEnabled", true); await contentSettled(MAIN);
        if (!(await displayed('[data-testid="settings-memory-scope-trigger"]'))) {
          expect((await $(MAIN).getText())).toContain("No saved workspace memories");
          return { status: "limited", reason: "本轮合成profile没有saved-memory catalog；switch保存通过，scope选择/refresh无可用入口", covered: ["memory switch persistence", "enabled empty catalog"] };
        }
        await click('[data-testid="settings-memory-scope-trigger"]');
        const options = await browser.execute(() => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')).filter((item) => item.checkVisibility()).map((item) => ({ id: item.dataset.testid, label: item.innerText.trim(), checked: item.getAttribute("aria-checked"), key: item.dataset.pluginScopeKey })));
        expect(options.length).toBeGreaterThan(0); expect(options.some((item) => item.key === "user")).toBe(false);
        await saveEvidence("QLA07-scope-menu", { status: "passed", scopeOptions: options });
        const selected = options.find((item) => item.checked === "true") ?? options[0]!;
        if (!selected.id?.startsWith("settings-memory-workspace")) throw new Error("QLA memory scope option lacks current stable testid");
        await click(`[data-testid="${selected.id}"]`); await contentSettled(MAIN);
        await click('[data-testid="settings-memory-refresh"]'); await contentSettled(MAIN);
      } finally { await closeMenus(); await setSwitch(selector, original); await expectSetting("memoryEnabled", original); }
    });
  });
  it("QLA08: 自动归档关闭时可设30天、开关保存并恢复", async function () {
    await withEvidence(this, "QLA08-auto-archive-settings", async () => {
      await openSettings("general"); const selector = `${MAIN} [data-testid="archive-auto-archive-switch"]`;
      await $(selector).waitForDisplayed({ timeout: 15_000 }); const original = (await $(selector).getAttribute("aria-checked")) === "true";
      const originalDays = (await readSettings()).taskAutoArchiveOlderThanDays ?? 7;
      const chooseDays = async (days: number) => { await click('[data-testid="archive-auto-archive-days"]'); await click('[role="option"]', new RegExp(`^Archive after ${days} days$`, "u")); await expectSetting("taskAutoArchiveOlderThanDays", days); };
      try {
        await setSwitch(selector, false); await expectSetting("taskAutoArchiveEnabled", false);
        expect(await $('[data-testid="archive-auto-archive-days"]').isEnabled()).toBe(true);
        await click('[data-testid="archive-auto-archive-days"]');
        const options = await $$('[role="option"]'); expect(await options.map((option) => option.getText())).toEqual(["Archive after 3 days", "Archive after 7 days", "Archive after 14 days", "Archive after 30 days"]);
        await click('[role="option"]', /^Archive after 30 days$/u); await expectSetting("taskAutoArchiveOlderThanDays", 30);
        await saveEvidence("QLA08-disabled-days", { status: "passed", daysEnabledWhileArchiveOff: true, days: 30 });
        await setSwitch(selector, true); await expectSetting("taskAutoArchiveEnabled", true);
      } finally { await closeMenus(); await setSwitch(selector, false); await chooseDays(originalDays); await setSwitch(selector, original); await expectSetting("taskAutoArchiveEnabled", original); }
    });
  });
  it("QLA09: Browser总开关就绪后切换恢复，Windows不展示Chrome导入", async function () {
    await withEvidence(this, "QLA09-browser-control-toggle", async () => {
      await openSettings("browser"); await contentSettled(MAIN);
      const selector = `${MAIN} [role="switch"][aria-label="Enable built-in browser control"]`;
      await $(selector).waitForDisplayed({ timeout: 15_000 });
      expect((await $(MAIN).getText())).not.toMatch(/Import Chrome|Import browser data/u);
      try { await browser.waitUntil(async () => $(selector).isEnabled(), { timeout: 15_000, timeoutMsg: "QLA Browser builtin plugin is unavailable" }); }
      catch { return { status: "blocked", reason: "Browser builtin plugin未可用；disabled contract已观察，未安装或绕过状态", covered: ["browser section readiness", "Windows Chrome import hidden", "disabled switch"] }; }
      const original = (await $(selector).getAttribute("aria-checked")) === "true";
      try { await setSwitch(selector, !original); await saveEvidence("QLA09-switch-changed", { status: "passed", coverage: "real local builtin plugin toggle; no navigation/import/clear" }); }
      finally { await setSwitch(selector, original); }
    });
  });
  it("QLA10: Windows Computer Use总开关/composer显隐切换恢复", async function () {
    await withEvidence(this, "QLA10-computer-use-toggles", async () => {
      await openSettings("computerUse"); await contentSettled(MAIN);
      const total = `${MAIN} [role="switch"][aria-label="Enable Computer Use"]`;
      const entry = `${MAIN} [role="switch"][aria-label="Show Computer Use button in the composer"]`;
      await $(total).waitForDisplayed({ timeout: 15_000 }); const original = (await $(total).getAttribute("aria-checked")) === "true";
      const originalEntry = (await $(entry).getAttribute("aria-checked")) === "true";
      try {
        await setSwitch(total, false); expect(await $(entry).isEnabled()).toBe(false);
        await setSwitch(total, true); await setSwitch(entry, !originalEntry); await expectSetting("computerUseComposerEntryHidden", originalEntry);
        await saveEvidence("QLA10-composer-changed", { status: "passed", coverage: "local Windows plugin + persisted composer hidden flag; no computer tool/permissions" });
      } finally { await setSwitch(total, true); await setSwitch(entry, originalEntry); await expectSetting("computerUseComposerEntryHidden", !originalEntry); await setSwitch(total, original); }
    });
  });
  it("QLA11: Hooks收敛后空态/列表、新建草稿填写取消不保存", async function () {
    await withEvidence(this, "QLA11-hooks-new-cancel", async () => {
      await openSettings("hooks"); await $('[data-testid="hooks-settings-section"]').waitForDisplayed({ timeout: 15_000 });
      await contentSettled('[data-testid="hooks-settings-section"]');
      const before = await configFingerprints(); const count = await $$('[data-testid="configured-hook-row"]').length;
      const text = await $('[data-testid="hooks-settings-section"]').getText();
      if (count === 0) expect(text).toContain("No hooks installed");
      await saveEvidence("QLA11-hooks-settled", { status: "passed", configuredHookCount: count, emptyState: count === 0 });
      await click('[data-testid="hooks-settings-section"] button', /^New hook$/u);
      await $('[data-testid="hooks-form"]').waitForDisplayed({ timeout: 15_000 });
      try {
        expect(await (await displayed('[data-testid="hooks-form"] button', /^Save$/u))!.isEnabled()).toBe(false);
        await $('[data-testid="hooks-form"] #command').setValue("qa-local-cancel-never-executed");
        await $('[data-testid="hooks-form"] #args').setValue("synthetic-draft-only");
        expect(await (await displayed('[data-testid="hooks-form"] button', /^Save$/u))!.isEnabled()).toBe(true);
        await saveEvidence("QLA11-hooks-draft", { status: "passed", saveInvoked: false, commandExecuted: false });
        await click('[data-testid="hooks-form"] button', /^Cancel$/u);
        await $('[data-testid="hooks-form"]').waitForDisplayed({ reverse: true, timeout: 15_000 });
        await contentSettled('[data-testid="hooks-settings-section"]');
        expect(await $$('[data-testid="configured-hook-row"]').length).toBe(count);
        expect(await configFingerprints()).toEqual(before);
        await saveEvidence("QLA11-hooks-cancelled", { status: "passed", configurationFingerprints: before, persistedDraft: false });
      } finally { if (await displayed('[data-testid="hooks-form"]')) await click('[data-testid="hooks-form"] button', /^Cancel$/u); }
    });
  });
  it("QLA12: 商店当前列表/空态、新增市场源risk gate输入后取消", async function () {
    await withEvidence(this, "QLA12-plugin-store-source-cancel", async () => {
      if (await displayed('[data-testid="settings-page"]')) await click('[data-testid="settings-back-button"]');
      await click('[data-testid="plugin-store-sidebar-open"]'); await $('[data-testid="plugin-store-root"]').waitForDisplayed({ timeout: 15_000 });
      await contentSettled('[data-testid="plugin-store-root"]');
      await click('[data-testid="plugin-store-sources-open"]'); await $('[data-testid="plugin-store-sources-dialog"]').waitForDisplayed({ timeout: 15_000 });
      const sourcesBefore = await $$('[data-testid="plugin-store-source-row"]').length;
      await saveEvidence("QLA12-sources-current", { status: "passed", sourceCount: sourcesBefore, publicSourceRequired: false });
      await browser.keys("Escape"); await $('[data-testid="plugin-store-sources-dialog"]').waitForDisplayed({ reverse: true });
      await click('[data-testid="plugin-store-create"]'); await click('[data-testid="plugin-store-add-source-menu-item"]');
      await $('[data-testid="plugin-store-add-source-dialog"]').waitForDisplayed({ timeout: 15_000 });
      try {
        expect(await $('[data-testid="plugin-store-add-source-risk-warning"]').isDisplayed()).toBe(true);
        expect(await $('[data-testid="plugin-store-add-source-submit"]').isEnabled()).toBe(false);
        await $('[data-testid="plugin-store-add-source-input"]').setValue(await auditPath(DEFAULT_WORKSPACE));
        expect(await $('[data-testid="plugin-store-add-source-submit"]').isEnabled()).toBe(false);
        await click('[data-testid="plugin-store-add-source-risk-acknowledgement"]');
        expect(await $('[data-testid="plugin-store-add-source-submit"]').isEnabled()).toBe(true);
        await saveEvidence("QLA12-add-source-draft", { status: "passed", submitInvoked: false, nativePickerInvoked: false });
        await browser.keys("Escape"); await $('[data-testid="plugin-store-add-source-dialog"]').waitForDisplayed({ reverse: true, timeout: 15_000 });
        await click('[data-testid="plugin-store-sources-open"]'); await $('[data-testid="plugin-store-sources-dialog"]').waitForDisplayed({ timeout: 15_000 });
        expect(await $$('[data-testid="plugin-store-source-row"]').length).toBe(sourcesBefore);
        await saveEvidence("QLA12-sources-unchanged", { status: "passed", sourceCount: sourcesBefore, sourceAdded: false });
        await browser.keys("Escape");
      } finally { if (await displayed('[data-testid="plugin-store-add-source-dialog"],[data-testid="plugin-store-sources-dialog"]')) await browser.keys("Escape"); }
    });
  });
});
