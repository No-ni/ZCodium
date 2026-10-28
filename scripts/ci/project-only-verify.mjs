import { execFile } from "node:child_process";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import {
  assertProjectPath,
  createProjectTestSandbox,
  projectRoot,
} from "./project-test-sandbox.mjs";

const run = promisify(execFile);
const sourceTests = [
  "scripts/ci/project-test-sandbox.test.mjs",
  "scripts/ci/source-test-runner.test.mjs",
  "scripts/ci/source-data-roots.test.mjs",
  "scripts/ci/source-data-root-composition.test.mjs",
  "scripts/ci/sqlite-schema-baseline-entry.test.mjs",
];
const readonlyTests = [
  "scripts/ci/adoption-tool-search-settings.test.mjs",
  "scripts/ci/adoption-source-management.test.mjs",
  "scripts/ci/adoption-source-authorization.test.mjs",
  "scripts/ci/adoption-source-bind-handler.test.mjs",
  "scripts/ci/adoption-source-provisioning-lane.test.mjs",
  "scripts/ci/adoption-source-quota.test.mjs",
  "scripts/ci/adoption-model-menu.test.mjs",
  "scripts/ci/adoption-full-view.test.mjs",
  "scripts/ci/adoption-full-view-workbench.test.mjs",
  "scripts/ci/adoption-composer-toolbar-probe.test.mjs",
  "scripts/ci/sqlite-schema-contract.test.mjs",
  "scripts/ci/bundled-model-catalog.test.mjs",
  "scripts/ci/bundled-model-catalog-projection.test.mjs",
  "scripts/ci/audit-boundaries.test.mjs",
];
const fixtureTests = [
  "scripts/ci/sqlite-infrastructure-regression.test.mjs",
  "scripts/ci/sqlite-startup-adapters.test.mjs",
  "scripts/ci/sqlite-schema-baseline.test.mjs",
  "scripts/ci/adoption-source-inspection-rpc.test.mjs",
];
const formatOwnedFiles = [
  "AGENTS.md",
  ".agents/specs/official-3.16.2-source-data-roots.md",
  ".agents/specs/official-3.16.2-sqlite-migrations.md",
  "scripts/ci/project-only-verify.mjs",
  "scripts/ci/project-test-sandbox.mjs",
  "scripts/ci/project-test-sandbox.d.mts",
  "scripts/ci/project-test-sandbox.test.mjs",
  "scripts/ci/source-test-runner.mjs",
  "scripts/ci/source-test-runner.test.mjs",
  "scripts/ci/source-data-root-composition.test.mjs",
  "scripts/ci/fixtures/source-data-roots.test.mjs",
  "scripts/ci/fixtures/source-data-root-composition.test.mjs",
  "scripts/ci/fixtures/sqlite-infrastructure-regression.test.mjs",
  "scripts/ci/fixtures/sqlite-startup-adapters.test.mjs",
  "scripts/ci/fixtures/sqlite-schema-baseline.test.mjs",
  "scripts/ci/fixtures/adoption-source-inspection-rpc.test.mjs",
  "scripts/ci/sqlite-infrastructure-regression.test.mjs",
  "scripts/ci/sqlite-startup-adapters.test.mjs",
  "scripts/ci/sqlite-schema-baseline.test.mjs",
  "scripts/ci/sqlite-schema-baseline-entry.test.mjs",
  "scripts/ci/adoption-source-inspection-rpc.test.mjs",
  "apps/zcode-cli/packages/adapters/test/source-data-roots.test.ts",
  "apps/zcode-cli/packages/bootstrap/test/session-enumeration-startup.test.ts",
];
const mode = process.argv[2];
if (
  ![
    "source",
    "readonly",
    "fixtures",
    "gates",
    "cli-types",
    "enumeration-types",
    "format-owned",
  ].includes(mode)
) {
  throw new Error("Unknown project-only verification mode");
}
const sandbox = await createProjectTestSandbox(`verify-${mode}`);
console.log(`Project-owned validation: ${sandbox.root}`);
const corepackHome =
  process.env.COREPACK_HOME ??
  join(
    process.env.XDG_CACHE_HOME ?? process.env.LOCALAPPDATA ?? join(homedir(), ".cache"),
    "node",
    "corepack",
  );
const corepack = join(dirname(process.execPath), "node_modules", "corepack", "dist", "corepack.js");
const env = {
  ...sandbox.env,
  COREPACK_HOME: corepackHome,
  COREPACK_DEFAULT_TO_LATEST: "0",
  COREPACK_USE_LATEST: "0",
};
const records = [];
async function execute(name, args, { projectOutputs = false } = {}) {
  const childEnv = { ...env };
  if (projectOutputs) {
    // 类型检查沿既有配置写项目 dist/tsbuildinfo；逐项检查后才扩大为当前项目的 Node 写入白名单。
    const manifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
    for (const config of manifest.scripts.typecheck.split(" ").slice(2)) {
      const directory = config.endsWith(".json") ? dirname(config) : config;
      await assertProjectPath(join(projectRoot, directory));
      for (const output of ["dist", "out"]) {
        await assertProjectPath(join(projectRoot, directory, output));
      }
    }
    const cliDirectories = (
      await readdir(join(projectRoot, "apps/zcode-cli/packages"), { withFileTypes: true })
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(projectRoot, "apps/zcode-cli/packages", entry.name));
    for (const directory of cliDirectories) {
      await assertProjectPath(directory);
      await assertProjectPath(join(directory, "dist"));
    }
    await assertProjectPath(
      join(projectRoot, "apps/zcode-cli/packages/dynamic-workflow/src/compiler/libs.generated.ts"),
    );
    childEnv.NODE_OPTIONS = childEnv.NODE_OPTIONS.replace(
      `--allow-fs-write=${JSON.stringify(sandbox.root)}`,
      `--allow-fs-write=${JSON.stringify(projectRoot)}`,
    );
  }
  let result;
  let exitCode = 0;
  try {
    result = await run(process.execPath, args, {
      cwd: projectRoot,
      env: childEnv,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    exitCode = typeof error.code === "number" ? error.code : 1;
    result = { stdout: error.stdout ?? "", stderr: error.stderr ?? String(error.code ?? "failed") };
  }
  const logPath = join(sandbox.logs, `${name}.log`);
  await writeFile(logPath, `${result.stdout}\n${result.stderr}`, { flag: "wx" });
  const tests = Number(/^# tests (\d+)$/m.exec(result.stdout)?.[1] ?? 0);
  records.push({ name, exitCode, tests, logPath });
  console.log(`${name}: exit ${exitCode}${tests ? `, ${tests} tests` : ""}; ${logPath}`);
  if (exitCode !== 0) console.log(`${result.stdout}\n${result.stderr}`.slice(-10000));
}

if (mode === "source" || mode === "readonly" || mode === "fixtures") {
  const files =
    mode === "source" ? sourceTests : mode === "fixtures" ? fixtureTests : readonlyTests;
  for (const file of files) {
    await assertProjectPath(join(projectRoot, file));
    await execute(file.split("/").at(-1).replace(".test.mjs", ""), [
      "--import",
      "tsx",
      "--test",
      "--test-reporter=tap",
      file,
    ]);
  }
} else if (mode === "enumeration-types") {
  await execute("enumeration-typecheck", [
    join(projectRoot, "node_modules/typescript/bin/tsc"),
    "--noEmit",
    "-p",
    "apps/zcode-cli/packages/bootstrap/test/tsconfig.session-enumeration.json",
  ]);
  await execute("source-cli-typecheck", [
    join(projectRoot, "node_modules/typescript/bin/tsc"),
    "--noEmit",
    "-p",
    "apps/zcode-cli/packages/adapters/test/tsconfig.source-data-roots.json",
  ]);
} else if (mode === "format-owned") {
  const formatEnv = { ...env };
  const paths = await Promise.all(
    formatOwnedFiles.map((path) => assertProjectPath(join(projectRoot, path))),
  );
  formatEnv.NODE_OPTIONS = `${formatEnv.NODE_OPTIONS} ${paths.map((path) => `--allow-fs-write=${JSON.stringify(path)}`).join(" ")}`;
  const result = await run(
    process.execPath,
    [join(projectRoot, "node_modules/oxfmt/bin/oxfmt"), ...paths],
    {
      cwd: projectRoot,
      env: formatEnv,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  await writeFile(join(sandbox.logs, "format-owned.log"), `${result.stdout}\n${result.stderr}`, {
    flag: "wx",
  });
  console.log(result.stdout);
} else if (mode === "cli-types") {
  await execute("cli-typecheck", [corepack, "pnpm", "--dir", "apps/zcode-cli", "typecheck"], {
    projectOutputs: true,
  });
} else {
  if (!isAbsolute(corepackHome) || !(await lstat(corepack)).isFile()) {
    throw new Error("Installed Corepack is unavailable; validation does not install tools");
  }
  await execute("root-typecheck", [corepack, "pnpm", "typecheck"], { projectOutputs: true });
  await execute("root-lint", [corepack, "pnpm", "lint"]);
  await execute("root-format", [corepack, "pnpm", "fmt:check"]);
  await execute("architecture", [corepack, "pnpm", "architecture:check", "--changed"]);
  await execute("cli-lint", [corepack, "pnpm", "--dir", "apps/zcode-cli", "lint"]);
  await execute("cli-registry", [corepack, "pnpm", "--dir", "apps/zcode-cli", "registry:check"]);
}
await writeFile(join(sandbox.root, "results.json"), `${JSON.stringify(records, null, 2)}\n`, {
  flag: "wx",
});
process.exitCode = records.some(({ exitCode }) => exitCode !== 0) ? 1 : 0;
