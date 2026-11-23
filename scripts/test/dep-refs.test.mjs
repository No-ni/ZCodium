import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");

test(
  "reference queries connect public source symbols with UI and nested CLI consumers",
  { timeout: 180_000 },
  async () => {
    for (const [file, name, consumer] of [
      ["packages/ui/src/hooks/useAppPanels.ts", "useAppPanels", "packages/ui/src/App.tsx"],
      [
        "apps/zcode-cli/packages/contracts/src/tools/tool-search.ts",
        "ToolSearchInputSchema",
        "apps/zcode-cli/packages/core/src/tool/handlers/tool-search.ts",
      ],
    ]) {
      const { stdout } = await run(
        process.execPath,
        ["scripts/dep-refs.mjs", `${file}:${name}`, "--json"],
        { cwd: root, windowsHide: true, maxBuffer: 1024 * 1024 },
      );
      const report = JSON.parse(stdout);
      assert.ok(
        report.references.some((reference) => reference.file.replaceAll("\\", "/") === consumer),
        `${name}: missing public-source consumer ${consumer}`,
      );
    }
  },
);
