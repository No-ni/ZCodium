import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { ServiceChannels, type AppSettings } from "@zcode/shared";
import type { NativeContextObservation } from "@zcode/shared/native-context-compression";
import { resolveE2EHomeDir } from "../e2e-runtime-paths.js";
import { callHandoffHost, installHandoffRpcProbe } from "../remote-project-handoff-probe.js";
import { assertNativeContextTestPath } from "./environment.js";
import {
  nativeContextLedgerManifestSchema,
  nativeContextLedgerHostPreferencesSchema,
  nativeContextLedgerSeedFactsSchema,
  type NativeContextLedgerManifest,
} from "./ledger-fixture-contract.js";

const run = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../../../../../..");

function inside(parent: string, child: string) {
  const suffix = relative(parent, child);
  return !!suffix && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

/** 短生命周期 fixture 进程只 seed/只读核验；现有 Host、CLI、Electron 始终复用。 */
async function runNativeContextLedgerFixture(input: Record<string, unknown>) {
  const configuredSandbox = process.env.PROJECT_TEST_SANDBOX_ROOT;
  if (!configuredSandbox || !isAbsolute(configuredSandbox))
    throw new Error("NCTX_LEDGER_SANDBOX_REQUIRED");
  const sandboxRoot = await assertNativeContextTestPath(configuredSandbox);
  const homeDir = await assertNativeContextTestPath(resolveE2EHomeDir());
  assert.ok(inside(sandboxRoot, homeDir), "NCTX-58 E2E HOME must stay within the active sandbox");
  const dbPath = await assertNativeContextTestPath(
    join(homeDir, ".zcodium", "cli", "db", "db.sqlite"),
  );
  if (process.env.ZCODE_SESSION_DB_PATH)
    assert.equal(resolve(process.env.ZCODE_SESSION_DB_PATH), dbPath);
  const node = await assertNativeContextTestPath(
    join(repositoryRoot, ".tmp", "node-v24.14.0-win-x64", "node.exe"),
  );
  const script = await assertNativeContextTestPath(
    join(repositoryRoot, "scripts", "ci", "fixtures", "native-context-large-ledger-seed.ts"),
  );
  const tsconfig = await assertNativeContextTestPath(
    join(
      repositoryRoot,
      "apps",
      "zcode-cli",
      "packages",
      "core",
      "test",
      "tsconfig.native-context-large-ledger.json",
    ),
  );
  const fixtureRoot = await assertNativeContextTestPath(
    join(sandboxRoot, "ledger-seed-" + randomUUID()),
  );
  const paths = Object.fromEntries(
    ["temp", "cache", "config", "logs", "appdata", "local-appdata", "data"].map((name) => [
      name,
      join(fixtureRoot, name),
    ]),
  );
  for (const path of Object.values(paths)) {
    await mkdir(await assertNativeContextTestPath(path), { recursive: true });
    await assertNativeContextTestPath(path);
  }
  const optionsPath = await assertNativeContextTestPath(join(fixtureRoot, "options.json"));
  await writeFile(
    optionsPath,
    JSON.stringify({ sandboxRoot, homeDir, ...input, expectedDbPath: dbPath }) + "\n",
    { flag: "wx" },
  );
  const env = {
    ...process.env,
    PROJECT_TEST_SANDBOX_ROOT: sandboxRoot,
    HOME: homeDir,
    USERPROFILE: homeDir,
    ZCODE_E2E_HOME_DIR: homeDir,
    ZCODE_DESKTOP_HOME_DIR: homeDir,
    ZCODE_DATA_BASE_DIR: homeDir,
    ZCODE_STORAGE_DIR: join(homeDir, ".zcodium"),
    ZCODE_SESSION_DB_PATH: dbPath,
    ZCODE_SESSION_DB: dbPath,
    TEMP: paths.temp,
    TMP: paths.temp,
    TMPDIR: paths.temp,
    APPDATA: paths.appdata,
    LOCALAPPDATA: paths["local-appdata"],
    XDG_CACHE_HOME: paths.cache,
    XDG_CONFIG_HOME: paths.config,
    XDG_DATA_HOME: paths.data,
    ZCODE_LOG_DIR: paths.logs,
    TSX_TSCONFIG_PATH: tsconfig,
    TSX_DISABLE_CACHE: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
    COREPACK_ENABLE_NETWORK: "0",
    ZCODE_LOCAL_RESOURCE_MONITORING: "0",
    NODE_OPTIONS: `--permission --allow-fs-read=* --allow-fs-write=${JSON.stringify(sandboxRoot)} --allow-child-process --allow-worker --allow-addons`,
  };
  const seedLogPath = await assertNativeContextTestPath(join(paths.logs!, "seed.log"));
  let result;
  try {
    result = await run(node, ["--import", "tsx", script, "--options", optionsPath], {
      cwd: repositoryRoot,
      env,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    await writeFile(seedLogPath, `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`, {
      flag: "wx",
    });
    throw Object.assign(new Error("NCTX_LEDGER_SEED_PROCESS_FAILED"), { seedLogPath });
  }
  await writeFile(seedLogPath, result.stdout + "\n" + result.stderr, { flag: "wx" });
  return { sandboxRoot, homeDir, dbPath, result };
}

/** 在 prepareV4 完成且任务空闲之后调用；seed 新随机 session 后才允许 resume 到现有 Host。 */
export async function seedNativeContextLargeLedgerForE2E(input: {
  model: NativeContextObservation["model"];
  version: string;
  hostPreferences?: z.infer<typeof nativeContextLedgerHostPreferencesSchema>;
}) {
  let preferences = input.hostPreferences;
  if (!preferences) {
    if (!(await browser.execute(() => Boolean(window.__remoteProjectHandoffRpc?.ready))))
      await installHandoffRpcProbe();
    const settings = await callHandoffHost<AppSettings>(ServiceChannels.Setting, "get", []);
    // 此合成夹具只接纳已证明的无 Memory/auto shell 配置，不改变 Host 设置来迎合 expected。
    preferences = nativeContextLedgerHostPreferencesSchema.parse({
      memoryEnabled: settings.memoryEnabled,
      integratedTerminalShell: settings.integratedTerminalShell,
      dynamicWorkflowMode: settings.dynamicWorkflowMode,
    });
  }
  const { sandboxRoot, dbPath, result } = await runNativeContextLedgerFixture({
    ...input,
    hostPreferences: preferences,
    mode: "seed",
  });
  const published = z
    .object({ manifestPath: z.string(), sessionId: z.string() })
    .strict()
    .parse(JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1)!));
  const manifestPath = await assertNativeContextTestPath(published.manifestPath);
  assert.ok(inside(sandboxRoot, manifestPath));
  const manifest = nativeContextLedgerManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  assert.equal(manifest.sessionId, published.sessionId);
  assert.equal(manifest.dbPath, dbPath);
  return manifest;
}

export async function verifyNativeContextLargeLedgerForE2E(
  manifest: NativeContextLedgerManifest,
  phase: "seed" | "resume",
) {
  nativeContextLedgerManifestSchema.parse(manifest);
  const { result } = await runNativeContextLedgerFixture({ mode: "verify", manifest, phase });
  const proof = z
    .object({
      phase: z.enum(["seed", "resume"]),
      version: z
        .object({
          revision: z.number().int(),
          generation: z.number().int(),
          historyVersion: z.string(),
          policyVersion: z.number().int(),
          currentSegmentId: z.string(),
        })
        .strict(),
      facts: nativeContextLedgerSeedFactsSchema,
      counts: z
        .object({
          messages: z.literal(5940),
          sources: z.literal(5940),
          observations: z.literal(3000),
          operations: z.literal(15),
          requestSeq: z.literal(2970),
        })
        .strict(),
    })
    .strict()
    .parse(JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1)!));
  assert.equal(proof.phase, phase);
  assert.deepEqual(proof.facts, manifest.seedFacts);
  return proof;
}
