import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
  "actual bootstrap + sandbox + journal: launch/fill hole indexes shift and only remaining holes stay open",
  { timeout: 30000 },
  async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "holes-bootstrap-"));
    const journal = new InMemoryJournalStore();
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
        parentSessionId: "session-1",
        phaseNames: phases.phaseNames,
        trace: {} as never,
      });
      await reached.get(holeSiteId("outer"))!.promise;
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
      await reached.get(holeSiteId("inner"))!.promise;
      const event = journal
        .listEvents(runId, {})
        .find((entry) => entry.event.type === "hole-filled")?.event;
      assert.equal(event?.type, "hole-filled");
      if (event?.type !== "hole-filled") return;
      assert.deepEqual(event.phaseNames, ["A", "outer", "B", "inner", "C", "D"]);
      assert.deepEqual(event.holes, [3]);
      assert.equal(event.phaseNames[event.holes![0]!], "inner");
      const final = await service.fillHole({
        runId,
        holeId: holeSiteId("inner"),
        body: 'return "done";',
        parentSessionId: "session-1",
        trace: {} as never,
      });
      assert.equal(final.ok, true, JSON.stringify(final));
      const done = Promise.withResolvers<void>();
      const unsubscribe = service.subscribeRunSettled(() => done.resolve());
      try {
        await done.promise;
      } finally {
        unsubscribe();
      }
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
