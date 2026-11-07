import { createServer, type Server } from "node:http";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  TID_BROWSER_ADDRESS_INPUT,
  TID_BROWSER_PERMISSION_DENY,
  TID_BROWSER_PERMISSION_PROMPTS,
  TID_BROWSER_WEBVIEW,
} from "@zcode/shared/test-ids";
import { clickTestIdByWebDriver } from "#e2e/helpers/desktop-app";
import { openFirstBrowserTab } from "#e2e/helpers/browser-side-pane";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

// BUG-005：只申请通知并在产品气泡拒绝，不访问位置、摄像头、设备或创建系统通知。
const ROOT = resolve(import.meta.dirname, "../../../../../..");
const HTML = `<!doctype html><title>QA_PERMISSION_BUG005</title><h1>synthetic permission request</h1>`;
let server: Server;
let origin: string;
let evidence: string;

async function safe(candidate: string): Promise<string> {
  const path = resolve(candidate);
  const rel = relative(ROOT, path);
  if (!isAbsolute(candidate) || !rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("BUG005 evidence must remain in the current worktree");
  }
  for (let cursor = path; ; cursor = dirname(cursor)) {
    try {
      if ((await lstat(cursor)).isSymbolicLink() || (await realpath(cursor)).toLowerCase() !== cursor.toLowerCase()) {
        throw new Error("BUG005 redirected ancestor rejected");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (cursor === dirname(cursor)) break;
  }
  return path;
}

async function guestId(): Promise<number> {
  const id = await browser.execute((testId: string) => {
    const element = Array.from(document.querySelectorAll<HTMLElement & { getWebContentsId?: () => number }>(
      `[data-testid="${testId}"]`,
    )).findLast((candidate) => candidate.getBoundingClientRect().width > 0 && candidate.getBoundingClientRect().height > 0);
    return element?.getWebContentsId?.() ?? null;
  }, TID_BROWSER_WEBVIEW);
  if (typeof id !== "number") throw new Error("BUG005 guest is not mounted");
  return id;
}

async function runGuest<T>(script: string): Promise<T> {
  return browser.electron.execute(async (electron, id: number, code: string) => {
    const guest = electron.webContents.fromId(id);
    if (!guest || guest.isDestroyed()) throw new Error("BUG005 guest is unavailable");
    return guest.executeJavaScript(code);
  }, await guestId(), script) as Promise<T>;
}

async function snapshot(name: string) {
  await browser.saveScreenshot(await safe(join(evidence, `${name}.png`)));
  const state = await runGuest("(async () => ({ geolocation: (await navigator.permissions.query({name:'geolocation'})).state, notifications: (await navigator.permissions.query({name:'notifications'})).state, result: window.__qaPermissionResult ?? null }))()");
  await writeFile(await safe(join(evidence, `${name}.json`)), JSON.stringify({ state }, null, 2), { flag: "wx" });
}

async function promptVisible(): Promise<boolean> {
  return browser.execute((testId: string) => {
    const root = document.querySelector(`[data-testid="${testId}"]`);
    return !!root && root.getBoundingClientRect().width > 0 && root.getBoundingClientRect().height > 0;
  }, TID_BROWSER_PERMISSION_PROMPTS);
}

describe("BUG-005 权限启动后的产品拒绝", () => {
  before(async () => {
    if (process.env.ZCODE_E2E_MANUAL_REVIEW !== "1" || process.env.E2E_PROVIDER_HTTP_MODE !== "replay") {
      throw new Error("BUG005 requires the reviewed isolated pending replay runner");
    }
    await safe(process.env.ZCODE_E2E_HOME_DIR || "");
    const artifacts = await safe(process.env.ZCODE_E2E_ARTIFACT_DIR || "");
    evidence = await safe(join(artifacts, `bug005-prompt-${process.pid}-${Date.now()}`));
    await mkdir(evidence);
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(HTML);
    });
    await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("BUG005 loopback server is unavailable");
    origin = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    if (server) await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept()));
  });

  it("BPF01: 未授权默认拒绝；通知产品气泡拒绝后再次询问", async function () {
    this.timeout(240_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await openFirstBrowserTab();
    await (await $(`[data-testid="${TID_BROWSER_ADDRESS_INPUT}"]`)).setValue(origin);
    await browser.keys("Enter");
    await browser.waitUntil(async () => (await runGuest("document.title")) === "QA_PERMISSION_BUG005", { timeout: 30_000 });
    await clickTestIdByWebDriver(TID_BROWSER_WEBVIEW);
    expect(await runGuest("(async () => (await navigator.permissions.query({name:'geolocation'})).state)()")).toBe("denied");
    expect(await runGuest("(async () => (await navigator.permissions.query({name:'notifications'})).state)()")).toBe("denied");
    await snapshot("01-default-denied");
    for (const attempt of [1, 2]) {
      await runGuest("void (window.__qaPermissionResult = null); void Notification.requestPermission().then(value => { window.__qaPermissionResult = value; })");
      await browser.waitUntil(promptVisible, { timeout: 10_000, timeoutMsg: "BUG005 product permission prompt is missing" });
      await snapshot(`0${attempt + 1}-prompt`);
      await clickTestIdByWebDriver(TID_BROWSER_PERMISSION_DENY);
      await browser.waitUntil(async () => (await runGuest("window.__qaPermissionResult")) === "denied", { timeout: 10_000 });
      await browser.waitUntil(async () => !(await promptVisible()), { timeout: 10_000 });
      expect(await runGuest("(async () => (await navigator.permissions.query({name:'notifications'})).state)()")).toBe("denied");
    }
    await snapshot("04-denied-after-second-request");
  });
});
