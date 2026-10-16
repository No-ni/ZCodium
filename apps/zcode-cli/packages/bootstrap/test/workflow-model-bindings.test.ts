import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryJournalStore, holeSiteId } from "@zcode/dynamic-workflow";
import { createDynamicWorkflowRunService } from "../src/app/dynamic-workflow-run-service.js";
import {
  resolveActorPersonaModel,
  workflowActorModelPolicy,
} from "../src/app/workflow-actor-model.js";
import { readRunModelBindings } from "../src/app/dynamic-workflow-run-launch-anchor.js";

it("persona binding wins over run selection and journal pin; missing binding fails loudly", () => {
  const actorSelection = resolveActorPersonaModel("fast", { fast: "p/fast$high" })!;
  const policy = workflowActorModelPolicy(
    {
      actorSelection,
      runSelection: { providerId: "q", modelId: "default" },
      parentSelection: { providerId: "parent", modelId: "model" },
    },
    "malformed",
  );
  assert.deepEqual(policy.configOverrides.modelSelection, actorSelection);
  assert.equal(actorSelection.providerId, "p");
  assert.throws(() => resolveActorPersonaModel("missing", {}), /9011/);
  assert.throws(() => resolveActorPersonaModel("toString", {}), /9011/);
});

it(
  "real sandbox commits merged fill bindings atomically and cold resume keeps them",
  { timeout: 30000 },
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "workflow-bindings-"));
    const journal = new InMemoryJournalStore();
    Object.assign(journal, { countNodesByStatus: () => ({ running: 0, completed: 0, failed: 0 }) });
    const signals = new Map(
      ["one", "two", "tail"].map((name) => [holeSiteId(name), Promise.withResolvers<void>()]),
    );
    const makeService = () =>
      createDynamicWorkflowRunService({
        journal,
        parentSessionId: "s",
        fileSystemPort: {} as never,
        executionPort: {} as never,
        createActorRuntime: () => {
          throw new Error("no ask");
        },
        onRunEvent: (event) => {
          if (event.eventType === "hole-reached")
            signals.get((event.payload.instance as { siteId: string }).siteId)?.resolve();
        },
      });
    const service = makeService();
    let cold: ReturnType<typeof makeService> | undefined;
    try {
      const script =
        'agent("base", { model: "base" }); const one = await hole<string>("one"); const two = await hole<string>("two"); return await hole<string>("tail");';
      const { runId } = await service.submit({
        scriptText: script,
        cwd,
        modelBindings: { base: { providerId: "p", modelId: "base" } },
        trace: {} as never,
      });
      await signals.get(holeSiteId("one"))!.promise;
      const original = journal.getRun(runId)!.scriptText;
      const unresolved = await service.fillHole({
        runId,
        holeId: holeSiteId("one"),
        body: 'agent("new", { model: "fast" }); return "one";',
        trace: {} as never,
      });
      assert.equal(unresolved.ok, false);
      assert.equal(!unresolved.ok && unresolved.diagnostics?.[0]?.code, 9011);
      assert.equal(journal.getRun(runId)!.scriptText, original);
      assert.deepEqual(readRunModelBindings(journal, runId), { base: "p/base" });
      const commit = journal.commitHoleFill.bind(journal);
      journal.commitHoleFill = () => {
        throw new Error("injected commit failure");
      };
      await assert.rejects(
        service.fillHole({
          runId,
          holeId: holeSiteId("one"),
          body: 'agent("new", { model: "fast" }); return "one";',
          modelBindings: { fast: { providerId: "p", modelId: "fast" } },
          trace: {} as never,
        }),
        /injected/,
      );
      assert.equal(journal.getRun(runId)!.scriptText, original);
      assert.deepEqual((await service.getTask(runId))?.modelBindings, { base: "p/base" });
      journal.commitHoleFill = commit;
      const first = await service.fillHole({
        runId,
        holeId: holeSiteId("one"),
        body: 'agent("new", { model: "fast" }); return "one";',
        modelBindings: {
          base: { providerId: "evil", modelId: "changed" },
          fast: { providerId: "p", modelId: "fast" },
        },
        trace: {} as never,
      });
      assert.equal(first.ok, true, JSON.stringify(first));
      await signals.get(holeSiteId("two"))!.promise;
      const second = await service.fillHole({
        runId,
        holeId: holeSiteId("two"),
        body: 'agent("deep", { model: "deep" }); return "two";',
        modelBindings: {
          deep: { providerId: "p", modelId: "deep", options: { reasoningLevel: "high" } },
        },
        trace: {} as never,
      });
      assert.equal(second.ok, true, JSON.stringify(second));
      await signals.get(holeSiteId("tail"))!.promise;
      assert.deepEqual(readRunModelBindings(journal, runId), {
        base: "p/base",
        fast: "p/fast",
        deep: "p/deep$high",
      });
      const fills = journal
        .listEvents(runId, {})
        .filter((stored) => stored.event.type === "hole-filled");
      assert.equal(fills.length, 2);
      assert.ok(first.ok && second.ok && second.commitSequence > first.commitSequence);
      await service.close();
      signals.set(holeSiteId("tail"), Promise.withResolvers<void>());
      cold = makeService();
      assert.deepEqual((await cold.getTask(runId))?.modelBindings, {
        base: "p/base",
        fast: "p/fast",
        deep: "p/deep$high",
      });
      const resumed = await cold.resume(runId);
      assert.equal(resumed.ok, true, JSON.stringify(resumed));
      await signals.get(holeSiteId("tail"))!.promise;
      assert.deepEqual((await cold.getTask(runId))?.modelBindings, {
        base: "p/base",
        fast: "p/fast",
        deep: "p/deep$high",
      });
      assert.equal(
        journal.listEvents(runId, {}).filter((stored) => stored.event.type === "hole-filled")
          .length,
        2,
      );
    } finally {
      await service.close();
      await cold?.close();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

it(
  "real launch and fill pass the committed persona model to the actor factory",
  { timeout: 30000 },
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "workflow-persona-"));
    const journal = new InMemoryJournalStore();
    const reached = Promise.withResolvers<void>();
    const received: unknown[] = [];
    const service = createDynamicWorkflowRunService({
      journal,
      parentSessionId: "session",
      fileSystemPort: {} as never,
      executionPort: {} as never,
      createActorRuntime: (input) => {
        received.push(input.actorModel);
        // 验收只检查工厂准入实参；在模型调用与用户数据写入之前结束。
        throw new Error("actor factory fixture stops here");
      },
      onRunEvent: (event) => {
        if (event.eventType === "hole-reached") reached.resolve();
      },
    });
    try {
      await assert.rejects(
        service.submit({
          scriptText: 'agent("a", { model: "missing" });',
          cwd,
          trace: {} as never,
        }),
        /9011/,
      );
      assert.equal(received.length, 0);
      const direct = await service.submit({
        scriptText: 'const a = agent("a", { model: "fast" }); await a.ask("hello");',
        cwd,
        modelBindings: {
          fast: { providerId: "p", modelId: "fast", options: { reasoningLevel: "high" } },
        },
        subagentModel: { providerId: "default", modelId: "other" },
        trace: {} as never,
      });
      await service.waitForTask(direct.runId);
      const run = await service.submit({
        scriptText: 'return await hole<string>("work");',
        cwd,
        trace: {} as never,
      });
      await reached.promise;
      const filled = await service.fillHole({
        runId: run.runId,
        holeId: holeSiteId("work"),
        body: 'const a = agent("a", { model: "deep" }); return await a.ask<string>("hello");',
        modelBindings: { deep: { providerId: "q", modelId: "deep" } },
        trace: {} as never,
      });
      assert.equal(filled.ok, true, JSON.stringify(filled));
      await service.waitForTask(run.runId);
      assert.deepEqual(received, [
        { providerId: "p", modelId: "fast", options: { reasoningLevel: "high" } },
        { providerId: "q", modelId: "deep" },
      ]);
    } finally {
      await service.close();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
