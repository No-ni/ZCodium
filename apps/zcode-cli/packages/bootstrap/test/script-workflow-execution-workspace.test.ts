import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ScriptWorkflowRunRecord } from "@zcode/contracts";
import {
  ScriptWorkflowRuntime,
  type ScriptWorkflowRuntimeDeps,
} from "../src/app/script-workflow-runtime.js";

test("legacy workflow freezes resumed runtime cwd for the script and delayed children", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcodium-script-workflow-cwd-"));
  try {
    const execution = join(root, "2026-10-14", "12345678");
    const later = join(execution, "later");
    await mkdir(later, { recursive: true });
    const scriptPath = join(root, "fixture.mjs");
    await writeFile(
      scriptPath,
      `export const meta = {name: "fixture", description: "fixture"};
       const fs = await import("node:fs/promises");
       await fs.writeFile("script-marker.txt", "before");
       await agent("fixture");
       await fs.writeFile("script-marker.txt", "after");
       return "done";`,
    );
    let currentCwd = root;
    let run: ScriptWorkflowRunRecord;
    const childDirectories: string[] = [];
    const deps = {
      workingDirectory: root,
      workspaceDirectory: root,
      sessionId: "sess_parent",
      traceContext: { traceId: "fixture", spanId: "fixture", sessionId: "sess_parent" },
      runtime: {
        ensureSessionPersistedForExternalActivity: async () => {},
        getWorkingDirectory: () => currentCwd,
      },
      prepareUserExecutionBoundary: async () => {
        // 模拟 create-app 的 prepareResume：恢复之前装配根，之后执行 cwd 取持久化 path。
        currentCwd = execution;
      },
      fileSystemPort: {
        readTextFile: async ({ path }: { path: string }) => ({
          content: await readFile(path, "utf8"),
          truncated: false,
        }),
      },
      sessionStore: {
        upsertScriptWorkflowDefinition: async () => ({ id: "definition" }),
        createScriptWorkflowRun: async (input: ScriptWorkflowRunRecord) => {
          run = { ...input, status: "pending", createdAt: Date.now() };
          return run;
        },
        updateScriptWorkflowRun: async (input: Partial<ScriptWorkflowRunRecord>) => {
          run = { ...run, ...input };
          return run;
        },
        getScriptWorkflowRun: async () => run,
        listScriptWorkflowActivities: async () => [],
        findCachedScriptWorkflowActivity: async () => null,
        createScriptWorkflowActivity: async (input: unknown) => input,
        appendScriptWorkflowEvent: async ({ type }: { type: string }) => {
          if (type === "workflow_started") currentCwd = later;
        },
      },
    } as unknown as ScriptWorkflowRuntimeDeps;
    const runtime = new ScriptWorkflowRuntime(deps);
    // 只替换模型执行点，真实脚本进程和父/子请求链照常运行；捕获迟到 child 的 run cwd。
    const liveAgent = runtime as unknown as {
      runLiveAgent: (...args: unknown[]) => Promise<unknown>;
    };
    liveAgent.runLiveAgent = async (_run, _activity, _input, workingDirectory) => {
      childDirectories.push(workingDirectory as string);
      return { value: "fixture", stats: { tokens: { total: 0 } } };
    };
    const result = await runtime.run({ scriptPath });
    assert.equal(result.status, "completed");
    assert.equal(currentCwd, later);
    assert.deepEqual(childDirectories, [execution]);
    assert.equal(run!.cwd, root, "run cwd remains the workspace enumeration key");
    assert.equal(await readFile(join(execution, "script-marker.txt"), "utf8"), "after");
    for (const directory of [root, later]) {
      await assert.rejects(stat(join(directory, "script-marker.txt")), { code: "ENOENT" });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
