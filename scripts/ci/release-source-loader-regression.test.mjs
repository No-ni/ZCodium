import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

test("发行检查的完整源码回归显式加载 tsx，保留串行全文件发现", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/desktop.yml", import.meta.url), "utf8"),
  );
  const step = workflow.jobs.checks.steps.find((entry) => entry.name === "Release tests");
  assert.ok(step);
  assert.match(
    step.run,
    /node\s+--import\s+tsx\s+--test\s+--test-concurrency=1\s+scripts\/ci\/\*\.test\.mjs/,
  );
});
