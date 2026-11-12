import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type { NativeContextObservation } from "@zcode/shared/native-context-compression";
import { assertProjectPath } from "../../../../../scripts/ci/project-test-sandbox.mjs";
import { createNativeContextLargeLedgerData } from "./native-context-large-ledger-data.js";
import { nativeContextLedgerManifestSchema } from "../../../../../packages/desktop/test/e2e/helpers/native-context-compression/ledger-fixture-contract.js";
import {
  calculateNativeContextLedgerResumeExpected,
  createNativeContextLedgerResumeRecipe,
  readNativeContextLedgerSnapshot,
  type NativeContextLedgerHostPreferences,
} from "./native-context-ledger-resume-context.js";

export interface NativeContextLedgerSeedOptions {
  sandboxRoot: string;
  homeDir: string;
  model: NativeContextObservation["model"];
  version: string;
  /** Host 集成时传它实际启动的 DB 路径；不允许默默 seed 到另一个数据库。 */
  expectedDbPath?: string;
  /** Desktop 从真实公开设置读取；source fixture 显式维持同一无 Memory/auto shell 边界。 */
  hostPreferences?: NativeContextLedgerHostPreferences;
}

function contained(parent: string, child: string) {
  const suffix = relative(parent, child);
  return !!suffix && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

export async function resolveNativeContextLedgerSeedPaths(input: NativeContextLedgerSeedOptions) {
  const activeSandbox = process.env.PROJECT_TEST_SANDBOX_ROOT;
  if (!activeSandbox || !isAbsolute(input.sandboxRoot) || !isAbsolute(input.homeDir))
    throw new Error("NCTX_LEDGER_SANDBOX_REQUIRED");
  const sandboxRoot = await assertProjectPath(resolve(input.sandboxRoot));
  const active = await assertProjectPath(resolve(activeSandbox));
  if (sandboxRoot !== active && !contained(active, sandboxRoot))
    throw new Error("NCTX_LEDGER_SANDBOX_MISMATCH");
  if (
    !(await lstat(sandboxRoot)).isDirectory() ||
    relative(sandboxRoot, await realpath(sandboxRoot))
  )
    throw new Error("NCTX_LEDGER_SANDBOX_INVALID");
  const homeDir = await assertProjectPath(resolve(input.homeDir));
  if (!contained(sandboxRoot, homeDir)) throw new Error("NCTX_LEDGER_HOME_OUTSIDE_SANDBOX");
  const workspacePath = await assertProjectPath(join(homeDir, "ZCodeProject"));
  const dbPath = await assertProjectPath(join(homeDir, ".zcodium", "cli", "db", "db.sqlite"));
  if (
    input.expectedDbPath !== undefined &&
    (!isAbsolute(input.expectedDbPath) || resolve(input.expectedDbPath) !== dbPath)
  )
    throw new Error("NCTX_LEDGER_HOST_DB_MISMATCH");
  return { sandboxRoot, homeDir, workspacePath, dbPath };
}

/** 新随机任务尚未公布给 Host；原生账本一次原子提交，发布后只由 Host 管理 membership。 */
export async function seedNativeContextLargeLedger(input: NativeContextLedgerSeedOptions) {
  const paths = await resolveNativeContextLedgerSeedPaths(input);
  const namespace = `nctx-ledger-${randomUUID()}`;
  const data = createNativeContextLargeLedgerData({ ...input, ...paths, namespace });
  for (const directory of [paths.workspacePath, parse(paths.dbPath).dir]) {
    await mkdir(await assertProjectPath(directory), { recursive: true });
    await assertProjectPath(directory);
  }
  const store = await createSqliteSessionStore({ dbPath: paths.dbPath });
  try {
    if (store.getDatabasePath() !== paths.dbPath || (await store.getSession(data.session.id)))
      throw new Error("NCTX_LEDGER_SESSION_NOT_NEW");
    await store.createSession(data.session);
    await store.commitMessageBundle({ sessionID: data.session.id, messages: data.messages });
    if (await store.getNativeContextState(data.session.id))
      throw new Error("NCTX_LEDGER_STATE_EXISTS");
    await store.commitNativeContext(data.session.id, data.commit);
  } finally {
    store.close();
  }
  const snapshot = await readNativeContextLedgerSnapshot(paths.dbPath, data.session.id!);
  const hostPreferences = input.hostPreferences ?? { memoryEnabled: false as const };
  const recipe = await createNativeContextLedgerResumeRecipe({
    ...paths,
    sessionId: String(data.session.id),
    hostPreferences,
  });
  const resumeExpected = await calculateNativeContextLedgerResumeExpected(
    snapshot.messages,
    recipe,
  );
  const manifest = nativeContextLedgerManifestSchema.parse({
    ...data.manifest,
    hostPreferences,
    seedFacts: snapshot.facts,
    resumeExpected,
  });
  // 原因：不能让仍打开 seed writer 的半成品任务被 Host 挂载；manifest 是完成后的发布点。
  const manifestPath = await assertProjectPath(join(paths.sandboxRoot, `${namespace}.json`));
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  return { manifestPath, manifest };
}
