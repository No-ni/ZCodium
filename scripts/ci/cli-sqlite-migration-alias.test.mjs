import assert from "node:assert/strict";
import { build } from "esbuild";
import test from "node:test";
import { resolveBuildAliases } from "../../apps/zcode-cli/packages/cli/scripts/build.mjs";

for (const format of ["cjs", "esm"]) {
  test(`CLI ${format} bundle resolves the SQLite migration entry through production aliases`, async () => {
    const result = await build({
      stdin: {
        contents:
          'export { inspectMigrations, migrate, retrySqliteBusy, withShortBusyTimeout } from "@zcode/shared/sqlite-migrations";',
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      platform: "node",
      format,
      metafile: true,
      alias: resolveBuildAliases(),
      logLevel: "silent",
    });
    assert.equal(result.errors.length, 0);
    assert.ok(
      Object.keys(result.metafile.inputs).some((file) =>
        file.replaceAll("\\", "/").endsWith("packages/shared/src/sqlite-migrations/index.ts"),
      ),
      "the bundle must load the shared public entry rather than the generic barrel alias",
    );
  });
}
