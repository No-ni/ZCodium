import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { runSqliteSessionMigrations } from "../../adapters/src/storage/session-store/migration-runner.js";
import { createDwfJournalStore } from "../../adapters/src/storage/session-store/repositories/dwf-journal.js";
import { createRunIntrospectionMethods } from "../src/app/dynamic-workflow-run-introspection.js";
import type { RunRegistryEntry } from "../src/app/dynamic-workflow-run-observation.js";
import { createWorkflowEscalationRegistry } from "../src/app/workflow-escalation-registry.js";
import { listWorkflowRunsToolEntry } from "../../core/src/tool/handlers/list-workflow-runs.js";
import type { ToolExecutionContext } from "../../core/src/tool/types.js";

it("lists sibling conversation runs through the model tool even after Bash changes cwd", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    runSqliteSessionMigrations(db, ":memory:");
    const journal = createDwfJournalStore(db);
    const root = "/workspace/default";
    for (const [id, directory, cwd] of [
      ["current", root, `${root}/2026-10-13/aaaaaaaa`],
      ["sibling", root, `${root}/2026-10-13/bbbbbbbb`],
      ["foreign", "/workspace/other", "/workspace/other"],
    ]) {
      db.prepare(
        "insert into session (id,project_id,slug,directory,path,title,version,time_created,time_updated) values (?,?,?,?,?,?,?,?,?)",
      ).run(id!, "project", id!, directory!, cwd!, id!, "1", 1, 1);
      journal.createRun({
        runId: id!,
        parentSessionId: id!,
        cwd: cwd!,
        status: "completed",
        spentTokens: 0,
        caps: { maxConcurrency: 1 },
      });
    }
    const methods = createRunIntrospectionMethods({
      journal,
      introspection: journal as Parameters<
        typeof createRunIntrospectionMethods
      >[0]["introspection"],
      parentSessionId: "current",
      workspaceDirectory: root,
      runs: new Map(),
      escalations: createWorkflowEscalationRegistry(),
      concurrencyCeiling: () => 1,
    });
    const list = async (workingDirectory: string, workspaceScopeRoot?: string) => {
      const output = await listWorkflowRunsToolEntry.handler({}, {
        workingDirectory,
        workspaceScopeRoot,
        dynamicWorkflowRunPort: methods,
      } as unknown as ToolExecutionContext);
      return (output as { runs: { runId: string; ownedByThisSession: boolean }[] }).runs;
    };
    for (const cwd of [`${root}/2026-10-13/aaaaaaaa`, `${root}/2026-10-13/aaaaaaaa/nested`]) {
      const rows = await list(cwd, root);
      assert.deepEqual(rows.map((row) => row.runId).sort(), ["current", "sibling"]);
      assert.equal(rows.find((row) => row.runId === "current")?.ownedByThisSession, true);
      assert.equal(rows.find((row) => row.runId === "sibling")?.ownedByThisSession, false);
    }
    assert.deepEqual(
      (await list(`${root}/2026-10-13/aaaaaaaa`)).map((row) => row.runId),
      ["current"],
    );
  } finally {
    db.close();
  }
});

it("keeps a newly submitted independent-directory run visible before its journal row exists", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    runSqliteSessionMigrations(db, ":memory:");
    const journal = createDwfJournalStore(db);
    const entry: RunRegistryEntry = {
      controller: new AbortController(),
      startedAt: new Date(1),
      cwd: "/workspace/default/2026-10-13/aaaaaaaa",
      scriptText: "return 1;",
      settlement: Promise.resolve({ status: "completed", result: 1 }),
    };
    const methods = createRunIntrospectionMethods({
      journal,
      introspection: journal as Parameters<
        typeof createRunIntrospectionMethods
      >[0]["introspection"],
      parentSessionId: "parent",
      workspaceDirectory: "/workspace/default",
      runs: new Map([["new-run", entry]]),
      escalations: createWorkflowEscalationRegistry(),
      concurrencyCeiling: () => 1,
    });
    assert.deepEqual(
      (await methods.listRuns({ cwd: "/workspace/default", limit: 10 })).runs.map(
        (run) => run.runId,
      ),
      ["new-run"],
    );
    assert.equal((await methods.listRuns({ cwd: "/workspace/other", limit: 10 })).runs.length, 0);
    assert.equal(
      (await methods.listRuns({ cwd: "/workspace/default", statuses: ["completed"], limit: 10 }))
        .runs.length,
      0,
    );
    assert.equal((await methods.listRuns({ cwd: "/workspace/default", limit: 0 })).truncated, true);
    // 已落库却被状态过滤的 run 不能靠注册表补集重新出现。
    journal.createRun({
      runId: "new-run",
      parentSessionId: "parent",
      cwd: entry.cwd,
      status: "completed",
      spentTokens: 0,
      caps: { maxConcurrency: 1 },
    });
    assert.equal(
      (await methods.listRuns({ cwd: "/workspace/default", statuses: ["running"], limit: 10 })).runs
        .length,
      0,
    );
  } finally {
    db.close();
  }
});
