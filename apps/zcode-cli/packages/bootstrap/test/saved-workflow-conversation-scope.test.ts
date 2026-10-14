import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { zcodeWorkflowsRunsResultSchema } from "@zcode/shared";
import { runSqliteSessionMigrations } from "../../adapters/src/storage/session-store/migration-runner.js";
import { createDwfJournalStore } from "../../adapters/src/storage/session-store/repositories/dwf-journal.js";
import { listSavedWorkflowRunsOp } from "../src/zcode-protocol/saved-workflows.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

it("projects the parent workspace for global workflow history while retaining the execution cwd", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    runSqliteSessionMigrations(db, ":memory:");
    const journal = createDwfJournalStore(db);
    const cwd = "/workspace/default/2026-10-13/aaaaaaaa";
    journal.createRun({
      runId: "run",
      parentSessionId: "parent",
      cwd,
      name: "report",
      status: "completed",
      spentTokens: 0,
      caps: { maxConcurrency: 1 },
    });
    const context = {
      deps: {
        sessionStore: {
          workflowJournalStore: () => journal,
          getSession: async () => ({ directory: "/workspace/default" }),
        },
      },
    } as unknown as ZCodeProtocolAgentServerContext;
    const result = zcodeWorkflowsRunsResultSchema.parse(
      await listSavedWorkflowRunsOp(context, {
        workspace: { workspaceKey: "/workspace/default", workspacePath: "/workspace/default" },
        scope: "global",
        limit: 10,
      }),
    );
    assert.equal(result.runs[0]?.workspacePath, "/workspace/default");
    assert.equal(result.runs[0]?.cwd, cwd);
  } finally {
    db.close();
  }
});
