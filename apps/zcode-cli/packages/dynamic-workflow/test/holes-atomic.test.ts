import assert from "node:assert/strict";
import { it } from "node:test";
import {
  InMemoryJournalStore,
  WorkflowEngine,
  type RunEvent,
  type WorkflowDriver,
  type HoleFill,
} from "../src/index.js";

class FailingJournal extends InMemoryJournalStore {
  fail = false;
  override appendEvent(runId: string, event: RunEvent) {
    const stored = super.appendEvent(runId, event);
    if (this.fail && event.type === "hole-filled") throw new Error("injected append failure");
    return stored;
  }
}

it("atomic fill failure preserves durable script/events, engine tables and parked promises; success emits once", async () => {
  const journal = new FailingJournal();
  const emitted: RunEvent[] = [];
  const askSpecs = new Map();
  const sitePhases = new Map();
  const config = {
    runId: "atomic-run",
    driver: { journal, emit: (event: RunEvent) => emitted.push(event) } as WorkflowDriver,
    caps: { maxConcurrency: 1 },
    askSpecs,
    sitePhases,
    validate: (() => true) as never,
    scriptText: "old",
    scriptHash: "old-hash",
  };
  const engine = new WorkflowEngine(config);
  let released = false;
  const parked = engine.hole("hole#12345678", "A").then((value) => {
    released = true;
    return value;
  });
  const before = {
    run: journal.getRun(config.runId),
    events: journal.listEvents(config.runId),
    open: engine.openHoles(),
  };
  const fill: HoleFill = {
    siteId: "hole#12345678",
    code: "compiled-body",
    script: { text: "new", hash: "new-hash" },
    askSpecs: new Map(),
    sitePhases: new Map(),
    phaseNames: ["A", "new"],
  };
  journal.fail = true;
  assert.throws(() => engine.fillHole(fill), /injected append failure/);
  await Promise.resolve();
  assert.equal(released, false);
  assert.deepEqual(journal.getRun(config.runId), before.run);
  assert.deepEqual(journal.listEvents(config.runId), before.events);
  assert.deepEqual(engine.openHoles(), before.open);
  assert.deepEqual(engine.filledHoles(), []);
  const tables = engine as unknown as { askSpecs: unknown; sitePhases: unknown };
  assert.equal(tables.askSpecs, askSpecs);
  assert.equal(tables.sitePhases, sitePhases);
  assert.equal(emitted.filter((event) => event.type === "hole-filled").length, 0);
  // 原基线仍能恢复；失败提交不得把 resume hash 换掉。
  assert.doesNotThrow(() => new WorkflowEngine(config));
  journal.fail = false;
  const result = engine.fillHole(fill);
  assert.ok(result.ok);
  assert.deepEqual(await parked, { code: "compiled-body" });
  assert.equal(tables.askSpecs, fill.askSpecs);
  assert.equal(tables.sitePhases, fill.sitePhases);
  const fills = journal
    .listEvents(config.runId)
    .filter((entry) => entry.event.type === "hole-filled");
  assert.equal(fills.length, 1);
  assert.equal(result.commitSequence, fills[0]?.sequence);
  assert.equal(emitted.filter((event) => event.type === "hole-filled").length, 1);
  assert.equal(journal.getRun(config.runId)?.scriptText, "new");
  assert.equal(journal.getRun(config.runId)?.scriptHash, "new-hash");
});
