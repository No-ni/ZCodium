import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  DEFAULT_WORKSPACE,
  waitForWorkspaceApp,
} from "../../../../../packages/desktop/test/e2e/helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "../../../../../packages/desktop/test/e2e/helpers/v4-conversation.js";
import { restartIntoWorkspacePreservingProfile } from "../../../../../packages/desktop/test/e2e/helpers/model-provider-restart-runtime.js";
import { getUpstreamRequestRecordCount } from "../../../../../packages/desktop/test/e2e/helpers/conversation-session-network.js";
import { clickVisibleControl, closeVisibleMenus } from "../../qa-menu-dom.js";

// 本轮QA：旧布局采集器收起组后失败，后续行操作未执行；明确展开自己的组再补行操作。
const ROOT = resolve(fileURLToPath(new URL("../../../../../", import.meta.url)));
const RUN = "qa-menu-20261106-archive-actions-final";
const PREFIX = "qa-archive-actions-" + process.pid + "-" + Date.now();
const PROJECT = PREFIX + "-project";
const IDS = [PREFIX + "-restore", PREFIX + "-delete", PREFIX + "-keep"] as const;
const NAMES = ["E2E_QAR_RESTORE", "E2E_QAR_DELETE", "E2E_QAR_KEEP"] as const;
const CONFIRM = '[data-confirm-intent="archive-management-delete"]';
let home: string;
let artifacts: string;
let hostDatabase: string;
let cliDatabase: string;
let sequence = 0;
let baselineRequests = 0;
let sourceSha256 = "";
let firstCaseCompleted = false;
const exec = promisify(execFile);

async function safe(candidate: string): Promise<string> {
  if (!isAbsolute(candidate)) throw new Error("QAR requires absolute path");
  const target = resolve(candidate);
  const rel = relative(ROOT, target);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
    throw new Error("QAR outside worktree");
  for (let cursor = target; ; cursor = dirname(cursor)) {
    try {
      if (
        (await lstat(cursor)).isSymbolicLink() ||
        (await realpath(cursor)).toLowerCase() !== cursor.toLowerCase()
      )
        throw new Error("QAR reparse/redirected ancestor");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (cursor.toLowerCase() === ROOT.toLowerCase()) break;
  }
  return target;
}
async function audit(targets: string[]) {
  for (const target of targets) await safe(target);
  const guard = await readFile(
    await safe(join(ROOT, "docs/testing/qa-2026-11-06/qa-reparse-children.ps1")),
    "utf8",
  );
  const script = guard + `
    $ErrorActionPreference='Stop';$paths=ConvertFrom-Json $env:QAR_AUDIT_PATHS;
    foreach($target in $paths){$cursor=[IO.Path]::GetFullPath($target);
      while($cursor){if(Test-Path -LiteralPath $cursor){if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'QAR reparse ancestor'}};$cursor=[IO.Path]::GetDirectoryName($cursor)}
      if(Test-Path -LiteralPath $target -PathType Container){$queue=[Collections.Generic.Queue[string]]::new();$queue.Enqueue($target);
        while($queue.Count){foreach($item in Get-QaAuditChildren $queue.Dequeue()){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'QAR reparse descendant'};if($item.PSIsContainer){$queue.Enqueue($item.FullName)}}}}
    }`;
  await exec("C:\\Program Files\\PowerShell\\7\\pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, QAR_AUDIT_PATHS: JSON.stringify(targets), QA_REPARSE_WORKTREE: ROOT },
    windowsHide: true,
    timeout: 30_000,
  });
}
function row(id: string) {
  return $(`[data-testid="archive-task"][data-task-id="${id}"]`);
}
function group() {
  return $(`[data-testid="archive-group"][data-project-id="${PROJECT}"][data-host-id="local"]`);
}
function readStates() {
  const db = new DatabaseSync(hostDatabase, { readOnly: true });
  const cli = new DatabaseSync(cliDatabase, { readOnly: true });
  try {
    return IDS.map((id) => ({
      id,
      host: db.prepare("SELECT archived,cli_deleted,project_id FROM tasks WHERE task_id=?").get(id) as
        | { archived: number; cli_deleted: number; project_id: string }
        | undefined,
      cli: cli.prepare("SELECT time_deleted FROM session WHERE id=?").get(id) as
        | { time_deleted: number | null }
        | undefined,
    }));
  } finally {
    db.close();
    cli.close();
  }
}
function seedOwnArchivedTasks() {
  const db = new DatabaseSync(hostDatabase);
  const cli = new DatabaseSync(cliDatabase);
  try {
    for (const id of IDS) {
      if (db.prepare("SELECT task_id FROM tasks WHERE task_id=?").get(id) || cli.prepare("SELECT id FROM session WHERE id=?").get(id))
        throw new Error("QAR refuses existing task identity");
    }
    if (db.prepare("SELECT project_id FROM projects WHERE project_id=?").get(PROJECT))
      throw new Error("QAR refuses existing project identity");
    const now = Date.now();
    db.prepare("INSERT INTO projects(project_id,host_id,name,position,deleted,created_at,updated_at) VALUES(?,'local',?,999,0,?,?)").run(PROJECT, PREFIX, now, now);
    db.prepare("INSERT INTO project_roots(project_id,root_path,position,is_primary) VALUES(?,?,0,1)").run(PROJECT, DEFAULT_WORKSPACE);
    for (const [index, id] of IDS.entries()) {
      const title = NAMES[index]!;
      cli.prepare("INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated,title_source,last_outcome) VALUES(?,?,?,?,?,'1',?,?,'custom','completed')").run(id, PREFIX + "-cli", id, DEFAULT_WORKSPACE, title, now + index, now + index);
      db.prepare("INSERT INTO tasks(workspace_key,workspace_path,task_id,title,provider,created_at,updated_at,host_id,root_path,project_id,archived,cli_title,cli_title_source,cli_created_at,cli_updated_at,cli_last_outcome,cli_deleted,meta_json) VALUES(?,?,?,?,'glm',?,?,'local',?,?,1,?,'custom',?,?,'completed',0,?)").run(
        DEFAULT_WORKSPACE, DEFAULT_WORKSPACE, id, title, now + index, now + index,
        DEFAULT_WORKSPACE, PROJECT, title, now + index, now + index,
        JSON.stringify({ taskId: id, traceId: id, title, workspacePath: DEFAULT_WORKSPACE, createdAt: now + index, updatedAt: now + index, mode: "default", archived: true }),
      );
    }
  } finally {
    db.close();
    cli.close();
  }
}
async function openArchives() {
  await closeVisibleMenus("QAR");
  if (!(await $('[data-testid="settings-section-nav-archives"]').isDisplayed()))
    await clickVisibleControl('[data-testid="task-settings-button"]', undefined, "QAR");
  await clickVisibleControl('[data-testid="settings-section-nav-archives"]', undefined, "QAR");
  await $('[data-testid="archive-management"]').waitForDisplayed();
  await $('[data-testid="archive-search"]').setValue("E2E_QAR_");
  await group().waitForDisplayed();
  const toggle = group().$('[data-testid="archive-group-toggle"]');
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await browser.waitUntil(() => browser.execute(`
    const group=document.querySelector('[data-testid="archive-group"][data-project-id="'+arguments[0]+'"]');
    return Boolean(group) && !group.getAnimations({subtree:true}).some(animation=>animation.playState==='running');
  `, PROJECT));
}
async function capture(label: string, error?: unknown) {
  const stem = await safe(join(artifacts, PREFIX + "-" + String(++sequence).padStart(3, "0") + "-" + label));
  const snapshot = await browser.execute(`
    const root=document.querySelector('[data-testid="archive-management"]');
    return {managementPresent:Boolean(root), groups:[...document.querySelectorAll('[data-testid="archive-group"]')].map(group=>({projectId:group.getAttribute('data-project-id'),hostId:group.getAttribute('data-host-id'),expanded:group.querySelector('[data-testid="archive-group-toggle"]')?.getAttribute('aria-expanded'),taskIds:[...group.querySelectorAll('[data-testid="archive-task"]')].map(row=>row.getAttribute('data-task-id'))})),confirmPresent:Boolean(document.querySelector('[data-confirm-intent="archive-management-delete"]')),status:[...(root?.querySelectorAll('[role="status"],[role="alert"]')||[])].map(item=>item.textContent)};
  `);
  await writeFile(stem + ".json", JSON.stringify({ capturedAt: new Date().toISOString(), sourceSha256, label, error: error instanceof Error ? { message: error.message, stack: error.stack } : error ?? null, snapshot, states: readStates(), requests: await getUpstreamRequestRecordCount() }, null, 2), { flag: "wx" });
  const reserved = await open(stem + ".png", "wx");
  await reserved.close();
  await browser.saveScreenshot(stem + ".png");
}
describe("本轮归档行操作补测", () => {
  before(async function () {
    this.timeout(120_000);
    if (process.platform !== "win32" || process.env.ZCODE_E2E_RUN_ID !== RUN || process.env.E2E_PROVIDER_HTTP_MODE !== "replay")
      throw new Error("QAR requires reviewed isolated Windows replay run");
    const runtime = await safe(join(ROOT, "docs/testing/qa-2026-11-06/runtime", RUN));
    home = await safe(process.env.ZCODE_E2E_HOME_DIR!);
    artifacts = await safe(process.env.ZCODE_E2E_ARTIFACT_DIR!);
    for (const candidate of [home, artifacts, DEFAULT_WORKSPACE]) {
      const rel = relative(runtime, candidate);
      if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
        throw new Error("QAR refuses another runtime");
    }
    hostDatabase = await safe(join(home, ".zcodium/v2/tasks-index.sqlite"));
    cliDatabase = await safe(join(home, ".zcodium/cli/db/db.sqlite"));
    await audit([home, artifacts, DEFAULT_WORKSPACE]);
    await mkdir(artifacts, { recursive: true });
    sourceSha256 = createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex");
    await prepareV4ConversationE2E({ skipProvider: true });
    baselineRequests = await getUpstreamRequestRecordCount();
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: async () => {
        await audit([home, DEFAULT_WORKSPACE, hostDatabase, cliDatabase]);
        seedOwnArchivedTasks();
      },
    });
    await waitForWorkspaceApp(DEFAULT_WORKSPACE);
    await openArchives();
    await capture("seed-ready");
  });
  afterEach(async function () {
    if (!artifacts || !hostDatabase || !cliDatabase) return;
    await capture(this.currentTest?.title.startsWith("QAR01") ? "QAR01" : "QAR02", this.currentTest?.err);
  });
  it("QAR01: 明确展开本树合成组后取消归档保持CLI会话", async () => {
    await openArchives();
    await row(IDS[0]).waitForDisplayed();
    await row(IDS[0]).$('[data-testid="archive-unarchive"]').click();
    await row(IDS[0]).waitForExist({ reverse: true });
    await browser.waitUntil(async () => readStates()[0]?.host?.archived === 0);
    const states = readStates();
    expect(states[0]?.host).toMatchObject({ archived: 0, cli_deleted: 0, project_id: PROJECT });
    expect(states[0]?.cli).toBeDefined();
    expect(states[0]?.cli?.time_deleted ?? null).toBeNull();
    for (const state of states.slice(1)) expect(state.host).toMatchObject({ archived: 1, cli_deleted: 0 });
    expect(await getUpstreamRequestRecordCount()).toBe(baselineRequests);
    firstCaseCompleted = true;
  });
  it("QAR02: 删除取消不改库、确认仅删除一条且冷重启不复活", async function () {
    this.timeout(120_000);
    if (!firstCaseCompleted) throw new Error("QAR02 requires successful QAR01 own restore");
    await openArchives();
    await row(IDS[1]).waitForDisplayed();
    const before = readStates();
    await row(IDS[1]).$('[data-testid="archive-delete"]').click();
    await $(CONFIRM).waitForDisplayed();
    await browser.keys("Escape");
    await $(CONFIRM).waitForExist({ reverse: true });
    expect(readStates()).toEqual(before);
    await row(IDS[1]).$('[data-testid="archive-delete"]').waitForClickable();
    await capture("QAR02-cancelled");
    await row(IDS[1]).$('[data-testid="archive-delete"]').click();
    await $(CONFIRM).waitForDisplayed();
    await $(CONFIRM).$('[data-testid="confirm-dialog-confirm"]').click();
    await $(CONFIRM).waitForExist({ reverse: true });
    await row(IDS[1]).waitForExist({ reverse: true });
    await browser.waitUntil(async () => readStates()[1]?.host?.cli_deleted === 1);
    expect(readStates()[1]?.cli?.time_deleted).toBeGreaterThan(0);
    await capture("QAR02-deleted");
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    await openArchives();
    expect(await row(IDS[1]).isExisting()).toBe(false);
    expect(await row(IDS[0]).isExisting()).toBe(false);
    await row(IDS[2]).waitForDisplayed();
    const states = readStates();
    expect(states[0]?.host).toMatchObject({ archived: 0, cli_deleted: 0 });
    expect(states[1]?.host?.cli_deleted).toBe(1);
    expect(states[1]?.cli?.time_deleted).toBeGreaterThan(0);
    expect(states[2]?.host).toMatchObject({ archived: 1, cli_deleted: 0 });
    expect(await getUpstreamRequestRecordCount()).toBe(baselineRequests);
  });
});
