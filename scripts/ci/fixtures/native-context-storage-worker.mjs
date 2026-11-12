import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import { Worker } from "node:worker_threads";
import {
  assertProjectPath,
  createProjectTestFixture,
  createProjectTestSandbox,
  projectRoot,
} from "../project-test-sandbox.mjs";

const sourcePath = join(
  projectRoot,
  "apps/zcode-cli/packages/bootstrap/src/zcode-protocol/storage-startup.ts",
);

export async function buildStoragePreparationFixture() {
  assert.equal(process.version, "v24.14.0", "use the workspace Node version from mise.toml");
  await assertProjectPath(process.execPath);
  const sandbox = await createProjectTestSandbox("native-storage-worker-source");
  // CLI aliases load tsx: bind HOME/TEMP/cache before evaluating the build helpers.
  Object.assign(process.env, sandbox.env);
  const [{ build }, { resolveBuildAliases }] = await Promise.all([
    import("esbuild"),
    import("../../../apps/zcode-cli/packages/cli/scripts/build.mjs"),
  ]);
  await assertProjectPath(sourcePath);
  const source = await readFile(sourcePath, "utf8");
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const directory = await createProjectTestFixture("bundle", sandbox.env);
  const entry = await assertProjectPath(join(directory, "entry.ts"));
  const bundle = await assertProjectPath(join(directory, "storage-preparation.cjs"));
  await writeFile(
    entry,
    `import { prepareProtocolStartupStorage } from ${JSON.stringify(sourcePath)};
import { parentPort } from "node:worker_threads";
void prepareProtocolStartupStorage({
  dbPath: process.env.ZCODE_SESSION_DB_PATH!, input: process.stdin, output: process.stdout,
}).then(() => {
  process.stderr.write(parentPort === null ? "REPRO_SETTLED_PARENT_NULL\\n" : "REPRO_SETTLED_WORKER\\n");
}).catch((error) => {
  process.stderr.write("REPRO_FAILED\\n");
  process.exitCode = 1;
});
`,
  );
  await build({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    logLevel: "warning",
    alias: resolveBuildAliases(),
    plugins: [
      {
        name: "freeze-storage-preparation-source",
        setup(builder) {
          builder.onLoad({ filter: /storage-startup\.ts$/ }, (args) => {
            if (args.path.replaceAll("\\", "/") !== sourcePath.replaceAll("\\", "/")) return;
            return {
              contents: source,
              loader: "ts",
              resolveDir: join(sourcePath, ".."),
            };
          });
        },
      },
    ],
  });
  await assertProjectPath(bundle);
  return { sandbox, bundle, sourceHash };
}

function inSandbox(root, path) {
  const suffix = relative(root, path);
  assert.ok(suffix && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

export async function runStoragePreparation(t, fixture, options = {}) {
  const { reuse = false, failDatabase = false, childProcess = false } = options;
  const sandbox = await createProjectTestSandbox(
    childProcess
      ? "storage-child-process"
      : reuse
        ? "storage-reuse"
        : failDatabase
          ? "storage-failure"
          : "storage-fresh",
    { env: fixture.sandbox.env },
  );
  const cwd = await createProjectTestFixture("cwd", sandbox.env);
  const databasePath = await assertProjectPath(sandbox.env.ZCODE_SESSION_DB_PATH);
  if (failDatabase) {
    await mkdir(databasePath, { recursive: true });
    await assertProjectPath(databasePath);
  }
  const env = { ...sandbox.env };
  for (const key of Object.keys(env)) {
    if (
      /^(?:e2e_provider_|r3_mobile_)/i.test(key) ||
      /(?:^|_)(?:api_key|access_token|auth_token|secret_key)$/i.test(key)
    )
      delete env[key];
  }
  delete env.NODE_V8_COVERAGE;
  for (const key of [
    "PROJECT_TEST_SANDBOX_ROOT",
    "HOME",
    "USERPROFILE",
    "TEMP",
    "TMP",
    "TMPDIR",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "ZCODE_DATA_BASE_DIR",
    "ZCODIUM_DATA_DIR",
    "ZCODE_STORAGE_DIR",
    "ZCODE_SESSION_DB_PATH",
    "ZCODE_LOG_DIR",
    "npm_config_cache",
    "PNPM_HOME",
    "TURBO_CACHE_DIR",
  ]) {
    await assertProjectPath(env[key]);
    if (key === "PROJECT_TEST_SANDBOX_ROOT") assert.equal(env[key], sandbox.root);
    else inSandbox(sandbox.root, env[key]);
  }
  for (const path of [cwd, databasePath, fixture.bundle]) await assertProjectPath(path);
  const argv = ["app-server", "--stdio", "--prepare-storage", "--cwd", cwd];
  const processOrWorker = childProcess
    ? spawn(process.execPath, [fixture.bundle, ...argv], {
        cwd,
        env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      })
    : new Worker(fixture.bundle, {
        argv,
        env,
        stdin: true,
        stdout: true,
        stderr: true,
      });
  const input = processOrWorker.stdin;
  const output = processOrWorker.stdout;
  const diagnostics = processOrWorker.stderr;
  const phases = [];
  const failures = [];
  let pathReceived = false,
    acknowledged = false,
    prepared = false,
    exited = false;
  let settledWorker = false,
    settledParentNull = false,
    failed = false;
  let stderrTail = "";
  let protocolFailure;
  const stop = () => (childProcess ? processOrWorker.kill() : void processOrWorker.terminate());
  t.signal.addEventListener("abort", stop, { once: true });
  t.after(() => {
    if (!exited) stop();
  });
  const safeError = (error) => ({
    name: error?.name ?? "Error",
    code: /^[A-Z0-9_]+$/.test(error?.code ?? "") ? error.code : null,
  });
  processOrWorker.on("error", (error) => failures.push(safeError(error)));
  input.on("error", (error) => failures.push(safeError(error)));
  diagnostics.on("data", (chunk) => {
    // Store only fixture markers; dependency stderr can include paths or error text.
    stderrTail = (stderrTail + chunk.toString()).slice(-4096);
    settledWorker ||= stderrTail.includes("REPRO_SETTLED_WORKER");
    settledParentNull ||= stderrTail.includes("REPRO_SETTLED_PARENT_NULL");
    failed ||= stderrTail.includes("REPRO_FAILED");
  });
  const lines = createInterface({ input: output });
  let frameWork = Promise.resolve();
  lines.on("line", (line) => {
    frameWork = frameWork
      .then(async () => {
        assert.ok(line.length <= 65536);
        const frame = JSON.parse(line);
        if (frame.method === "startup/storagePath") {
          assert.equal(pathReceived, false);
          const path = await assertProjectPath(frame.params.path);
          inSandbox(sandbox.root, path);
          assert.equal(path, databasePath);
          pathReceived = true;
          await new Promise((resolve, reject) =>
            input.write(
              `${JSON.stringify({ method: "startup/storagePathReady", reuse })}\n`,
              (error) => (error ? reject(error) : resolve()),
            ),
          );
          acknowledged = true;
        } else if (frame.method === "startup/storageState") {
          assert.ok(pathReceived && acknowledged);
          assert.match(frame.params.phase, /^(checking|migrating|committing|ready|failed)$/);
          phases.push({
            phase: frame.params.phase,
            sequence: frame.params.sequence,
            committedCount: frame.params.migration?.committedCount ?? null,
          });
        } else if (frame.method === "startup/storagePrepared") {
          assert.ok(pathReceived && acknowledged);
          assert.equal(prepared, false);
          prepared = true;
          // Match Host: do not finish Worker input until the real prepared frame arrives.
          input.end();
        } else assert.fail("unexpected storage preparation frame");
      })
      .catch((error) => {
        protocolFailure ??= safeError(error);
        stop();
      });
  });
  // The only cancellation budget is node:test's parent-side signal, never a Worker keepalive.
  const exitCode = await new Promise((resolve) =>
    processOrWorker.once(childProcess ? "close" : "exit", resolve),
  );
  exited = true;
  t.signal.removeEventListener("abort", stop);
  await frameWork;
  lines.close();
  let databaseBytes = null;
  try {
    const info = await lstat(await assertProjectPath(databasePath));
    if (info.isFile()) databaseBytes = info.size;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const result = {
    sourceHash: fixture.sourceHash,
    reuse,
    childProcess,
    failDatabase,
    pathReceived,
    acknowledged,
    prepared,
    settledWorker,
    settledParentNull,
    failed,
    exitCode,
    databaseBytes,
    failures,
    protocolFailure: protocolFailure ?? null,
    phases,
  };
  const report = await assertProjectPath(join(sandbox.logs, "storage-worker-result.json"));
  await writeFile(report, JSON.stringify(result, null, 2));
  t.diagnostic(`storage lifecycle evidence: ${relative(projectRoot, report)}`);
  assert.deepEqual(failures, []);
  assert.equal(protocolFailure, undefined);
  return result;
}
