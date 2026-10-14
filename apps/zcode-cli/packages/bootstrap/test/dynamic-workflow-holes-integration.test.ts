import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import {
  analyzeWorkflowScript,
  collectPhaseNames,
  holeSiteId,
  InMemoryJournalStore,
} from "@zcode/dynamic-workflow";
import type { DynamicWorkflowRunProgressPayload } from "@zcode/contracts";
import { createDynamicWorkflowRunService } from "../src/app/dynamic-workflow-run-service.js";

it(
  "actual bootstrap + sandbox + journal: failed draft rewrite does not hide committed nested fills",
  { timeout: 30000 },
  async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "holes-bootstrap-"));
    const journal = new InMemoryJournalStore();
    // 引擎仍用真实内存 journal；只补宿主查询面，让详情与快照经过生产投影。
    Object.assign(journal, {
      countNodesByStatus: () => ({ running: 0, completed: 0, failed: 0 }),
      getRunRow: (runId: string) => {
        const row = journal.getRun(runId);
        return row === undefined ? undefined : { ...row, timeCreated: 0, timeUpdated: 0 };
      },
      listRecentLogEvents: () => [],
      listRuns: () => [],
    });
    const draftPath = path.join(cwd, "missing", "workflow.ts");
    const events: DynamicWorkflowRunProgressPayload[] = [];
    const reached = new Map<string, { promise: Promise<void>; resolve: () => void }>();
    for (const name of ["outer", "inner"]) {
      reached.set(holeSiteId(name), Promise.withResolvers<void>());
    }
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
        events.push(event);
        if (event.eventType === "hole-reached") {
          const instance = event.payload.instance as { siteId: string };
          reached.get(instance.siteId)?.resolve();
        }
      },
    });
    try {
      const script = 'phase("A");\nconst x = await hole<string>("outer");\nphase("D");\nreturn x;';
      const analysis = analyzeWorkflowScript(script);
      assert.equal(analysis.ok, true);
      const phases = collectPhaseNames(analysis.flow);
      assert.deepEqual(phases.holes, [1]);
      const { runId } = await service.submit({
        scriptText: script,
        cwd,
        scriptPath: draftPath,
        parentSessionId: "session-1",
        phaseNames: phases.phaseNames,
        trace: {} as never,
      });
      await reached.get(holeSiteId("outer"))!.promise;
      assert.equal((await service.getTask(runId))?.scriptPath, draftPath);
      assert.ok(service.getRunDetail);
      assert.equal((await service.getRunDetail(runId))?.scriptPath, draftPath);
      const launch = journal
        .listEvents(runId, {})
        .find((entry) => entry.event.type === "run-launched")?.event;
      assert.equal(launch?.type, "run-launched");
      if (launch?.type !== "run-launched") return;
      assert.deepEqual(launch.holes, [1]);
      assert.equal(launch.phaseNames?.[launch.holes![0]!], "outer");
      const filled = await service.fillHole({
        runId,
        holeId: holeSiteId("outer"),
        body: 'phase("B");\nconst a = agent("worker");\nconst y = await hole<string>("inner");\nphase("C");\nreturn y;',
        parentSessionId: "session-1",
        trace: {} as never,
      });
      assert.equal(filled.ok, true, JSON.stringify(filled));
      assert.equal(filled.ok && filled.scriptPath, undefined);
      assert.equal((await service.getTask(runId))?.scriptPath, undefined);
      assert.equal((await service.getRunDetail(runId))?.scriptPath, undefined);
      // 新服务没有写回确认，不能从 run-launched 的旧路径重建可用草稿。
      const cold = createDynamicWorkflowRunService({
        journal,
        parentSessionId: "session-1",
        fileSystemPort: {} as never,
        executionPort: {} as never,
        createActorRuntime: () => { throw new Error("no actor expected"); },
      });
      try {
        assert.equal((await cold.getTask(runId))?.scriptPath, undefined);
        assert.ok(cold.getRunDetail);
        assert.equal((await cold.getRunDetail(runId))?.scriptPath, undefined);
      } finally {
        await cold.close();
      }
      await reached.get(holeSiteId("inner"))!.promise;
      // 重启同一个 run 时，启动事件里的源路径也不能重新变成可用草稿。
      assert.equal(await service.cancel(runId, "model"), true);
      await service.waitForTask(runId);
      reached.set(holeSiteId("inner"), Promise.withResolvers<void>());
      const resumed = await service.resume(runId);
      assert.equal(resumed.ok, true, JSON.stringify(resumed));
      assert.equal((await service.getTask(runId))?.scriptPath, undefined);
      assert.equal((await service.getRunDetail(runId))?.scriptPath, undefined);
      await reached.get(holeSiteId("inner"))!.promise;
      const event = journal
        .listEvents(runId, {})
        .find((entry) => entry.event.type === "hole-filled")?.event;
      assert.equal(event?.type, "hole-filled");
      if (event?.type !== "hole-filled") return;
      assert.deepEqual(event.phaseNames, ["A", "outer", "B", "inner", "C", "D"]);
      assert.deepEqual(event.holes, [3]);
      assert.equal(event.phaseNames[event.holes![0]!], "inner");
      // 下次补全重写整份有效脚本成功后，读面重新暴露源路径。
      await mkdir(path.dirname(draftPath));
      const final = await service.fillHole({
        runId,
        holeId: holeSiteId("inner"),
        body: 'return "done";',
        parentSessionId: "session-1",
        trace: {} as never,
      });
      assert.equal(final.ok, true, JSON.stringify(final));
      assert.ok(final.ok && final.scriptText.includes('phase("B")'));
      assert.equal(final.ok && final.scriptPath, draftPath);
      assert.equal(await readFile(draftPath, "utf8"), final.ok && final.scriptText);
      assert.equal((await service.getTask(runId))?.scriptPath, draftPath);
      assert.equal((await service.getRunDetail(runId))?.scriptPath, draftPath);
      // 查询草稿时 run 可能已经结算；等待权威 settlement，避免事后订阅漏掉完成事件。
      await service.waitForTask(runId);
      assert.equal(journal.getRun(runId)?.status, "completed");
      const fills = journal
        .listEvents(runId, {})
        .filter((entry) => entry.event.type === "hole-filled");
      assert.equal(fills.length, 2);
      assert.ok(filled.ok && final.ok);
      assert.equal(filled.commitSequence, fills[0]?.sequence);
      assert.equal(final.commitSequence, fills[1]?.sequence);
      assert.ok(final.commitSequence > filled.commitSequence);
      const notifications = events.filter((entry) => entry.eventType === "hole-filled");
      assert.deepEqual(
        notifications.map((entry) => entry.sequence),
        fills.map((entry) => entry.sequence),
      );
      assert.equal(
        fills[1]?.event.type === "hole-filled" ? fills[1].event.holes : "wrong event",
        undefined,
      );
      // actor 创建不派发 ask，真实引擎事件应采用 fill 重算后的词法出生阶段 B。
      const actor = events.find((entry) => entry.eventType === "actor-created");
      assert.ok(actor);
      assert.equal(actor.payload.phaseName, "B");
    } finally {
      await service.close();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
