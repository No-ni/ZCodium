import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  writeFile,
  readdir,
  readFile,
  lstat,
  stat,
  realpath,
  rm,
  rename,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  assertProjectPath,
  createProjectTestFixture,
  projectRoot,
} from "../project-test-sandbox.mjs";
import { tsImport } from "tsx/esm/api";

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

const api = await tsImport(
  "../../../packages/services/src/source-server-workspace/node.ts",
  import.meta.url,
);
const { createWindowRemoteConnectionRegistry } = await tsImport(
  "../../../packages/desktop/src/host/windowRemoteConnectionRegistry.ts",
  import.meta.url,
);
const { buildServerRemoteWorkspaceIdentity } = await tsImport(
  "../../../packages/shared/src/remote-workspace-identity.ts",
  import.meta.url,
);
const scope = { sourceServerId: "fixture-source", workspacePath: "/fixture/project" };
const stableIdentity = buildServerRemoteWorkspaceIdentity({
  serverId: scope.sourceServerId,
  workspacePath: scope.workspacePath,
});
const clear = { ...scope, schemaVersion: 1, stableIdentity, state: "clear" };

// 唯一环境 owner：fixture 目录绑定本次项目内 sandbox，运行后保留，不递归清理。
async function fixture() {
  const temp = await createProjectTestFixture("source-inspection");
  const dataRoot = join(temp, ".zcodium");
  await mkdir(dataRoot);
  const options = {
    sourceServerId: scope.sourceServerId,
    dataRoot,
    taskDatabasePath: join(dataRoot, "v2", "tasks-index.sqlite"),
    sessionDatabasePath: join(dataRoot, "cli", "db", "db.sqlite"),
  };
  return { temp, options, dataRoot };
}
async function manifest(root) {
  const entries = [];
  async function walk(path) {
    const info = await lstat(path, { bigint: true });
    const item = {
      path,
      identity: `${info.dev}:${info.ino}:${info.birthtimeNs}`,
      type: info.isDirectory() ? "dir" : info.isFile() ? "file" : "link",
      nlink: String(info.nlink),
    };
    if (info.isFile()) item.bytes = (await readFile(path)).toString("hex");
    else if (info.isSymbolicLink()) item.target = await realpath(path);
    entries.push(item);
    if (info.isDirectory() && !info.isSymbolicLink())
      for (const name of (await readdir(path)).sort()) await walk(join(path, name));
  }
  await walk(root);
  return entries;
}
function inspector(options) {
  assert.equal(
    typeof api.createNodeSourceWorkspaceInspectionService,
    "function",
    "Source-owned read-only inspection factory must exist",
  );
  return api.createNodeSourceWorkspaceInspectionService(options);
}
async function put(path) {
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "not SQLite; inspection must never open it");
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const params = {
  requestId: "fixture-request",
  target: { kind: "ssh", host: "fixture.invalid", username: "fixture" },
  remoteAssets: {},
  workspacePath: scope.workspacePath,
};
function attachment(descriptor) {
  return {
    kind: "remote",
    remoteSessionId: descriptor.remoteSessionId,
    workspacePath: descriptor.workspacePath,
    workspaceIdentity: descriptor.workspaceIdentity,
  };
}

test("Source inspection uses a strict path-free three-state result, not a client proof or root", () => {
  assert.equal(typeof api.sourceWorkspaceInspectionResultSchema?.safeParse, "function");
  assert.equal(api.sourceWorkspaceInspectionResultSchema.safeParse(clear).success, true);
  for (const value of [
    { ...clear, dataRoot: "/other" },
    { ...clear, writersStopped: true },
    { ...clear, state: "unavailable", reason: "raw secret error" },
    { ...clear, state: "history-present" },
  ])
    assert.equal(api.sourceWorkspaceInspectionResultSchema.safeParse(value).success, false);
});
test("Source inspection admits an explicitly known empty history scope without creating stores", async () => {
  const f = await fixture();
  const before = await manifest(f.temp);
  assert.deepEqual(await inspector(f.options).inspect(scope), clear);
  assert.deepEqual(await manifest(f.temp), before);
});
for (const database of ["taskDatabasePath", "sessionDatabasePath"])
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    test(`Source inspection blocks ${database}${suffix} by presence without opening SQLite or mutating bytes`, async () => {
      const f = await fixture();
      await put(`${f.options[database]}${suffix}`);
      const before = await manifest(f.temp);
      const result = await inspector(f.options).inspect(scope);
      assert.equal(result.state, "history-present");
      assert.equal(result.reason, "source-workspace-history-present");
      assert.deepEqual(await manifest(f.temp), before);
    });
for (const path of ["sessions", "workspace-alias-jobs"])
  test(`Source inspection conservatively blocks an existing ${path} root without reading config bodies`, async () => {
    const f = await fixture();
    await mkdir(join(f.dataRoot, "v2", path), { recursive: true });
    const before = await manifest(f.temp);
    assert.equal((await inspector(f.options).inspect(scope)).state, "history-present");
    assert.deepEqual(await manifest(f.temp), before);
  });
test("Source inspection reports a missing authority root as unavailable, not an empty new workspace", async () => {
  const f = await fixture();
  await rm(f.dataRoot, { recursive: true });
  const result = await inspector(f.options).inspect(scope);
  assert.equal(result.state, "unavailable");
  assert.deepEqual(await readdir(f.temp), []);
});
test("Source inspection cannot receive another Source, relative workspace, unknown root or user-selected filesystem options", async () => {
  const f = await fixture();
  const instance = inspector(f.options);
  for (const input of [
    { ...scope, sourceServerId: "another-source" },
    { ...scope, workspacePath: "relative" },
    { ...scope, dataRoot: f.dataRoot },
  ])
    await assert.rejects(instance.inspect(input));
  for (const options of [
    { ...f.options, dataRoot: ".zcodium" },
    { ...f.options, sessionDatabasePath: join(f.temp, "outside.sqlite") },
  ]) {
    const result = await inspector(options).inspect(scope);
    assert.equal(result.state, "unavailable");
  }
});
test("Source inspection propagates injected permission/IO uncertainty into a safe blocked result", async () => {
  const f = await fixture();
  const before = await manifest(f.temp);
  const result = await inspector({
    ...f.options,
    afterObservation() {
      throw Object.assign(new Error("unsafe raw fixture path/error"), { code: "EACCES" });
    },
  }).inspect(scope);
  assert.equal(result.state, "unavailable");
  assert.equal(JSON.stringify(result).includes("unsafe raw"), false);
  assert.deepEqual(await manifest(f.temp), before);
});
test("Source inspection rejects a changed root/tuple rather than silently retrying absence", async () => {
  const f = await fixture();
  let calls = 0;
  const result = await inspector({
    ...f.options,
    async afterObservation() {
      calls++;
      await put(f.options.taskDatabasePath);
    },
  }).inspect(scope);
  assert.equal(result.state, "unavailable");
  assert.equal(result.reason, "source-workspace-inspection-stale");
  assert.equal(calls, 1);
});
test("Source inspection refuses an ancestor junction and hardlinked database before admitting", async () => {
  const f = await fixture();
  await put(f.options.taskDatabasePath);
  await createLinkMedia("hardlink", f.options.taskDatabasePath, join(f.temp, "outside.sqlite"));
  assert.equal((await inspector(f.options).inspect(scope)).state, "unavailable");
  await rm(join(f.temp, "outside.sqlite"));
  const alias = join(f.temp, "alias");
  await createLinkMedia("junction", f.temp, alias);
  const dataRoot = join(alias, ".zcodium");
  assert.equal(
    (
      await inspector({
        ...f.options,
        dataRoot,
        taskDatabasePath: join(dataRoot, "v2", "tasks-index.sqlite"),
        sessionDatabasePath: join(dataRoot, "cli", "db", "db.sqlite"),
      }).inspect(scope)
    ).state,
    "unavailable",
  );
  await rm(alias);
});
test("Source inspection refuses a changed regular root identity even if target bytes are empty", async () => {
  const f = await fixture();
  const moved = join(f.temp, "retired");
  const result = await inspector({
    ...f.options,
    async afterObservation() {
      await rename(f.dataRoot, moved);
      await mkdir(f.dataRoot);
    },
  }).inspect(scope);
  assert.equal(result.state, "unavailable");
  assert.equal(result.reason, "source-workspace-inspection-stale");
});

for (const reason of [
  "source-workspace-history-present",
  "source-workspace-inspection-unavailable",
])
  test(`registry requires Source workspace admission and never publishes ${reason}`, async () => {
    let inspections = 0;
    const registry = createWindowRemoteConnectionRegistry({
      connect: async () => ({
        sourceServerId: scope.sourceServerId,
        services: {},
        dispose() {},
        async inspectWorkspace() {
          inspections++;
          throw new Error(reason);
        },
      }),
      createId: () => "fixture-session",
    });
    await assert.rejects(registry.connect(params), new RegExp(reason));
    assert.equal(inspections, 1);
    assert.equal(registry.getSession("fixture-session"), null);
    await registry.dispose();
  });
test("registry refuses a Source workspace when inspection capability is unavailable", async () => {
  const registry = createWindowRemoteConnectionRegistry({
    connect: async () => ({ sourceServerId: scope.sourceServerId, services: {}, dispose() {} }),
    createId: () => "fixture-session",
  });
  await assert.rejects(registry.connect(params), /只读检查|inspection/i);
  await registry.dispose();
});
test("registry keeps scoped services and provisioning unavailable while a Source inspection awaits", async () => {
  const barrier = deferred();
  const registry = createWindowRemoteConnectionRegistry({
    connect: async () => ({
      sourceServerId: scope.sourceServerId,
      configurationMode: "mirror-personal",
      services: {},
      dispose() {},
      inspectWorkspace: () => barrier.promise,
      async assertProviderProvisioningAllowed() {},
    }),
    createId: () => "fixture-session",
  });
  let settled = false;
  const pending = registry.connect(params).then((result) => {
    settled = true;
    return result;
  });
  await new Promise((done) => setImmediate(done));
  const target = attachment({
    remoteSessionId: "fixture-session",
    workspacePath: scope.workspacePath,
    workspaceIdentity: stableIdentity,
  });
  assert.equal(settled, false);
  assert.equal(registry.getSession("fixture-session").workspaceReadyState, "pending");
  assert.throws(() => registry.resolveScopedServices(target));
  await assert.rejects(registry.assertProviderProvisioningAllowed(target));
  barrier.resolve();
  const descriptor = await pending;
  assert.equal(registry.getSession("fixture-session").workspaceReadyState, "ready");
  assert.deepEqual(registry.resolveScopedServices(attachment(descriptor)), {});
  await registry.dispose();
});
test("Source reuse and later workspace binding each execute the same read-only admission port", async () => {
  const paths = [];
  let connects = 0;
  let id = 0;
  const registry = createWindowRemoteConnectionRegistry({
    connect: async () => {
      connects++;
      return {
        sourceServerId: scope.sourceServerId,
        services: {},
        dispose() {},
        async inspectWorkspace(context) {
          paths.push(context.workspacePath);
        },
      };
    },
    createId: () => `fixture-${++id}`,
  });
  const first = await registry.connect(params);
  await registry.connect({ ...params, requestId: "next", workspacePath: "/fixture/another" });
  await registry.bindWorkspaceContext({
    remoteSessionId: first.remoteSessionId,
    workspacePath: "/fixture/bound",
    workspaceIdentity: "ignored-legacy",
  });
  assert.equal(connects, 1);
  assert.deepEqual(paths, [scope.workspacePath, "/fixture/another", "/fixture/bound"]);
  await registry.dispose();
});
test("a retired Source inspection cannot mark a newer binding ready or failed", async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const registry = createWindowRemoteConnectionRegistry({
    connect: async () => ({
      sourceServerId: scope.sourceServerId,
      services: {},
      dispose() {},
      inspectWorkspace() {
        calls++;
        return calls === 1 ? Promise.resolve() : calls === 2 ? first.promise : second.promise;
      },
    }),
    createId: () => "fixture-session",
  });
  const descriptor = await registry.connect(params);
  const old = registry.bindWorkspaceContext({
    remoteSessionId: descriptor.remoteSessionId,
    workspacePath: "/fixture/old",
    workspaceIdentity: "old",
  });
  const oldOutcome = old.then(
    () => "ready",
    () => "retired",
  );
  await new Promise((done) => setImmediate(done));
  const current = registry.bindWorkspaceContext({
    remoteSessionId: descriptor.remoteSessionId,
    workspacePath: "/fixture/current",
    workspaceIdentity: "current",
  });
  await new Promise((done) => setImmediate(done));
  first.resolve();
  await new Promise((done) => setImmediate(done));
  assert.equal(await oldOutcome, "retired");
  assert.equal(registry.getSession(descriptor.remoteSessionId).workspaceReadyState, "pending");
  second.resolve();
  await current;
  assert.equal(registry.getSession(descriptor.remoteSessionId).workspaceReadyState, "ready");
  await registry.dispose();
});
test("disposing a logical Source during ignored-signal inspection settles it without new ready services", async () => {
  const barrier = deferred();
  const registry = createWindowRemoteConnectionRegistry({
    connect: async () => ({
      sourceServerId: scope.sourceServerId,
      services: {},
      dispose() {},
      inspectWorkspace: () => barrier.promise,
    }),
    createId: () => "fixture-session",
  });
  const pending = registry.connect(params);
  const rejected = assert.rejects(pending, /取消|unavailable|retired/i);
  await new Promise((done) => setImmediate(done));
  await registry.disposeSession("fixture-session");
  await rejected;
  barrier.resolve();
  await new Promise((done) => setImmediate(done));
  assert.equal(registry.getSession("fixture-session"), null);
  await registry.dispose();
});
