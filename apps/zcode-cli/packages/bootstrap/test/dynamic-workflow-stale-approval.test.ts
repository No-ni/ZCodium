import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { InMemoryJournalStore, holeSiteId } from "@zcode/dynamic-workflow";
import { createDynamicWorkflowRunService } from "../src/app/dynamic-workflow-run-service.js";

it(
  "real sandbox: approval B bound to old script refuses after successful A without durable or live side effects",
  { timeout: 30000 },
  async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "holes-stale-"));
    const journal = new InMemoryJournalStore();
    const reached = new Set<string>();
    const waiting = Promise.withResolvers<void>();
    const service = createDynamicWorkflowRunService({
      journal,
      parentSessionId: "session-1",
      availableParallelism: () => 2,
      fileSystemPort: {} as never,
      executionPort: {} as never,
      createActorRuntime: () => {
        throw new Error("no actor expected");
      },
      onRunEvent: (event) => {
        if (event.eventType !== "hole-reached") return;
        reached.add((event.payload.instance as { siteId: string }).siteId);
        if (reached.size === 2) waiting.resolve();
      },
    });
    try {
      const scriptText =
        'async function a() { return await hole<string>("A"); }\nasync function b() { return await hole<string>("B"); }\nreturn await Promise.all([a(), b()]);';
      const { runId } = await service.submit({
        scriptText,
        cwd,
        parentSessionId: "session-1",
        trace: {} as never,
      });
      await waiting.promise;
      // 审批 B 的预览基线取端口存档字节，与 core resolve 完全同规；A 在批准等待期间补全。
      const oldScript = await service.getScript(runId);
      assert.ok(oldScript);
      const expectedScriptHash = createHash("sha256").update(oldScript).digest("hex");
      const first = await service.fillHole({
        runId,
        holeId: holeSiteId("A"),
        body: 'return "a";',
        trace: {} as never,
      });
      assert.ok(first.ok);
      const before = {
        run: journal.getRun(runId),
        events: journal.listEvents(runId),
        script: await service.getScript(runId),
      };
      const stale = await service.fillHole({
        runId,
        holeId: holeSiteId("B"),
        body: 'return "b";',
        expectedScriptHash,
        trace: {} as never,
      });
      assert.equal(stale.ok ? "success" : stale.reason, "fill_preview_stale");
      assert.deepEqual(
        {
          run: journal.getRun(runId),
          events: journal.listEvents(runId),
          script: await service.getScript(runId),
        },
        before,
      );
      assert.equal(
        (await service.getTask(runId))?.holes?.find((hole) => hole.siteId === holeSiteId("B"))
          ?.state,
        "waiting",
      );
      const fresh = await service.fillHole({
        runId,
        holeId: holeSiteId("B"),
        body: 'return "b";',
        expectedScriptHash: createHash("sha256").update(before.script!).digest("hex"),
        trace: {} as never,
      });
      assert.ok(fresh.ok);
      assert.ok(fresh.commitSequence > first.commitSequence);
      assert.equal(
        journal.listEvents(runId).filter((entry) => entry.event.type === "hole-filled").length,
        2,
      );
    } finally {
      await service.close();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
