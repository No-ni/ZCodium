import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { nativeContextModelSchema } from "@zcode/shared/native-context-compression";
import {
  nativeContextLedgerHostPreferencesSchema,
  nativeContextLedgerManifestSchema,
} from "../../../packages/desktop/test/e2e/helpers/native-context-compression/ledger-fixture-contract.js";
import { assertProjectPath } from "../project-test-sandbox.mjs";
import {
  seedNativeContextLargeLedger,
  resolveNativeContextLedgerSeedPaths,
} from "../../../apps/zcode-cli/packages/core/test/native-context-large-ledger-seed.js";
import { verifyNativeContextLedgerSnapshot } from "../../../apps/zcode-cli/packages/core/test/native-context-ledger-resume-context.js";

const index = process.argv.indexOf("--options");
const optionsPath = process.argv[index + 1];
const activeSandbox = process.env.PROJECT_TEST_SANDBOX_ROOT;
if (index < 0 || !optionsPath || !activeSandbox || !isAbsolute(optionsPath))
  throw new Error("NCTX_LEDGER_SEED_OPTIONS_REQUIRED");
const optionsFile = await assertProjectPath(resolve(optionsPath));
const suffix = relative(resolve(activeSandbox), optionsFile);
if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix))
  throw new Error("NCTX_LEDGER_SEED_OPTIONS_OUTSIDE_SANDBOX");
const paths = {
  sandboxRoot: z.string(),
  homeDir: z.string(),
  expectedDbPath: z.string(),
};
const options = z
  .discriminatedUnion("mode", [
    z
      .object({
        mode: z.literal("seed"),
        ...paths,
        model: nativeContextModelSchema,
        version: z.string().min(1),
        hostPreferences: nativeContextLedgerHostPreferencesSchema,
      })
      .strict(),
    z
      .object({
        mode: z.literal("verify"),
        ...paths,
        phase: z.enum(["seed", "resume"]),
        manifest: nativeContextLedgerManifestSchema,
      })
      .strict(),
  ])
  .parse(JSON.parse(await readFile(optionsFile, "utf8")));
if (options.mode === "seed") {
  const result = await seedNativeContextLargeLedger(options);
  console.log(
    JSON.stringify({ manifestPath: result.manifestPath, sessionId: result.manifest.sessionId }),
  );
} else {
  const paths = await resolveNativeContextLedgerSeedPaths({
    ...options,
    model: options.manifest.model,
    version: "verify",
  });
  if (
    paths.dbPath !== options.manifest.dbPath ||
    paths.workspacePath !== options.manifest.workspacePath ||
    paths.homeDir !== options.manifest.homeDir ||
    paths.sandboxRoot !== options.manifest.sandboxRoot
  )
    throw new Error("NCTX_LEDGER_VERIFY_SCOPE_MISMATCH");
  console.log(
    JSON.stringify(await verifyNativeContextLedgerSnapshot(options.manifest, options.phase)),
  );
}
