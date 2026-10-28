import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  rename,
  lstat,
  mkdir,
  readFile,
  readdir,
  stat,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import {
  assertProjectPath,
  createProjectTestFixture,
  projectRoot,
} from "../project-test-sandbox.mjs";
const { createNodeSourceServerWorkspaceService, WorkspaceAliasError } = await tsImport(
  "../../../packages/services/src/source-server-workspace/node.ts",
  import.meta.url,
);
const { TASKS_DATABASE_MIGRATIONS } = await tsImport(
  "../../../packages/services/src/session/tasksDatabase/migrations.ts",
  import.meta.url,
);
const { SESSION_DATABASE_MIGRATIONS } = await tsImport(
  "../../../apps/zcode-cli/packages/adapters/src/storage/session-store/migration-contract.ts",
  import.meta.url,
);
const { migrate } = await tsImport(
  "../../../packages/shared/src/sqlite-migrations/index.ts",
  import.meta.url,
);
const { readDatabase, databaseDigest, databaseImage } = await tsImport(
  "../../../packages/services/src/source-server-workspace/adapters/database.ts",
  import.meta.url,
);
const { openSafe } = await tsImport(
  "../../../packages/services/src/source-server-workspace/adapters/files.ts",
  import.meta.url,
);
const scope = { sourceServerId: "fixture_source", workspacePath: "/fixture/project" };
// Node 受限 symlink/link API 需原生工具；只写已验证的 fixture 链接。
const sandboxEnv = { ...process.env };
const privateRoots = [projectRoot, sandboxEnv.PROJECT_TEST_SANDBOX_ROOT].filter(Boolean);
const maskPaths = (value) =>
  privateRoots.reduce((text, root) => text.split(root).join("<project>"), value);
async function createLinkMedia(kind, target, path) {
  const command =
    process.platform === "win32"
      ? {
          file: "cmd.exe",
          args:
            kind === "hardlink"
              ? ["/d", "/c", "mklink", "/H", path, target]
              : kind === "junction"
                ? ["/d", "/c", "mklink", "/J", path, target]
                : kind === "filelink"
                  ? ["/d", "/c", "mklink", path, target]
                  : null,
        }
      : {
          file: "ln",
          args:
            kind === "hardlink"
              ? [target, path]
              : kind === "junction" || kind === "dir" || kind === "filelink"
                ? ["-s", target, path]
                : null,
        };
  if (!command || !command.args) throw new Error(`unknown link media: ${kind}`);
  await assertProjectPath(target);
  await assertProjectPath(path);
  const original = await lstat(target, { bigint: true });
  if (original.isSymbolicLink() || !(original.isFile() || original.isDirectory()))
    throw new Error("link media target must be a regular file or directory");
  const absent = await lstat(path, { bigint: true }).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (absent) throw new Error("link media must start absent");
  await new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      cwd: dirname(target),
      env: sandboxEnv,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) =>
      reject(new Error(`link media spawn failed: ${error.code ?? error.name}`)),
    );
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`link media child exit ${code}: ${maskPaths(stderr).slice(0, 200)}`)),
    );
  });
  if (kind === "hardlink") {
    const held = await stat(target, { bigint: true });
    const made = await stat(path, { bigint: true });
    if (!made.isFile() || made.dev !== held.dev || made.ino !== held.ino || made.nlink < 2n)
      throw new Error("link media identity check failed");
  } else {
    const made = await lstat(path, { bigint: true });
    if (!made.isSymbolicLink()) throw new Error("link media identity check failed");
    await realpath(path);
  }
}
const old1 = "remote:ssh:fixture:22:user:/fixture/project";
const old2 = "remote:wsl:fixture:/fixture/project";
const other = "remote:ssh:other:22:user:/fixture/project";
const keyHash = (key) => createHash("sha256").update(key).digest("hex").slice(0, 12);
async function fixture(t, options = {}) {
  // 唯一环境 owner：合成库写在本次项目内 sandbox，连接关闭后保留，不递归删除运行根。
  const temp = await createProjectTestFixture("workspace-alias");
  const root = join(temp, ".zcodium");
  const hostPath = join(root, "v2", "tasks-index.sqlite");
  const cliPath = join(root, "cli", "db", "db.sqlite");
  await mkdir(join(root, "v2", "sessions"), { recursive: true });
  await mkdir(join(root, "cli", "db"), { recursive: true });
  const host = new DatabaseSync(hostPath);
  const cli = new DatabaseSync(cliPath);
  t.after(async () => {
    if (host.isOpen) host.close();
    if (cli.isOpen) cli.close();
  });
  await migrate(host, TASKS_DATABASE_MIGRATIONS, {
    database: "tasks-index",
    journalTable: "tasks_schema_migration",
    backupDirectories: [join(root, "backup")],
  });
  await migrate(cli, SESSION_DATABASE_MIGRATIONS, {
    database: "cli",
    backupDirectories: [join(root, "backup")],
  });
  let generation = 1;
  let leases = 0;
  const authority = {
    async inspect(request) {
      return {
        sourceServerId: request.sourceServerId,
        generation,
        legacyWorkspaceKeys: [old1, old2],
        projectId: "fixture-project",
      };
    },
    async acquireStoppedWriters() {
      leases++;
      return {
        async assertCurrent() {},
        async release() {
          leases--;
        },
      };
    },
  };
  const create = (overrides = {}) =>
    createNodeSourceServerWorkspaceService({ dataRoot: root, authority, ...options, ...overrides });
  const task = (key, id, title = id) =>
    host
      .prepare(
        "INSERT INTO tasks(workspace_key,workspace_path,workspace_identity,task_id,title,created_at,updated_at) VALUES(?,?,?,?,?,1,1)",
      )
      .run(key, scope.workspacePath, key, id, title);
  const session = (key, id, directory = scope.workspacePath) =>
    cli
      .prepare(
        "INSERT INTO session(id,project_id,workspace_id,slug,directory,title,version,time_created,time_updated) VALUES(?,?,?,?,?,?,?,1,1)",
      )
      .run(id, "keep-project", key, id, directory, id, "1");
  const config = async (key, path, content) => {
    const target = join(root, "v2", "sessions", keyHash(key), path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  };
  const images = async () => ({
    host: databaseDigest(await readDatabase(root, hostPath)),
    cli: databaseDigest(await readDatabase(root, cliPath)),
  });
  return {
    temp,
    root,
    host,
    cli,
    hostPath,
    cliPath,
    task,
    session,
    config,
    images,
    create,
    authority,
    bump: () => generation++,
    leases: () => leases,
  };
}
async function approve(service, choices) {
  const preview = await service.preview(scope);
  return service.confirm({
    ...scope,
    sourceGeneration: preview.sourceGeneration,
    candidateVersion: preview.candidateVersion,
    planHash: preview.planHash,
    confirmationToken: preview.confirmationToken,
    canonicalKey: preview.canonicalKey,
    choices:
      choices ??
      preview.collisions.map((collision) => ({
        collisionId: collision.collisionId,
        sourceKey: collision.sources[0].workspaceKey,
      })),
    acknowledgeMerge: true,
  });
}

test("preview/getter are read-only, single legacy key stays canonical and no alias tables appear", async (t) => {
  const f = await fixture(t);
  f.task(old1, "one");
  f.session(old1, "one");
  await f.config(old1, "configs/settings.json", "fixture");
  const before = await f.images();
  const names = await readdir(join(f.root, "v2"));
  const service = f.create();
  const preview = await service.preview(scope);
  const result = await service.getResolvedWorkspace(scope);
  assert.equal(preview.state, "single");
  assert.equal(preview.canonicalKey, old1);
  assert.equal(result.persisted, false);
  assert.equal(result.state, "ready");
  assert.deepEqual(await f.images(), before);
  assert.deepEqual(await readdir(join(f.root, "v2")), names);
});
test("multiple verified variants require explicit confirmation; unrelated same-path Source is excluded", async (t) => {
  const f = await fixture(t);
  f.task(old1, "one");
  f.task(old2, "two");
  f.task(other, "other");
  const preview = await f.create().preview(scope);
  assert.equal(preview.state, "confirmation-required");
  assert.deepEqual(
    preview.candidates.map((item) => item.workspaceKey),
    [old1, old2].sort(),
  );
  assert.ok(preview.excludedKeys.includes(other));
  assert.equal(f.host.prepare("SELECT count(*) AS n FROM tasks").get().n, 3);
});
test("explicit confirmed merge covers Host groups/orders/automations, CLI session and configs; alias publishes last", async (t) => {
  const f = await fixture(t);
  f.task(old1, "one");
  f.task(old2, "two");
  f.task(other, "other");
  f.session(old1, "one");
  f.session(old2, "two", old2);
  f.host.exec("INSERT INTO task_groups VALUES('group','Fixture','gray',1,1)");
  f.host
    .prepare("INSERT INTO task_group_members VALUES(?,?,?,?,?,0,1,1,1)")
    .run("group", old2, scope.workspacePath, old2, "two");
  f.host.prepare("INSERT INTO task_group_workspace_bootstraps VALUES(?,'group',1,1)").run(old2);
  f.host
    .prepare("INSERT INTO task_group_view_node_orders VALUES('task',?,0,1,1)")
    .run(JSON.stringify([old2, "two"]));
  f.host
    .prepare(
      "INSERT INTO automations(automation_id,cron_expr,prompt,workspace_key,workspace_path,workspace_identity,created_at,updated_at) VALUES('automation','0 * * * *','Fixture',?,?,?,1,1)",
    )
    .run(old2, scope.workspacePath, old2);
  f.host
    .prepare(
      "INSERT INTO automation_runs(run_id,automation_id,workspace_key,dispatch_status,outcome,created_at,updated_at) VALUES('run','automation',?,'dispatched','completed',1,1)",
    )
    .run(old2);
  await f.config(old1, "configs/a.json", "one");
  await f.config(old2, "configs/b.json", "two");
  const phases = [];
  const service = f.create({ afterPhaseCommitted: (phase) => phases.push(phase) });
  const approved = await approve(service);
  const readyBefore = await service.getResolvedWorkspace(scope);
  assert.equal(readyBefore.state, "blocked");
  const result = await service.execute({
    jobId: approved.jobId,
    expectedRevision: approved.revision,
  });
  assert.equal(result.status, "completed");
  assert.equal(phases.at(-1), "completed");
  const canonical = result.canonicalKey;
  assert.deepEqual(
    f.host
      .prepare("SELECT workspace_key FROM tasks WHERE task_id IN ('one','two')")
      .all()
      .map((row) => row.workspace_key),
    [canonical, canonical],
  );
  assert.equal(
    f.host.prepare("SELECT workspace_key FROM tasks WHERE task_id='other'").get().workspace_key,
    other,
  );
  for (const table of [
    "task_group_members",
    "task_group_workspace_bootstraps",
    "automations",
    "automation_runs",
  ])
    assert.equal(
      f.host.prepare(`SELECT workspace_key FROM ${table}`).get().workspace_key,
      canonical,
    );
  assert.equal(
    f.host.prepare("SELECT node_key FROM task_group_view_node_orders").get().node_key,
    JSON.stringify([canonical, "two"]),
  );
  assert.equal(
    f.cli.prepare("SELECT project_id FROM session WHERE id='one'").get().project_id,
    "keep-project",
  );
  assert.equal(
    f.cli.prepare("SELECT project_id FROM session WHERE id='two'").get().project_id,
    "fixture-project",
  );
  assert.equal(
    f.cli.prepare("SELECT directory FROM session WHERE id='two'").get().directory,
    scope.workspacePath,
  );
  const target = join(f.root, "v2", "sessions", keyHash(canonical), "configs");
  assert.equal(await readFile(join(target, "a.json"), "utf8"), "one");
  assert.equal(await readFile(join(target, "b.json"), "utf8"), "two");
  assert.equal((await service.getResolvedWorkspace(scope)).persisted, true);
  assert.equal(f.leases(), 0);
});
test("task/config collisions block unchosen confirmation and only explicit source wins", async (t) => {
  const f = await fixture(t);
  f.task(old1, "same", "one");
  f.task(old2, "same", "two");
  await f.config(old1, "configs/choice.json", "one");
  await f.config(old2, "configs/choice.json", "two");
  const service = f.create();
  const preview = await service.preview(scope);
  assert.equal(preview.collisions.length, 2);
  await assert.rejects(
    service.confirm({
      ...scope,
      ...Object.fromEntries(
        [
          "sourceGeneration",
          "candidateVersion",
          "planHash",
          "confirmationToken",
          "canonicalKey",
        ].map((key) => [key, preview[key]]),
      ),
      acknowledgeMerge: true,
      choices: [],
    }),
    (error) => error.code === "collision-unresolved",
  );
  const approved = await approve(
    service,
    preview.collisions.map((collision) => ({
      collisionId: collision.collisionId,
      sourceKey: old2,
    })),
  );
  const result = await service.execute({
    jobId: approved.jobId,
    expectedRevision: approved.revision,
  });
  assert.equal(f.host.prepare("SELECT title FROM tasks").get().title, "two");
  assert.equal(f.host.prepare("SELECT count(*) AS n FROM tasks").get().n, 1);
  assert.equal(
    await readFile(
      join(f.root, "v2", "sessions", keyHash(result.canonicalKey), "configs", "choice.json"),
      "utf8",
    ),
    "two",
  );
});
test("changed data, Source generation and forged confirmation reject before business writes", async (t) => {
  const f = await fixture(t);
  f.task(old1, "one");
  f.task(old2, "two");
  const service = f.create();
  const preview = await service.preview(scope);
  const request = {
    ...scope,
    ...Object.fromEntries(
      ["sourceGeneration", "candidateVersion", "planHash", "confirmationToken", "canonicalKey"].map(
        (key) => [key, preview[key]],
      ),
    ),
    acknowledgeMerge: true,
    choices: [],
  };
  f.task(old1, "late");
  await assert.rejects(service.confirm(request), (error) => error.code === "plan-stale");
  f.bump();
  await assert.rejects(service.confirm(request), (error) => error.code === "plan-stale");
  await assert.rejects(
    service.confirm({ ...request, confirmationToken: request.confirmationToken + "x" }),
    (error) => error.code === "plan-stale",
  );
  assert.equal(f.host.prepare("SELECT count(*) AS n FROM tasks").get().n, 3);
});
test("running task owner blocks merge without cancellation or alias publication", async (t) => {
  const f = await fixture(t);
  f.task(old1, "one");
  f.task(old2, "two");
  f.host.exec("UPDATE tasks SET task_status='running' WHERE task_id='two'");
  const preview = await f.create().preview(scope);
  assert.equal(preview.state, "blocked");
  assert.ok(preview.blocks.some((block) => block.code === "active-owner"));
  assert.equal(
    f.host.prepare("SELECT task_status FROM tasks WHERE task_id='two'").get().task_status,
    "running",
  );
});
test("backup permission/space fault blocks every business stage and remains reportable", async (t) => {
  const f = await fixture(t);
  f.task(old1, "one");
  f.task(old2, "two");
  f.session(old2, "two");
  const before = await f.images();
  const service = f.create({
    beforeBackup: () => {
      throw Object.assign(new Error("fixture"), { code: "ENOSPC" });
    },
  });
  const approved = await approve(service);
  await assert.rejects(
    service.execute({ jobId: approved.jobId, expectedRevision: approved.revision }),
    (error) => error.code === "storage-full",
  );
  assert.deepEqual(await f.images(), before);
  assert.equal((await service.report(approved.jobId)).status, "failed");
});
test("durable phase retry survives Host commit and does not redo or choose a new plan", async (t) => {
  const f = await fixture(t);
  f.task(old1, "one");
  f.task(old2, "two");
  f.session(old2, "two");
  let fail = true;
  const service = f.create({
    afterPhaseCommitted: (phase) => {
      if (phase === "host-merged" && fail) {
        fail = false;
        throw new Error("fixture crash");
      }
    },
  });
  const approved = await approve(service);
  await assert.rejects(
    service.execute({ jobId: approved.jobId, expectedRevision: approved.revision }),
  );
  const failed = await service.report(approved.jobId);
  assert.equal(failed.phase, "host-merged");
  const retried = await f
    .create()
    .retry({ jobId: approved.jobId, expectedRevision: failed.revision });
  assert.equal(retried.status, "completed");
  assert.equal(f.host.prepare("SELECT count(*) AS n FROM tasks").get().n, 2);
});
test("explicit restore reverses rows/configs/alias and refuses later writes", async (t) => {
  const f = await fixture(t);
  f.task(old1, "one");
  f.task(old2, "two");
  f.session(old2, "two");
  await f.config(old1, "configs/a", "one");
  await f.config(old2, "configs/b", "two");
  const before = await f.images();
  const service = f.create();
  const approved = await approve(service);
  const completed = await service.execute({
    jobId: approved.jobId,
    expectedRevision: approved.revision,
  });
  f.host.exec("UPDATE tasks SET title='later' WHERE task_id='one'");
  await assert.rejects(
    service.restore({
      jobId: completed.jobId,
      expectedRevision: completed.revision,
      writersStopped: true,
    }),
    (error) => error.code === "state-diverged",
  );
  assert.equal(f.host.prepare("SELECT title FROM tasks WHERE task_id='one'").get().title, "later");
  f.host.exec("UPDATE tasks SET title='one' WHERE task_id='one'");
  const rejected = await service.report(completed.jobId);
  const restored = await service.restore({
    jobId: completed.jobId,
    expectedRevision: rejected.revision,
    writersStopped: true,
  });
  assert.equal(restored.phase, "restored");
  assert.deepEqual(await f.images(), before);
  assert.equal(
    await readFile(join(f.root, "v2", "sessions", keyHash(old2), "configs/b"), "utf8"),
    "two",
  );
  assert.equal((await service.getResolvedWorkspace(scope)).persisted, false);
});
test(".zcode and symlink-escaped config roots are never read or migrated", async (t) => {
  const f = await fixture(t);
  f.task(old1, "one");
  await assert.rejects(
    async () => f.create({ dataRoot: join(f.temp, ".zcode") }).preview(scope),
    (error) => error.code === "boundary-rejected",
  );
  const outside = join(f.temp, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "private"), "fixture");
  const link = join(f.root, "v2", "sessions", keyHash(old1));
  await createLinkMedia("junction", outside, link);
  await assert.rejects(f.create().preview(scope), (error) => error.code === "boundary-rejected");
});

test("single running legacy workspace only publishes alias without changing any business rows", async (t) => {
  const f = await fixture(t);
  f.task(old1, "one");
  f.session(old1, "one");
  f.host.exec("UPDATE tasks SET task_status='running' WHERE task_id='one'");
  const before = await f.images();
  const service = f.create();
  const preview = await service.preview(scope);
  assert.equal(preview.state, "single");
  const approved = await approve(service);
  const result = await service.execute({
    jobId: approved.jobId,
    expectedRevision: approved.revision,
  });
  assert.equal(result.canonicalKey, old1);
  assert.deepEqual(await f.images(), before);
  assert.equal((await service.getResolvedWorkspace(scope)).persisted, true);
});

test("NULL CLI workspace ownership uses exact Host task allowlist, not same-path bulk adoption", async (t) => {
  const f = await fixture(t);
  f.task(old1, "one");
  f.task(old2, "two");
  f.session(null, "one");
  f.session(null, "not-owned");
  f.session(old2, "two");
  const service = f.create();
  const approved = await approve(service);
  const completed = await service.execute({
    jobId: approved.jobId,
    expectedRevision: approved.revision,
  });
  assert.equal(
    f.cli.prepare("SELECT workspace_id FROM session WHERE id='one'").get().workspace_id,
    completed.canonicalKey,
  );
  assert.equal(
    f.cli.prepare("SELECT workspace_id FROM session WHERE id='not-owned'").get().workspace_id,
    null,
  );
});

test("later CLI data after backup blocks before the Host stage and preserves old Host rows", async (t) => {
  const f = await fixture(t);
  f.task(old1, "one");
  f.task(old2, "two");
  f.session(old2, "two");
  const before = await f.images();
  let fail = true;
  const service = f.create({
    afterPhaseCommitted: (phase) => {
      if (phase === "backups-created" && fail) {
        fail = false;
        throw new Error("fixture");
      }
    },
  });
  const approved = await approve(service);
  await assert.rejects(
    service.execute({ jobId: approved.jobId, expectedRevision: approved.revision }),
  );
  f.session(other, "late");
  const failed = await service.report(approved.jobId);
  await assert.rejects(
    f.create().retry({ jobId: approved.jobId, expectedRevision: failed.revision }),
    (error) => error.code === "state-diverged",
  );
  assert.equal((await f.images()).host, before.host);
  assert.equal(f.cli.prepare("SELECT count(*) AS n FROM session WHERE id='late'").get().n, 1);
});

test("backup destination failure is real filesystem IO and creates no Host or CLI postimage", async (t) => {
  const f = await fixture(t);
  f.task(old1, "one");
  f.task(old2, "two");
  f.session(old2, "two");
  const before = await f.images();
  await writeFile(join(f.root, "v2", "workspace-alias-jobs"), "not a directory");
  const service = f.create();
  const approved = await approve(service);
  await assert.rejects(
    service.execute({ jobId: approved.jobId, expectedRevision: approved.revision }),
  );
  assert.deepEqual(await f.images(), before);
});

test("cancellation before Host COMMIT rolls back rows and permits explicit same-job retry", async (t) => {
  const f = await fixture(t);
  f.task(old1, "one");
  f.task(old2, "two");
  f.session(old2, "two");
  const before = await f.images();
  const controller = new AbortController();
  const service = f.create({
    afterPhaseCommitted: (phase) => {
      if (phase === "host-intent") controller.abort(new Error("fixture cancel"));
    },
  });
  const approved = await approve(service);
  await assert.rejects(
    service.execute(
      { jobId: approved.jobId, expectedRevision: approved.revision },
      { signal: controller.signal },
    ),
    (error) => error.code === "cancelled",
  );
  assert.deepEqual(await f.images(), before);
  const cancelled = await service.report(approved.jobId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(
    (await f.create().retry({ jobId: approved.jobId, expectedRevision: cancelled.revision }))
      .status,
    "completed",
  );
});

test("stale revisions and expired approval cannot broaden or repeat an accepted job", async (t) => {
  const f = await fixture(t);
  f.task(old1, "one");
  let clock = 1_000;
  const service = f.create({ now: () => clock, approvalTtlMs: 20 });
  const plan = await service.preview(scope);
  clock = 1_100;
  await assert.rejects(
    service.confirm({
      ...scope,
      sourceGeneration: plan.sourceGeneration,
      candidateVersion: plan.candidateVersion,
      planHash: plan.planHash,
      confirmationToken: plan.confirmationToken,
      canonicalKey: plan.canonicalKey,
      acknowledgeMerge: true,
      choices: [],
    }),
    (error) => error.code === "plan-stale",
  );
  const approved = await approve(service);
  await assert.rejects(
    service.execute({ jobId: approved.jobId, expectedRevision: approved.revision - 1 }),
    (error) => error.code === "revision-stale",
  );
});

test("restore fails closed on missing or tampered SQLite backup and keeps completed rows", async (t) => {
  const f = await fixture(t);
  f.task(old1, "one");
  f.task(old2, "two");
  const service = f.create();
  const approved = await approve(service);
  const completed = await service.execute({
    jobId: approved.jobId,
    expectedRevision: approved.revision,
  });
  const before = await f.images();
  const backupPath = join(f.root, "v2", "workspace-alias-jobs", completed.jobId, "host.sqlite");
  const copy = new DatabaseSync(backupPath);
  copy.exec("UPDATE tasks SET title='tampered'");
  copy.close();
  await assert.rejects(
    service.restore({
      jobId: completed.jobId,
      expectedRevision: completed.revision,
      writersStopped: true,
    }),
    (error) => error.code === "backup-failed",
  );
  assert.deepEqual(await f.images(), before);
});

test("same path cannot claim a canonical key already published for a different Source", async (t) => {
  const f = await fixture(t);
  f.task(old1, "one");
  const service = f.create();
  const approved = await approve(service);
  await service.execute({ jobId: approved.jobId, expectedRevision: approved.revision });
  const second = await service.preview({ ...scope, sourceServerId: "different_source" });
  assert.equal(second.state, "blocked");
  assert.ok(second.blocks.some((block) => block.code === "boundary-rejected"));
});

async function crashExecution(f, approved, crashPhase, action = "execute") {
  const url = new URL(
    "../../../packages/services/src/source-server-workspace/node.ts",
    import.meta.url,
  ).href;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    const { createNodeSourceServerWorkspaceService } = await import(process.argv[2]);
    const authority={async inspect(scope){return {sourceServerId:scope.sourceServerId,generation:1,legacyWorkspaceKeys:${JSON.stringify([old1, old2])},projectId:'fixture-project'}},async acquireStoppedWriters(){return {async assertCurrent(){},async release(){}}}};
    const service=createNodeSourceServerWorkspaceService({dataRoot:process.argv[1],authority,afterPhaseCommitted(phase){if(phase===process.argv[4])process.exit(73)}});
    await service[process.argv[5]](JSON.parse(process.argv[3]));
  `,
      f.root,
      url,
      JSON.stringify({
        jobId: approved.jobId,
        expectedRevision: approved.revision,
        ...(action === "restore" ? { writersStopped: true } : {}),
      }),
      crashPhase,
      action,
    ],
    { cwd: fileURLToPath(new URL("../../..", import.meta.url)), stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.resume();
  child.stderr.resume();
  const exited = once(child, "exit");
  tCleanupChild(child);
  const [code] = await exited;
  assert.equal(code, 73);
}
function tCleanupChild(child) {
  child.once("error", () => {
    if (child.exitCode === null) child.kill();
  });
}
for (const phase of [
  "host-committed",
  "cli-committed",
  "config-renamed",
  "config-rename",
  "completed",
])
  test(
    `actual process exit at ${phase} resumes the exact durable job without duplicate rows`,
    { timeout: 30000 },
    async (t) => {
      const f = await fixture(t);
      f.task(old1, "one");
      f.task(old2, "two");
      f.session(old1, "one");
      f.session(old2, "two");
      await f.config(old1, "configs/a", "one");
      await f.config(old2, "configs/b", "two");
      const service = f.create();
      const approved = await approve(service);
      await crashExecution(f, approved, phase);
      const state = await f.create().report(approved.jobId);
      assert.ok(state);
      const result = await f
        .create()
        .retry({ jobId: approved.jobId, expectedRevision: state.revision });
      assert.equal(result.status, "completed");
      assert.equal(f.host.prepare("SELECT count(*) AS n FROM tasks").get().n, 2);
      assert.equal(f.cli.prepare("SELECT count(*) AS n FROM session").get().n, 2);
      assert.equal((await f.create().getResolvedWorkspace(scope)).persisted, true);
    },
  );

for (const phase of [
  "restoring",
  "config-renamed",
  "config-rename",
  "restore-cli-committed",
  "restore-host-committed",
  "restored",
])
  test(
    `actual restore exit at ${phase} resumes without losing original rows or directories`,
    { timeout: 30000 },
    async (t) => {
      const f = await fixture(t);
      f.task(old1, "one");
      f.task(old2, "two");
      f.session(old1, "one");
      f.session(old2, "two");
      await f.config(old1, "configs/a", "one");
      await f.config(old2, "configs/b", "two");
      const before = await f.images();
      const service = f.create();
      const approved = await approve(service);
      const completed = await service.execute({
        jobId: approved.jobId,
        expectedRevision: approved.revision,
      });
      await crashExecution(f, completed, phase, "restore");
      const state = await f.create().report(approved.jobId);
      assert.ok(state);
      const restored = await f
        .create()
        .restore({ jobId: state.jobId, expectedRevision: state.revision, writersStopped: true });
      assert.equal(restored.status, "restored");
      assert.deepEqual(await f.images(), before);
      assert.equal(
        await readFile(join(f.root, "v2", "sessions", keyHash(old1), "configs/a"), "utf8"),
        "one",
      );
      assert.equal(
        await readFile(join(f.root, "v2", "sessions", keyHash(old2), "configs/b"), "utf8"),
        "two",
      );
      assert.equal((await f.create().getResolvedWorkspace(scope)).persisted, false);
    },
  );

test("a task collision remains confirmable for its existing CLI owner and rejects the other choice", async (t) => {
  const f = await fixture(t);
  f.task(old1, "same", "one");
  f.task(old2, "same", "two");
  f.session(old2, "same");
  const service = f.create();
  const preview = await service.preview(scope);
  assert.equal(preview.state, "confirmation-required");
  assert.equal(preview.blocks.length, 0);
  await assert.rejects(
    approve(
      service,
      preview.collisions.map((item) => ({ collisionId: item.collisionId, sourceKey: old1 })),
    ),
    (error) => error.code === "state-diverged",
  );
  const approved = await approve(
    service,
    preview.collisions.map((item) => ({ collisionId: item.collisionId, sourceKey: old2 })),
  );
  const completed = await service.execute({
    jobId: approved.jobId,
    expectedRevision: approved.revision,
  });
  assert.equal(f.host.prepare("SELECT title FROM tasks").get().title, "two");
  assert.equal(
    f.cli.prepare("SELECT workspace_id FROM session WHERE id='same'").get().workspace_id,
    completed.canonicalKey,
  );
});

for (const selected of [old1, old2])
  test(`file-directory collision obeys the selected subtree source ${selected === old1 ? "file" : "directory"}`, async (t) => {
    const f = await fixture(t);
    f.task(old1, "one");
    f.task(old2, "two");
    await f.config(old1, "configs/choice", "file");
    await f.config(old2, "configs/choice/nested", "directory");
    const before = await f.images();
    const service = f.create();
    const preview = await service.preview(scope);
    assert.equal(preview.collisions.filter((item) => item.kind === "config").length, 1);
    const approved = await approve(
      service,
      preview.collisions.map((item) => ({ collisionId: item.collisionId, sourceKey: selected })),
    );
    const completed = await service.execute({
      jobId: approved.jobId,
      expectedRevision: approved.revision,
    });
    const target = join(
      f.root,
      "v2",
      "sessions",
      keyHash(completed.canonicalKey),
      "configs/choice",
    );
    assert.equal(
      await readFile(selected === old1 ? target : join(target, "nested"), "utf8"),
      selected === old1 ? "file" : "directory",
    );
    await service.restore({
      jobId: completed.jobId,
      expectedRevision: completed.revision,
      writersStopped: true,
    });
    assert.deepEqual(await f.images(), before);
    assert.equal(
      await readFile(join(f.root, "v2", "sessions", keyHash(old1), "configs/choice"), "utf8"),
      "file",
    );
    assert.equal(
      await readFile(
        join(f.root, "v2", "sessions", keyHash(old2), "configs/choice/nested"),
        "utf8",
      ),
      "directory",
    );
  });

for (const change of ["source", "lease", "keys", "project"])
  test(`restore revalidates ${change} after durable intent and rolls back its uncommitted CLI rows`, async (t) => {
    const f = await fixture(t);
    f.task(old1, "one");
    f.task(old2, "two");
    f.session(old2, "two");
    let revoked = false;
    const authority = {
      async inspect(request) {
        const result = await f.authority.inspect(request);
        return revoked && change === "keys"
          ? { ...result, legacyWorkspaceKeys: [old1] }
          : revoked && change === "project"
            ? { ...result, projectId: "changed-project" }
            : result;
      },
      async acquireStoppedWriters(...args) {
        const lease = await f.authority.acquireStoppedWriters(...args);
        return {
          async assertCurrent() {
            if (change === "lease" && revoked) throw new WorkspaceAliasError("active-owner");
          },
          release: () => lease.release(),
        };
      },
    };
    const service = f.create({
      authority,
      afterPhaseCommitted(phase) {
        if (phase === "restore-cli-intent") {
          revoked = true;
          if (change === "source") f.bump();
        }
      },
    });
    const approved = await approve(service);
    const completed = await service.execute({
      jobId: approved.jobId,
      expectedRevision: approved.revision,
    });
    const before = await f.images();
    await assert.rejects(
      service.restore({
        jobId: completed.jobId,
        expectedRevision: completed.revision,
        writersStopped: true,
      }),
      (error) => error.code === (change === "lease" ? "active-owner" : "source-stale"),
    );
    assert.deepEqual(await f.images(), before);
    assert.equal((await service.report(completed.jobId)).phase, "restoring");
  });

test("a revoked lease at the first config rename admits no further directory moves", async (t) => {
  const f = await fixture(t);
  f.task(old1, "one");
  f.task(old2, "two");
  await f.config(old1, "configs/a", "one");
  await f.config(old2, "configs/b", "two");
  let revoked = false;
  const authority = {
    inspect: (...args) => f.authority.inspect(...args),
    async acquireStoppedWriters(...args) {
      const lease = await f.authority.acquireStoppedWriters(...args);
      return {
        async assertCurrent() {
          if (revoked) throw new WorkspaceAliasError("active-owner");
        },
        release: () => lease.release(),
      };
    },
  };
  const service = f.create({
    authority,
    afterPhaseCommitted(phase) {
      if (phase === "config-renamed") revoked = true;
    },
  });
  const approved = await approve(service);
  const original = await readdir(join(f.root, "v2", "sessions"));
  const preview = await service.preview(scope);
  let firstRename;
  const observed = f.create({
    authority,
    afterPhaseCommitted(phase) {
      if (phase === "config-renamed") {
        revoked = true;
        firstRename ??= readdir(join(f.root, "v2", "sessions"));
      }
    },
  });
  await assert.rejects(
    observed.execute({ jobId: approved.jobId, expectedRevision: approved.revision }),
    (error) => error.code === "active-owner",
  );
  const actual = await readdir(join(f.root, "v2", "sessions"));
  assert.deepEqual(actual, await firstRename);
  assert.deepEqual(actual, [...original, keyHash(preview.canonicalKey)].sort());
  assert.equal(
    await readFile(join(f.root, "v2", "sessions", keyHash(old1), "configs/a"), "utf8"),
    "one",
  );
  assert.equal(
    await readFile(join(f.root, "v2", "sessions", keyHash(old2), "configs/b"), "utf8"),
    "two",
  );
  const failed = await service.report(approved.jobId);
  assert.equal(
    (await f.create().retry({ jobId: failed.jobId, expectedRevision: failed.revision })).status,
    "completed",
  );
});

for (const kind of ["host", "cli"])
  test(`preview rejects ${kind} published ledger corruption rather than repairing it`, async (t) => {
    const f = await fixture(t);
    const db = f[kind];
    const ledger = kind === "host" ? "tasks_schema_migration" : "schema_migration";
    db.exec(
      `UPDATE ${ledger} SET checksum='${"0".repeat(64)}' WHERE rowid=(SELECT min(rowid) FROM ${ledger})`,
    );
    const before = await f.images();
    await assert.rejects(
      f.create().preview(scope),
      (error) => error.code === "schema-incompatible",
    );
    assert.deepEqual(await f.images(), before);
  });

test("layout refuses relative roots and overlapping business, config or control paths", async (t) => {
  const f = await fixture(t);
  for (const overrides of [
    { dataRoot: ".zcodium" },
    { configHashRoots: [join(f.root, "v2", "sessions"), join(f.root, "v2", "sessions", "nested")] },
    { configHashRoots: [join(f.root, "v2", "workspace-alias-jobs")] },
    { taskDatabasePath: f.cliPath },
    { configHashRoots: [join(f.root, "cli")] },
  ])
    await assert.rejects(
      async () => f.create(overrides).preview(scope),
      (error) => error.code === "boundary-rejected",
    );
});

for (const kind of ["host", "config", "ledger"])
  test(`file safety rejects a hardlinked ${kind} without touching either link`, async (t) => {
    const f = await fixture(t);
    f.task(old1, "one");
    let source = f.hostPath;
    if (kind === "config") {
      await f.config(old1, "configs/private", "fixture");
      source = join(f.root, "v2", "sessions", keyHash(old1), "configs/private");
    } else if (kind === "ledger") {
      await approve(f.create());
      source = join(f.root, "v2", "source-workspace-alias.sqlite");
    }
    const original = await readFile(source);
    await createLinkMedia("hardlink", source, join(f.temp, `${kind}-hardlink`));
    await assert.rejects(f.create().preview(scope), (error) => error.code === "boundary-rejected");
    assert.deepEqual(await readFile(source), original);
  });

test("root ancestor junction is rejected even when the final .zcodium component is a real directory", async (t) => {
  const f = await fixture(t);
  f.task(old1, "one");
  const alias = join(f.temp, "linked-parent");
  await createLinkMedia(process.platform === "win32" ? "junction" : "dir", f.temp, alias);
  await assert.rejects(
    f.create({ dataRoot: join(alias, ".zcodium") }).preview(scope),
    (error) => error.code === "boundary-rejected",
  );
});

for (const nested of [".ZCODE", ".ZCODIUM"])
  test(`candidate config tree rejects nested ${nested} without importing its contents`, async (t) => {
    const f = await fixture(t);
    f.task(old1, "one");
    await f.config(old1, `${nested}/private`, "fixture");
    await assert.rejects(f.create().preview(scope), (error) => error.code === "boundary-rejected");
  });

for (const conflict of [
  "host-path",
  "host-identity",
  "host-meta",
  "cli-directory",
  "cli-path",
  "cli-owner",
  "empty-owner",
])
  test(`exact Source ownership refuses conflicting ${conflict} evidence`, async (t) => {
    const f = await fixture(t);
    f.task(old1, "one");
    f.task(old2, "two");
    if (conflict === "host-path")
      f.host.exec("UPDATE tasks SET workspace_path='/fixture/different' WHERE task_id='one'");
    if (conflict === "host-identity")
      f.host.prepare("UPDATE tasks SET workspace_identity=? WHERE task_id='one'").run(other);
    if (conflict === "host-meta")
      f.host
        .prepare("UPDATE tasks SET meta_json=? WHERE task_id='one'")
        .run(JSON.stringify({ workspaceIdentity: other }));
    if (conflict.startsWith("cli") || conflict === "empty-owner") {
      f.session(conflict === "cli-owner" ? other : conflict === "empty-owner" ? "" : old1, "one");
      if (conflict === "cli-directory")
        f.cli.exec(
          "UPDATE session SET directory='/fixture/different',path='/fixture/project' WHERE id='one'",
        );
      if (conflict === "cli-path")
        f.cli.exec("UPDATE session SET path='/fixture/different' WHERE id='one'");
    }
    const before = await f.images();
    const service = f.create();
    await assert.rejects(
      async () => {
        const plan = await service.preview(scope);
        if (plan.state === "blocked") throw new WorkspaceAliasError(plan.blocks[0].code);
        await approve(service);
      },
      (error) => error.code === "state-diverged",
    );
    assert.deepEqual(await f.images(), before);
  });

for (const change of ["keys", "project"])
  test(`execution revalidates frozen ${change} immediately before Host COMMIT`, async (t) => {
    const f = await fixture(t);
    f.task(old1, "one");
    f.task(old2, "two");
    const before = await f.images();
    let revoked = false;
    const authority = {
      async inspect(request) {
        const result = await f.authority.inspect(request);
        return !revoked
          ? result
          : change === "keys"
            ? { ...result, legacyWorkspaceKeys: [old1] }
            : { ...result, projectId: "changed-project" };
      },
      acquireStoppedWriters: (...args) => f.authority.acquireStoppedWriters(...args),
    };
    const service = f.create({
      authority,
      afterPhaseCommitted(phase) {
        if (phase === "host-intent") revoked = true;
      },
    });
    const approved = await approve(service);
    await assert.rejects(
      service.execute({ jobId: approved.jobId, expectedRevision: approved.revision }),
      (error) => error.code === "source-stale",
    );
    assert.deepEqual(await f.images(), before);
  });

for (const owner of ["target", "dwf", "automation-run", "automation-dispatch", "input"])
  test(`real frozen schema ${owner} admission blocks a multi-variant merge`, async (t) => {
    const f = await fixture(t);
    f.task(old1, "one");
    f.task(old2, "two");
    f.session(old2, "two");
    if (owner === "target")
      f.cli.exec(
        "INSERT INTO session_target(session_id,target_id,objective,status,time_created,time_updated,active_input_id,active_run_started_at) VALUES('two','target','fixture','active',1,1,'input',1)",
      );
    if (owner === "dwf")
      f.cli.exec(
        "INSERT INTO dwf_run(id,parent_session_id,caps_max_concurrency,status,time_created,time_updated) VALUES('run','two',1,'running',1,1)",
      );
    if (owner === "automation-run")
      f.host
        .prepare(
          "INSERT INTO automation_runs(run_id,automation_id,workspace_key,dispatch_status,outcome,created_at,updated_at) VALUES('run','automation',?,'dispatched','running',1,1)",
        )
        .run(old2);
    if (owner === "automation-dispatch")
      f.host
        .prepare(
          "INSERT INTO automations(automation_id,cron_expr,prompt,workspace_key,workspace_path,workspace_identity,dispatch_status,created_at,updated_at) VALUES('automation','0 * * * *','fixture',?,?,?,'claimed',1,1)",
        )
        .run(old2, scope.workspacePath, old2);
    if (owner === "input")
      f.cli.exec(
        "INSERT INTO session_input(id,session_id,kind,delivery,payload,admitted_sequence,status,time_created,time_updated) VALUES('input','two','prompt','queue','{}',1,'admitted',1,1)",
      );
    const before = await f.images();
    const preview = await f.create().preview(scope);
    assert.equal(preview.state, "blocked");
    assert.ok(preview.blocks.some((block) => block.code === "active-owner"));
    assert.deepEqual(await f.images(), before);
  });

test("restore refuses an original Host image without a durable restore intent", async (t) => {
  const f = await fixture(t);
  f.task(old1, "one");
  f.task(old2, "two");
  f.session(old2, "two");
  const service = f.create();
  const approved = await approve(service);
  const completed = await service.execute({
    jobId: approved.jobId,
    expectedRevision: approved.revision,
  });
  f.host
    .prepare("UPDATE tasks SET workspace_key=?,workspace_identity=? WHERE task_id='one'")
    .run(old1, old1);
  f.host
    .prepare("UPDATE tasks SET workspace_key=?,workspace_identity=? WHERE task_id='two'")
    .run(old2, old2);
  const current = await f.images();
  await assert.rejects(
    service.restore({
      jobId: completed.jobId,
      expectedRevision: completed.revision,
      writersStopped: true,
    }),
    (error) => error.code === "state-diverged",
  );
  assert.deepEqual(await f.images(), current);
});

test("a published config backup is never overwritten by retry after pre-business failure", async (t) => {
  const f = await fixture(t);
  f.task(old1, "one");
  f.task(old2, "two");
  await f.config(old1, "configs/a", "original");
  const service = f.create({
    afterPhaseCommitted(phase) {
      if (phase === "backups-created") throw new Error("fixture");
    },
  });
  const approved = await approve(service);
  await assert.rejects(
    service.execute({ jobId: approved.jobId, expectedRevision: approved.revision }),
  );
  const failed = await service.report(approved.jobId);
  const artifactRoot = join(f.root, "v2", "workspace-alias-jobs", failed.jobId);
  const metadata = JSON.parse(await readFile(join(artifactRoot, "backup.json"), "utf8"));
  const index = metadata.configHashes.findIndex((_, candidate) =>
    metadata.operations.some(
      (operation) =>
        operation.to === join(artifactRoot, "retired", String(candidate)) &&
        operation.image.workspaceKey === old1,
    ),
  );
  assert.ok(index >= 0);
  const path = join(artifactRoot, "config-backup", String(index), "configs/a");
  await writeFile(path, "tampered");
  await assert.rejects(
    f.create().retry({ jobId: failed.jobId, expectedRevision: failed.revision }),
    (error) => error.code === "backup-failed",
  );
  assert.equal(await readFile(path, "utf8"), "tampered");
});

test("existing alias stays canonical for newly discovered variants and restore returns its exact record", async (t) => {
  const f = await fixture(t);
  f.task(old1, "one");
  const service = f.create();
  const first = await approve(service);
  await service.execute({ jobId: first.jobId, expectedRevision: first.revision });
  f.task(old2, "two");
  const preview = await service.preview(scope);
  assert.equal(preview.state, "confirmation-required");
  assert.equal(preview.canonicalKey, old1);
  const approved = await approve(service);
  const completed = await service.execute({
    jobId: approved.jobId,
    expectedRevision: approved.revision,
  });
  assert.equal(completed.canonicalKey, old1);
  await service.restore({
    jobId: completed.jobId,
    expectedRevision: completed.revision,
    writersStopped: true,
  });
  const ledger = new DatabaseSync(join(f.root, "v2", "source-workspace-alias.sqlite"), {
    readOnly: true,
  });
  try {
    assert.equal(ledger.prepare("SELECT job_id FROM workspace_alias").get().job_id, first.jobId);
  } finally {
    ledger.close();
  }
});

test("large collision preview remains explicitly confirmable with a bounded signed token", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 20; i++) {
    f.task(old1, `task-${i}`, "first");
    f.task(old2, `task-${i}`, "second");
  }
  const service = f.create();
  const preview = await service.preview(scope);
  assert.equal(preview.collisions.length, 20);
  const approved = await approve(service);
  assert.equal(approved.phase, "approved");
});

async function fileManifest(root) {
  const result = [];
  async function visit(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(path, entry.name);
      const stat = await lstat(full, { bigint: true });
      result.push({
        path: full,
        identity: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`,
        hash: entry.isFile()
          ? createHash("sha256")
              .update(await readFile(full))
              .digest("hex")
          : "directory",
      });
      if (entry.isDirectory()) await visit(full);
    }
  }
  await visit(root);
  return result;
}

test("preview/getters reject live WAL before changing its complete fixture manifest", async (t) => {
  const f = await fixture(t);
  f.host.exec("PRAGMA journal_mode=WAL");
  f.cli.exec("PRAGMA journal_mode=WAL");
  f.task(old1, "one");
  f.session(old1, "one");
  const before = await fileManifest(f.root);
  await assert.rejects(
    f.create().getResolvedWorkspace(scope),
    (error) => error.code === "schema-incompatible",
  );
  assert.deepEqual(await fileManifest(f.root), before);
});

test("WAL without SHM is refused before SQLite can create a sidecar", async (t) => {
  const f = await fixture(t);
  f.host.exec("PRAGMA journal_mode=WAL");
  f.task(old1, "one");
  const image = await readFile(f.hostPath);
  const wal = await readFile(`${f.hostPath}-wal`);
  f.host.close();
  await writeFile(f.hostPath, image);
  await writeFile(`${f.hostPath}-wal`, wal);
  const before = await fileManifest(f.root);
  await assert.rejects(f.create().preview(scope), (error) => error.code === "schema-incompatible");
  assert.deepEqual(await fileManifest(f.root), before);
});

test("database read holds one committed snapshot across asynchronous table enumeration", async (t) => {
  const f = await fixture(t);
  f.host.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE a_snapshot(value INTEGER); CREATE TABLE z_snapshot(value INTEGER)",
  );
  for (let i = 0; i < 300; i++) f.host.prepare("INSERT INTO a_snapshot VALUES(1)").run();
  f.host.exec("INSERT INTO z_snapshot VALUES(1)");
  const read = new DatabaseSync(f.hostPath, { readOnly: true });
  try {
    const pending = databaseImage(read, "fixture-snapshot");
    const written = new Promise((resolve, reject) =>
      setImmediate(() => {
        try {
          f.host.exec(
            "BEGIN IMMEDIATE; UPDATE a_snapshot SET value=2; UPDATE z_snapshot SET value=2; COMMIT",
          );
          resolve();
        } catch (error) {
          reject(error);
        }
      }),
    );
    const image = await pending;
    await written;
    const a = image.tables.find((table) => table.name === "a_snapshot");
    const z = image.tables.find((table) => table.name === "z_snapshot");
    assert.equal(a.rows[0][0].integer, "1");
    assert.equal(z.rows[0][0].integer, "1");
  } finally {
    read.close();
  }
});

for (const phase of [
  "host-backup-created",
  "cli-backup-created",
  "config-backup-created",
  "backups-published",
  "config-rename-intent",
])
  test(
    `actual exit at ${phase} retries unpublished materials and durable rename intent`,
    { timeout: 30000 },
    async (t) => {
      const f = await fixture(t);
      f.task(old1, "one");
      f.task(old2, "two");
      f.session(old2, "two");
      await f.config(old1, "configs/a", "one");
      await f.config(old2, "configs/b", "two");
      const approved = await approve(f.create());
      await crashExecution(f, approved, phase);
      const state = await f.create().report(approved.jobId);
      assert.equal(
        (await f.create().retry({ jobId: state.jobId, expectedRevision: state.revision })).status,
        "completed",
      );
    },
  );

for (const field of ["phase", "canonical", "config-index", "restore-index"])
  test(`durable job rejects tampered ${field} instead of guessing an accepted stage`, async (t) => {
    const f = await fixture(t);
    f.task(old1, "one");
    f.task(old2, "two");
    const service = f.create();
    const approved = await approve(service);
    const ledger = new DatabaseSync(join(f.root, "v2", "source-workspace-alias.sqlite"));
    try {
      const row = ledger.prepare("SELECT data FROM alias_job WHERE job_id=?").get(approved.jobId);
      const job = JSON.parse(row.data);
      if (field === "phase") job.report.phase = "host-merged";
      if (field === "canonical") {
        job.plan.canonicalKey = old1;
        job.report.canonicalKey = old1;
      }
      if (field === "config-index") job.configIndex = 999;
      if (field === "restore-index") {
        job.restoreConfigIndex = 1;
        job.configIndex = 1;
      }
      ledger
        .prepare("UPDATE alias_job SET data=? WHERE job_id=?")
        .run(JSON.stringify(job), approved.jobId);
    } finally {
      ledger.close();
    }
    await assert.rejects(
      service.report(approved.jobId),
      (error) => error.code === "state-diverged",
    );
  });

test("maximum scope path produces a bounded confirmation token", async (t) => {
  const f = await fixture(t);
  const request = { ...scope, workspacePath: "/" + "p".repeat(4095) };
  const service = f.create({
    authority: {
      async inspect(input) {
        return {
          sourceServerId: input.sourceServerId,
          generation: 1,
          legacyWorkspaceKeys: [],
          projectId: "fixture-project",
        };
      },
      acquireStoppedWriters: (...args) => f.authority.acquireStoppedWriters(...args),
    },
  });
  const preview = await service.preview(request);
  assert.ok(preview.confirmationToken.length <= 4096);
  const result = await service.confirm({
    ...request,
    sourceGeneration: preview.sourceGeneration,
    candidateVersion: preview.candidateVersion,
    planHash: preview.planHash,
    confirmationToken: preview.confirmationToken,
    canonicalKey: preview.canonicalKey,
    choices: [],
    acknowledgeMerge: true,
  });
  assert.equal(result.phase, "approved");
});

test("root file generation is part of the plan, not just its spelling and database rows", async (t) => {
  const f = await fixture(t);
  f.task(old1, "one");
  f.task(old2, "two");
  const service = f.create();
  const plan = await service.preview(scope);
  f.host.close();
  f.cli.close();
  const held = join(f.temp, "old-root");
  await rename(f.root, held);
  await mkdir(f.root);
  for (const entry of await readdir(held)) await rename(join(held, entry), join(f.root, entry));
  await assert.rejects(
    service.confirm({
      ...scope,
      sourceGeneration: plan.sourceGeneration,
      candidateVersion: plan.candidateVersion,
      planHash: plan.planHash,
      confirmationToken: plan.confirmationToken,
      canonicalKey: plan.canonicalKey,
      choices: [],
      acknowledgeMerge: true,
    }),
    (error) => error.code === "plan-stale",
  );
});

test("open file identity recheck rejects replacement by another ordinary file", async (t) => {
  const f = await fixture(t);
  await f.config(old1, "configs/private", "original");
  const path = join(f.root, "v2", "sessions", keyHash(old1), "configs/private");
  const held = await openSafe(f.root, path);
  try {
    await rename(path, `${path}.old`);
    await writeFile(path, "replacement");
    await assert.rejects(held.assertCurrent(), (error) => error.code === "boundary-rejected");
  } finally {
    await held.handle.close();
  }
});

test("an identical but replaced business database is refused on same-job retry", async (t) => {
  const f = await fixture(t);
  f.task(old1, "one");
  f.task(old2, "two");
  const service = f.create({
    afterPhaseCommitted(phase) {
      if (phase === "backups-created") throw new Error("fixture");
    },
  });
  const approved = await approve(service);
  await assert.rejects(
    service.execute({ jobId: approved.jobId, expectedRevision: approved.revision }),
  );
  const failed = await service.report(approved.jobId);
  f.host.close();
  const replacement = `${f.hostPath}.replacement`;
  await copyFile(f.hostPath, replacement);
  await rename(f.hostPath, `${f.hostPath}.old`);
  await rename(replacement, f.hostPath);
  await assert.rejects(
    f.create().retry({ jobId: failed.jobId, expectedRevision: failed.revision }),
    (error) => error.code === "state-diverged",
  );
});

for (const kind of ["symlink", "hardlink"])
  test(`WAL sidecar ${kind} is rejected before any storage read`, async (t) => {
    const f = await fixture(t);
    const outside = join(f.temp, "sidecar");
    await writeFile(outside, "fixture");
    if (kind === "symlink") await createLinkMedia("filelink", outside, `${f.hostPath}-wal`);
    else await createLinkMedia("hardlink", outside, `${f.hostPath}-wal`);
    await assert.rejects(f.create().preview(scope), (error) => error.code === "boundary-rejected");
    assert.equal(await readFile(outside, "utf8"), "fixture");
  });

test("restore user acknowledgement never bypasses a refused full-root writer lease", async (t) => {
  const f = await fixture(t);
  f.task(old1, "one");
  f.task(old2, "two");
  const service = f.create();
  const approved = await approve(service);
  const completed = await service.execute({
    jobId: approved.jobId,
    expectedRevision: approved.revision,
  });
  const before = await f.images();
  const denied = f.create({
    authority: {
      inspect: (...args) => f.authority.inspect(...args),
      async acquireStoppedWriters() {
        throw new WorkspaceAliasError("active-owner");
      },
    },
  });
  await assert.rejects(
    denied.restore({
      jobId: completed.jobId,
      expectedRevision: completed.revision,
      writersStopped: true,
    }),
    (error) => error.code === "active-owner",
  );
  assert.deepEqual(await f.images(), before);
});

for (const phase of ["host-intent", "cli-intent"])
  test(
    `actual execute exit before ${phase} retries the owned uncommitted transaction`,
    { timeout: 30000 },
    async (t) => {
      const f = await fixture(t);
      f.task(old1, "one");
      f.task(old2, "two");
      f.session(old2, "two");
      const service = f.create();
      const approved = await approve(service);
      await crashExecution(f, approved, phase);
      const job = await f.create().report(approved.jobId);
      assert.equal(
        (await f.create().retry({ jobId: job.jobId, expectedRevision: job.revision })).status,
        "completed",
      );
    },
  );

for (const tamper of ["journal", "database"])
  test(
    `restore crash journal ownership rejects later ${tamper} bytes before recovering anything`,
    { timeout: 30000 },
    async (t) => {
      const f = await fixture(t);
      f.task(old1, "one");
      f.task(old2, "two");
      f.session(old2, "two");
      const service = f.create();
      const approved = await approve(service);
      const completed = await service.execute({
        jobId: approved.jobId,
        expectedRevision: approved.revision,
      });
      await crashExecution(f, completed, "restore-cli-intent", "restore");
      const path = tamper === "journal" ? `${f.cliPath}-journal` : f.cliPath;
      const data = await readFile(path);
      data[data.length - 1] ^= 1;
      await writeFile(path, data);
      const before = await fileManifest(f.root);
      const job = await f.create().report(approved.jobId);
      await assert.rejects(
        f
          .create()
          .restore({ jobId: job.jobId, expectedRevision: job.revision, writersStopped: true }),
        (error) => error.code === "state-diverged",
      );
      const after = await fileManifest(f.root);
      for (const path of [f.hostPath, f.cliPath, `${f.cliPath}-journal`])
        assert.deepEqual(
          after.find((entry) => entry.path === path),
          before.find((entry) => entry.path === path),
        );
    },
  );

for (const header of ["cold", "unknown"])
  test(`readonly preview ${header === "cold" ? "accepts only zero-magic cold" : "refuses unknown"} rollback journal without any file writes`, async (t) => {
    const f = await fixture(t);
    f.task(old1, "one");
    const journal = Buffer.alloc(512);
    if (header === "unknown") journal[0] = 1;
    await writeFile(`${f.hostPath}-journal`, journal);
    const before = await fileManifest(f.root);
    if (header === "cold") await f.create().getResolvedWorkspace(scope);
    else
      await assert.rejects(
        f.create().preview(scope),
        (error) => error.code === "schema-incompatible",
      );
    assert.deepEqual(await fileManifest(f.root), before);
  });

for (const phase of ["config-rename-intent", "restore-cli-intent", "restore-host-intent"])
  test(
    `actual restore exit before ${phase} is recoverable without accepting a false original image`,
    { timeout: 30000 },
    async (t) => {
      const f = await fixture(t);
      f.task(old1, "one");
      f.task(old2, "two");
      f.session(old2, "two");
      await f.config(old1, "configs/a", "one");
      await f.config(old2, "configs/b", "two");
      const before = await f.images();
      const service = f.create();
      const approved = await approve(service);
      const completed = await service.execute({
        jobId: approved.jobId,
        expectedRevision: approved.revision,
      });
      await crashExecution(f, completed, phase, "restore");
      const job = await f.create().report(approved.jobId);
      assert.equal(
        (
          await f
            .create()
            .restore({ jobId: job.jobId, expectedRevision: job.revision, writersStopped: true })
        ).status,
        "restored",
      );
      assert.deepEqual(await f.images(), before);
    },
  );
