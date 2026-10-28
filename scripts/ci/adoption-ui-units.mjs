import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  assertProjectPath,
  createProjectTestSandbox,
  projectRoot,
} from "./project-test-sandbox.mjs";

const files = [
  "packages/ui/test/adoption-model-menu.test.tsx",
  "packages/ui/test/adoption-full-view-editor.test.tsx",
  "packages/ui/test/adoption-full-view-layout.test.tsx",
  "packages/ui/test/adoption-full-view-terminal.test.tsx",
  "packages/ui/test/adoption-tool-search.test.tsx",
  "packages/ui/src/side-pane-full-view/domain/model.test.ts",
  "packages/ui/src/lib/tests/taskSidePaneFullView.test.ts",
  "packages/ui/src/lib/taskSidePaneMemory.test.ts",
  "packages/ui/src/components/ui/collapsible-measurement.test.tsx",
  "packages/desktop/src/host/windowRemoteConnectionRegistry.test.ts",
  "packages/web/src/mobile/windowDirectoryPresentation.test.ts",
];
for (const file of files) await assertProjectPath(join(projectRoot, file));
const sandbox = await createProjectTestSandbox("adoption-ui-units");
const config = join(sandbox.root, "vitest.config.mjs");
await writeFile(
  config,
  `export default ${JSON.stringify(
    {
      root: projectRoot,
      cacheDir: join(sandbox.cache, "vitest"),
      resolve: { alias: { "@": join(projectRoot, "packages/ui/src") } },
      test: {
        include: files,
        cache: false,
        fileParallelism: false,
        maxWorkers: 1,
        environment: "node",
      },
    },
    null,
    2,
  )};\n`,
  { flag: "wx" },
);
const run = promisify(execFile);
let output;
let exitCode = 0;
try {
  output = await run(
    process.execPath,
    [
      join(projectRoot, "node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      config,
      "--configLoader",
      "native",
      "--reporter",
      "tap",
    ],
    { cwd: projectRoot, env: sandbox.env, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  );
} catch (error) {
  exitCode = typeof error.code === "number" ? error.code : 1;
  output = { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
}
await writeFile(join(sandbox.logs, "vitest.log"), `${output.stdout}\n${output.stderr}`, {
  flag: "wx",
});
await writeFile(
  join(sandbox.root, "results.json"),
  `${JSON.stringify({ exitCode, files }, null, 2)}\n`,
  { flag: "wx" },
);
console.log(output.stdout);
console.error(output.stderr);
console.log(`UI unit evidence: ${sandbox.root}`);
process.exitCode = exitCode;
