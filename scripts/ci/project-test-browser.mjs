import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, _electron } from "playwright-core";

/** 只加载 loopback React 夹具，浏览器配置与 Electron 所有写入路径都留在项目 sandbox。 */
export async function launchProjectTestPage(sandbox) {
  if (process.env.ZCODE_TEST_ELECTRON_EXECUTABLE) {
    const bootstrap = join(sandbox.root, "browser-fixture.cjs");
    await writeFile(
      bootstrap,
      `const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(join(sandbox.root, "browser-profile"))});
app.setPath('sessionData', ${JSON.stringify(join(sandbox.root, "browser-session"))});
app.setPath('crashDumps', ${JSON.stringify(join(sandbox.root, "browser-crashes"))});
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.whenReady().then(() => {
  const window = new BrowserWindow({ show: false, width: 1280, height: 850,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  window.loadURL('about:blank');
});
app.on('window-all-closed', () => app.quit());
`,
      { flag: "wx" },
    );
    const env = { ...sandbox.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const application = await _electron.launch({
      executablePath: process.env.ZCODE_TEST_ELECTRON_EXECUTABLE,
      args: [bootstrap],
      env,
      timeout: 20000,
    });
    return {
      page: await application.firstWindow({ timeout: 10000 }),
      close: () => application.close(),
    };
  }
  const context = await chromium.launchPersistentContext(join(sandbox.root, "browser-profile"), {
    headless: true,
    executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
    env: sandbox.env,
    timeout: 20000,
  });
  return { page: await context.newPage(), close: () => context.close() };
}
