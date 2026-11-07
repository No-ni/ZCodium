import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  DEFAULT_WORKSPACE,
  waitForDefaultWorkspaceReady,
} from "../../../../../packages/desktop/test/e2e/helpers/desktop-app.js";
import {
  projectRowSelector,
  projectSectionSelector,
} from "../../../../../packages/desktop/test/e2e/helpers/project-sidebar.js";
import { reloadElectronSessionPreservingBrowserProfile } from "../../../../../packages/desktop/test/e2e/helpers/e2e-electron-reload.js";

// BUG004：项目必须来自启动前旧设置及真正 Worker；测试不能再用 UI bootstrap 创建缺失项目。
const ROOT = resolve(fileURLToPath(new URL("../../../../../", import.meta.url)));
const RUN = "qa-fix-bug004-desktop-legacy-project";
const RUNTIME = join(ROOT, "docs/testing/qa-2026-11-06/runtime", RUN);
const HOME = join(RUNTIME, ".e2e-home-" + RUN);
const ARTIFACTS = join(RUNTIME, "evidence");
const DATABASE = join(HOME, ".zcodium/v2/tasks-index.sqlite");
const SETTINGS = join(HOME, ".zcodium/v2/setting.json");
const CHECKSUM = "ac00a61c7c45a5ceb3814b1487901372c5580eb6eb8d31bde5bcdfbd1ed0f0da";
const EVIDENCE = "bug004-desktop-" + process.pid + "-" + Date.now();
const exec = promisify(execFile);
const sourceHashes: Record<string, string> = {};
let first: ReturnType<typeof readState> | undefined;
let firstMain: Awaited<ReturnType<typeof readMainIdentity>> | undefined;
let firstPassed = false;
let phase = "not-started";

async function safe(candidate: string): Promise<string> {
  if (!isAbsolute(candidate)) throw new Error("B4UI absolute path required");
  const target = resolve(candidate);
  const rel = relative(ROOT, target);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
    throw new Error("B4UI outside worktree");
  for (let cursor = target; ; cursor = dirname(cursor)) {
    try {
      if ((await lstat(cursor)).isSymbolicLink() ||
          (await realpath(cursor)).toLowerCase() !== cursor.toLowerCase())
        throw new Error("B4UI reparse/redirected ancestor");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (cursor.toLowerCase() === ROOT.toLowerCase()) break;
  }
  return target;
}

async function audit(targets: string[]) {
  for (const target of targets) await safe(target);
  const guard = await readFile(await safe(join(ROOT, "docs/testing/qa-2026-11-06/qa-reparse-children.ps1")), "utf8");
  await exec("C:\\Program Files\\PowerShell\\7\\pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", guard + `
    $ErrorActionPreference='Stop';$paths=ConvertFrom-Json $env:B4UI_AUDIT_PATHS;
    foreach($target in $paths){$cursor=[IO.Path]::GetFullPath($target);
      while($cursor){if(Test-Path -LiteralPath $cursor){if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'B4UI reparse ancestor'}};$cursor=[IO.Path]::GetDirectoryName($cursor)}
      if(Test-Path -LiteralPath $target -PathType Container){$queue=[Collections.Generic.Queue[string]]::new();$queue.Enqueue($target);
        while($queue.Count){foreach($item in Get-QaAuditChildren $queue.Dequeue()){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'B4UI reparse descendant'};if($item.PSIsContainer){$queue.Enqueue($item.FullName)}}}}
    }`], {
    env: { ...process.env, B4UI_AUDIT_PATHS: JSON.stringify(targets), QA_REPARSE_WORKTREE: ROOT },
    windowsHide: true,
    timeout: 30_000,
  });
}

function readState() {
  // 只读快照，不通过 Repo 或 DML 补齐项目，不扫描其它用户数据库。
  const db = new DatabaseSync(DATABASE, { readOnly: true });
  try {
    db.exec("BEGIN");
    return {
      projects: db.prepare("SELECT * FROM projects ORDER BY host_id,position,project_id").all(),
      roots: db.prepare("SELECT * FROM project_roots ORDER BY project_id,position,root_path").all(),
      projectLedger: db.prepare("SELECT * FROM schema_migration ORDER BY id").all(),
      tasksLedger: db.prepare("SELECT * FROM tasks_schema_migration ORDER BY id").all(),
      foreignKeyErrors: db.prepare("PRAGMA foreign_key_check").all(),
    };
  } finally {
    db.close();
  }
}

async function readMainIdentity() {
  return browser.electron.execute((electron, expectedHome, expectedRun) => ({
    pid: process.pid,
    userDataDir: electron.app.getPath("userData"),
    homeMatches: process.env.HOME === expectedHome && process.env.USERPROFILE === expectedHome,
    dataMatches: process.env.ZCODE_DESKTOP_HOME_DIR === expectedHome && process.env.ZCODE_DATA_BASE_DIR === expectedHome,
    runMatches: process.env.ZCODE_E2E_RUN_ID === expectedRun && process.argv.includes("--zcode-e2e-run-id=" + expectedRun),
  }), HOME, RUN);
}

async function readSidebar() {
  // raw JS 避免 tsx keepNames 辅助函数被序列化后成为 browser 闭包依赖。
  return browser.execute(String.raw`
    const selector=arguments[0],rowSelector=arguments[1];
    return Array.from(document.querySelectorAll(selector)).map(section=>{
      const row=document.querySelector(rowSelector);
      return {projectId:section.getAttribute('data-project-id'),name:section.getAttribute('data-project-name'),
        rowVisible:!!row && row.getClientRects().length>0 && getComputedStyle(row).visibility!=='hidden',
        rowText:row?row.innerText:null};
    });`, projectSectionSelector(DEFAULT_WORKSPACE), projectRowSelector(DEFAULT_WORKSPACE)) as Promise<{
      projectId: string | null; name: string | null; rowVisible: boolean; rowText: string | null;
    }[]>;
}

async function evidence(label: string, details: unknown, screenshot = true) {
  await audit([HOME, ARTIFACTS]);
  const stem = join(ARTIFACTS, EVIDENCE + "-" + label);
  const file = await open(await safe(stem + ".json"), "wx");
  try {
    await file.writeFile(JSON.stringify({ capturedAt: new Date().toISOString(), phase, runId: RUN,
      sourceHashes, node: process.version, details }, null, 2), "utf8");
  } finally {
    await file.close();
  }
  if (!screenshot) return;
  // 唯一名称且先独占预留，不能覆盖其它 worker 的截图。
  const png = await open(await safe(stem + ".png"), "wx");
  await png.close();
  await browser.saveScreenshot(stem + ".png");
}

async function assertSidebar(state: ReturnType<typeof readState>) {
  await $(projectRowSelector(DEFAULT_WORKSPACE)).waitForDisplayed({ timeout: 30_000 });
  const rows = await readSidebar();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({ projectId: state.projects[0]!.project_id,
    name: "ZCodeProject", rowVisible: true, rowText: expect.stringContaining("ZCodeProject") });
  return rows;
}

describe("BUG004 Desktop 首次旧项目迁移", () => {
  before(async () => {
    if (process.platform !== "win32" || process.env.ZCODE_E2E_RUN_ID !== RUN)
      throw new Error("B4UI requires its reviewed Windows run");
    for (const name of ["ZCODE_E2E_HOME_DIR", "ZCODE_DESKTOP_HOME_DIR", "ZCODE_DATA_BASE_DIR", "HOME", "USERPROFILE"])
      if (process.env[name] !== HOME) throw new Error("B4UI mismatched isolated HOME");
    if (process.env.ZCODE_E2E_ARTIFACT_DIR !== ARTIFACTS || Object.keys(process.env).some(name => name.startsWith("QA_BOOTSTRAP_")) ||
        process.argv.some(arg => arg.includes("qa-project-bootstrap")))
      throw new Error("B4UI rejects project bootstrap or mismatched evidence root");
    for (const name of ["TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "XDG_CACHE_HOME", "COREPACK_HOME", "TSX_CACHE_DIR", "npm_config_cache", "npm_config_store_dir", "NODE_COMPILE_CACHE"])
      await safe(process.env[name] ?? "");
    await audit([HOME, ARTIFACTS]);
    await mkdir(ARTIFACTS, { recursive: true });
    for (const path of ["packages/desktop/wdio.conf.ts", "packages/desktop/test/e2e/helpers/e2e-before-session.ts",
      "packages/desktop/src/host/database-startup/tasksStorageWorker.ts", "packages/services/src/project-storage/startup.ts",
      "packages/services/src/project-storage/index.ts", "docs/testing/qa-2026-11-06/manual-review/pending/qa-bug004-desktop-migration-20261107.test.ts"]) {
      sourceHashes[path] = createHash("sha256").update(await readFile(await safe(join(ROOT, path)))).digest("hex");
    }
  });

  it("B4UI01：启动前旧设置经真实 Worker 生成项目和侧栏", async function () {
    this.timeout(90_000);
    phase = "first-start";
    await waitForDefaultWorkspaceReady(45_000);
    firstMain = await readMainIdentity();
    expect(firstMain.homeMatches && firstMain.dataMatches && firstMain.runMatches).toBe(true);
    await audit([firstMain.userDataDir, HOME, ARTIFACTS]);
    first = readState();
    expect(first.projects).toHaveLength(1);
    expect(first.projects[0]).toMatchObject({ host_id: "local", name: "ZCodeProject", position: 0, deleted: 0 });
    expect(first.roots).toEqual([{ project_id: first.projects[0]!.project_id, root_path: DEFAULT_WORKSPACE, position: 0, is_primary: 1 }]);
    expect(first.projectLedger.map(row => row.id)).toEqual(["0005_projects", "0006_default_workspace_tasks", "0007_initial_workspace_order", "0008_remote_entry_deleted_cache", "0009_session_creation_commands"]);
    expect(first.projectLedger.find(row => row.id === "0005_projects")?.checksum).toBe(CHECKSUM);
    expect(first.foreignKeyErrors).toEqual([]);
    const sidebar = await assertSidebar(first);
    await evidence("first-start", { main: firstMain, state: first, sidebar,
      persistedSettingsSha256: createHash("sha256").update(await readFile(await safe(SETTINGS))).digest("hex"),
      fixtureOwner: "wdio.beforeSession/resetE2EHome/seedE2EStartupState; no test-side project seeding" });
    firstPassed = true;
  });

  it("B4UI02：完整冷重开保留项目 ID、roots、顺序和账本", async function () {
    this.timeout(90_000);
    if (!firstPassed || !first || !firstMain) throw new Error("B4UI02 blocked by incomplete first-start assertion");
    phase = "cold-restart";
    const userData = await reloadElectronSessionPreservingBrowserProfile(browser, {
      // 保留原自然退出上限；本候选不把强制杀进程成功冒充正常退出持久化。
      cleanupTimedOutProcessTreePids: () => { throw new Error("B4UI natural process exit barrier failed; no forced cleanup"); },
      afterElectronProcessExit: async () => {
        await evidence("old-process-exited", { state: readState() }, false);
      },
    });
    await waitForDefaultWorkspaceReady(45_000);
    const main = await readMainIdentity();
    expect(main.pid).not.toBe(firstMain.pid);
    expect(main.homeMatches && main.dataMatches && main.runMatches).toBe(true);
    expect(main.userDataDir).toBe(firstMain.userDataDir);
    expect(userData).toBe(firstMain.userDataDir);
    await audit([main.userDataDir, HOME, ARTIFACTS]);
    const state = readState();
    expect(state).toEqual(first);
    const sidebar = await assertSidebar(state);
    await evidence("cold-reopened", { oldMain: firstMain, main, state, sidebar });
    phase = "complete";
  });

  afterEach(async function () {
    if (this.currentTest?.state !== "failed") return;
    let state: unknown;
    try { await safe(DATABASE); state = readState(); } catch { state = { unavailable: true }; }
    await evidence("failure-" + Date.now(), { state, failedCase: this.currentTest.title });
  });
});
