import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { createTurnId, type TraceContext } from "@zcode/contracts";
import {
  createRuntimeCommandId,
  createRuntimeCommandQueue,
  type RuntimeCommand,
  type RuntimeCommandId,
  type RuntimeCommandMode,
  type RuntimeCommandPriority,
  type RuntimeCommandQueue,
} from "../src/runtime/command-queue.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import {
  acquireForegroundPromotionLease,
  drainRuntimeCommandQueue,
  releaseForegroundPromotionLease,
} from "../src/runtime/methods/runtime-command-queue.js";
import { drainPendingRuntimeCommandsForActiveLoop } from "../src/runtime/methods/runtime-command-active-loop.js";
import { isStaleBranchRuntimeCommand } from "../src/runtime/methods/runtime-command-generation.js";

// 固定 bcdb14b1 的完整队列算法：cancel、重复 ID、priority 与 batch 语义都属于 oracle。
function legacyQueue(): RuntimeCommandQueue {
  const commands: RuntimeCommand[] = [];
  const cancelPendingCommandIds = new Set<RuntimeCommandId>();
  const priorityOrder: Record<RuntimeCommandPriority, number> = { now: 0, next: 1, later: 2 };
  const selectNextIndex = (maxPriority?: RuntimeCommandPriority): number => {
    let selectedIndex = -1;
    let selectedPriority = Infinity;
    const maxPriorityRank = maxPriority === undefined ? Infinity : priorityOrder[maxPriority];
    for (const [index, command] of commands.entries()) {
      const priority = priorityOrder[command.priority];
      if (priority > maxPriorityRank) continue;
      if (priority < selectedPriority) {
        selectedIndex = index;
        selectedPriority = priority;
      }
    }
    return selectedIndex;
  };
  return {
    clearCancelPending: (id) => {
      cancelPendingCommandIds.delete(id);
    },
    consumeCancelPending: (id) => cancelPendingCommandIds.delete(id),
    dequeue() {
      const index = selectNextIndex();
      return index === -1 ? undefined : commands.splice(index, 1)[0];
    },
    dequeueNextBatch() {
      const index = selectNextIndex();
      if (index === -1) return Object.freeze([]);
      const selected = commands[index];
      if (selected?.mode !== "task-notification") {
        const [command] = commands.splice(index, 1);
        return Object.freeze(command ? [command] : []);
      }
      const batch = commands.filter(
        (command) => command.mode === "task-notification" && command.priority === selected.priority,
      );
      for (let commandIndex = commands.length - 1; commandIndex >= 0; commandIndex -= 1) {
        const command = commands[commandIndex];
        if (command?.mode === "task-notification" && command.priority === selected.priority)
          commands.splice(commandIndex, 1);
      }
      return Object.freeze(batch);
    },
    enqueue: (command) => {
      commands.push(command);
    },
    getByMaxPriority: (maxPriority) =>
      Object.freeze(
        commands.filter((command) => priorityOrder[command.priority] <= priorityOrder[maxPriority]),
      ),
    hasPending: () => commands.length > 0,
    markCancelPending: (id) => {
      cancelPendingCommandIds.add(id);
    },
    removeById(id) {
      const index = commands.findIndex((command) => command.id === id);
      return index === -1 ? undefined : commands.splice(index, 1)[0];
    },
    size: () => commands.length,
    snapshot: () => Object.freeze([...commands]),
  };
}

const PRIORITIES = ["now", "next", "later"] as const;
const MODES: RuntimeCommandMode[] = [
  "prompt",
  "target-continuation",
  "target-continuation-loop",
  "task-notification",
  "subagent-message",
  "control-only-turn",
];
const TRACE = Object.freeze({
  traceId: "trace_performance_fixture",
  spanId: "span_performance_fixture",
}) as TraceContext;

function command(
  mode: RuntimeCommandMode,
  priority: RuntimeCommandPriority,
  id: RuntimeCommandId = createRuntimeCommandId(),
): RuntimeCommand {
  const base = { createdAt: new Date(0), id, priority, traceContext: TRACE };
  const reject = () => undefined;
  const resolve = () => undefined;
  switch (mode) {
    case "prompt":
      return {
        ...base,
        mode,
        input: "fixture",
        reject,
        resolve,
        options: { inputId: String(id), abortSignal: new AbortController().signal },
        startReservation: { kind: "regular", traceContext: TRACE, turnId: createTurnId() },
      };
    case "target-continuation":
      return {
        ...base,
        mode,
        options: { traceContext: TRACE, inputId: String(id) },
        reject,
        resolve,
      };
    case "target-continuation-loop":
      return {
        ...base,
        mode,
        options: { traceContext: TRACE, inputId: String(id), trigger: "manual" },
        reject,
        resolve,
      };
    case "task-notification":
      return { ...base, mode, branchGeneration: 0, source: "background_task", text: "fixture" };
    case "subagent-message":
      return {
        ...base,
        mode,
        branchGeneration: 0,
        source: "subagent_message",
        responseId: String(id),
        agentId: String(id),
        agentType: "fixture",
        childSessionId: "child_fixture",
        childToolCallId: "child_tool_fixture",
        summary: "fixture",
        messageLength: 7,
        text: "fixture",
      };
    case "control-only-turn":
      return {
        ...base,
        mode,
        branchGeneration: 0,
        text: "fixture",
        titleInput: "fixture",
        inputId: String(id),
        workflowLaunch: { runId: "run_fixture", toolCallId: "launch_fixture", name: "fixture" },
      };
  }
}

function assertSameReferences(
  actual: readonly RuntimeCommand[],
  expected: readonly RuntimeCommand[],
): void {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < actual.length; index += 1)
    assert.strictEqual(actual[index], expected[index]);
  assert.equal(Object.isFrozen(actual), true);
  assert.equal(Object.isFrozen(expected), true);
}

function assertQueueState(actual: RuntimeCommandQueue, expected: RuntimeCommandQueue): void {
  assert.equal(actual.size(), expected.size());
  assert.equal(actual.hasPending(), expected.hasPending());
  assertSameReferences(actual.snapshot(), expected.snapshot());
  for (const priority of PRIORITIES)
    assertSameReferences(actual.getByMaxPriority(priority), expected.getByMaxPriority(priority));
}

test("runtime queue preserves priority, batch and remaining references for every mode", () => {
  for (const firstMode of MODES) {
    for (const firstPriority of PRIORITIES) {
      const items = [
        command(firstMode, firstPriority),
        ...MODES.flatMap((mode) => PRIORITIES.map((priority) => command(mode, priority))),
      ];
      for (const item of items) Object.freeze(item);
      const actual = createRuntimeCommandQueue();
      const expected = legacyQueue();
      for (const item of items) {
        actual.enqueue(item);
        expected.enqueue(item);
      }
      const captured = actual.snapshot();
      while (actual.hasPending()) {
        assertSameReferences(actual.dequeueNextBatch(), expected.dequeueNextBatch());
        assertQueueState(actual, expected);
      }
      assertSameReferences(actual.dequeueNextBatch(), expected.dequeueNextBatch());
      assertSameReferences(captured, Object.freeze([...items]));
    }
  }
});

test("runtime queue retains duplicate-ID first removal and independent cancel markers", () => {
  const id = createRuntimeCommandId();
  const a = command("task-notification", "next", id);
  const b = command("prompt", "later", id);
  const c = command("task-notification", "next", id);
  for (const makeQueue of [legacyQueue, createRuntimeCommandQueue]) {
    const queue = makeQueue();
    queue.markCancelPending(id);
    for (const item of [a, b, c]) queue.enqueue(item);
    assert.strictEqual(queue.removeById(id), a);
    assertSameReferences(queue.dequeueNextBatch(), Object.freeze([c]));
    assert.strictEqual(queue.dequeue(), b);
    assert.equal(queue.consumeCancelPending(id), true);
    assert.equal(queue.consumeCancelPending(id), false);
    queue.markCancelPending(id);
    queue.clearCancelPending(id);
    assert.equal(queue.consumeCancelPending(id), false);
    assert.equal(queue.removeById(id), undefined);
  }
});

test("runtime queue preserves mutable command references and detached frozen snapshots", () => {
  const queue = createRuntimeCommandQueue();
  const notice = command("task-notification", "next");
  const retained = command("prompt", "later");
  assert.ok(retained.mode === "prompt");
  queue.enqueue(notice);
  queue.enqueue(retained);
  const before = queue.snapshot();
  const batch = queue.dequeueNextBatch();
  assertSameReferences(batch, Object.freeze([notice]));
  assert.equal(Object.isFrozen(notice), false);
  assert.equal(Object.isFrozen(retained), false);
  assert.strictEqual(queue.snapshot()[0], retained);
  assert.strictEqual(queue.snapshot()[0]!.traceContext, retained.traceContext);
  assertSameReferences(before, Object.freeze([notice, retained]));
  const next = command("task-notification", "now");
  queue.enqueue(next);
  assertSameReferences(batch, Object.freeze([notice]));
  assertSameReferences(queue.dequeueNextBatch(), Object.freeze([next]));
  assert.strictEqual(queue.dequeue(), retained);
});

function randomSequence(): () => number {
  let state = 0x14bcdb41;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

test("runtime queue matches the complete frozen oracle through deterministic mixed operations", () => {
  const random = randomSequence();
  const actual = createRuntimeCommandQueue();
  const expected = legacyQueue();
  const ids: RuntimeCommandId[] = [];
  for (let iteration = 0; iteration < 3_000; iteration += 1) {
    const id = ids[random() % Math.max(ids.length, 1)] ?? createRuntimeCommandId();
    switch (random() % 8) {
      case 0:
      case 1:
      case 2: {
        const item = Object.freeze(
          command(
            MODES[random() % MODES.length]!,
            PRIORITIES[random() % PRIORITIES.length]!,
            random() % 3 === 0 ? id : createRuntimeCommandId(),
          ),
        );
        ids.push(item.id);
        actual.enqueue(item);
        expected.enqueue(item);
        break;
      }
      case 3:
        assertSameReferences(actual.dequeueNextBatch(), expected.dequeueNextBatch());
        break;
      case 4:
        assert.strictEqual(actual.dequeue(), expected.dequeue());
        break;
      case 5:
        assert.strictEqual(actual.removeById(id), expected.removeById(id));
        break;
      case 6:
        actual.markCancelPending(id);
        expected.markCancelPending(id);
        break;
      case 7:
        if (random() % 2 === 0) {
          actual.clearCancelPending(id);
          expected.clearCancelPending(id);
        } else assert.equal(actual.consumeCancelPending(id), expected.consumeCancelPending(id));
        break;
    }
    assertQueueState(actual, expected);
  }
  for (const id of ids)
    assert.equal(actual.consumeCancelPending(id), expected.consumeCancelPending(id));
});

test("runtime queue keeps foreground promotion and cancellation checks ahead of ordinary priority", async () => {
  const queue = createRuntimeCommandQueue();
  const pending = command("subagent-message", "next");
  const promoted = command("prompt", "later");
  assert.ok(promoted.mode === "prompt");
  const controller = new AbortController();
  const cancelReason = new Error("cancel_fixture");
  let rejected: unknown;
  const cancelled = {
    ...promoted,
    options: { ...promoted.options, inputId: "promoted_fixture", abortSignal: controller.signal },
    reject: (error: unknown) => {
      rejected = error;
    },
  };
  controller.abort(cancelReason);
  const released: string[] = [];
  const runtime = {
    runtimeCommandQueue: queue,
    branchGeneration: 0,
    foregroundPromotionLease: undefined,
    drainRuntimeCommandQueue: async () => undefined,
    releaseTurnStart: (id: string) => released.push(id),
    executeTurnCommand: async () => assert.fail("cancelled promoted command must not execute"),
  } as unknown as AgentRuntimeInternal;
  queue.enqueue(pending);
  assert.deepEqual(
    acquireForegroundPromotionLease.call(runtime, {
      leaseId: "lease_fixture",
      mode: "idle-only",
      promotedInputId: "promoted_fixture",
    }),
    { kind: "busy" },
  );
  assert.deepEqual(
    acquireForegroundPromotionLease.call(runtime, {
      leaseId: "lease_fixture",
      mode: "after-current",
      promotedInputId: "promoted_fixture",
    }),
    { kind: "acquired", leaseId: "lease_fixture" },
  );
  assert.deepEqual(
    acquireForegroundPromotionLease.call(runtime, {
      leaseId: "other_fixture",
      mode: "after-current",
      promotedInputId: "promoted_fixture",
    }),
    { kind: "conflict", leaseId: "lease_fixture" },
  );
  assert.equal(releaseForegroundPromotionLease.call(runtime, "other_fixture"), false);
  await drainRuntimeCommandQueue.call(runtime);
  assertSameReferences(queue.snapshot(), Object.freeze([pending]));
  queue.removeById(pending.id);
  queue.enqueue(cancelled);
  queue.markCancelPending(cancelled.id);
  await drainRuntimeCommandQueue.call(runtime);
  assert.equal(runtime.foregroundPromotionLease, undefined);
  assert.deepEqual(released, [cancelled.startReservation!.turnId]);
  assert.ok(rejected instanceof Error);
  assert.equal(queue.consumeCancelPending(cancelled.id), false);
  assert.equal(runtime.activeForegroundExecution, undefined);
});

test("runtime queue preserves active-loop control-only barrier and stale generation", async () => {
  const queue = createRuntimeCommandQueue();
  const control = command("control-only-turn", "next");
  const notice = command("task-notification", "next");
  queue.enqueue(control);
  queue.enqueue(notice);
  const runtime = {
    runtimeCommandQueue: queue,
    branchGeneration: 0,
  } as unknown as AgentRuntimeInternal;
  const result = await drainPendingRuntimeCommandsForActiveLoop.call(runtime);
  assert.equal(result.drained, 0);
  assertSameReferences(queue.snapshot(), Object.freeze([control, notice]));
  assert.equal(isStaleBranchRuntimeCommand(runtime, notice), false);
  runtime.branchGeneration = 1;
  assert.equal(isStaleBranchRuntimeCommand(runtime, notice), true);
  assert.equal(isStaleBranchRuntimeCommand(runtime, command("prompt", "next")), false);
});

interface QueueWork {
  priorityReads: number;
  spliceCalls: number;
  shiftedSlots: number;
}

function measureQueueWork(
  queue: RuntimeCommandQueue,
  items: readonly RuntimeCommand[],
): { batch: readonly RuntimeCommand[]; work: QueueWork } {
  const work: QueueWork = { priorityReads: 0, spliceCalls: 0, shiftedSlots: 0 };
  let countPriority = true;
  const probes = items.map(
    (item) =>
      new Proxy(item, {
        get(target, key, receiver) {
          if (countPriority && key === "priority") work.priorityReads += 1;
          return Reflect.get(target, key, receiver);
        },
      }),
  );
  for (const item of probes) queue.enqueue(item);
  const expectedBatch = probes.filter((item) => item.mode === "task-notification");
  const expectedRetained = probes.filter((item) => item.mode !== "task-notification");
  const splice = Array.prototype.splice;
  Array.prototype.splice = function (
    start: number,
    deleteCount?: number,
    ...insertions: unknown[]
  ) {
    if (deleteCount === 1 && insertions.length === 0) {
      work.spliceCalls += 1;
      work.shiftedSlots += this.length - start - 1;
    }
    return Reflect.apply(splice, this, [start, deleteCount, ...insertions]);
  };
  try {
    const batch = queue.dequeueNextBatch();
    countPriority = false;
    assertSameReferences(batch, Object.freeze(expectedBatch));
    assertSameReferences(queue.snapshot(), Object.freeze(expectedRetained));
    return { batch, work };
  } finally {
    Array.prototype.splice = splice;
  }
}

function interleavedItems(count: number): RuntimeCommand[] {
  return Array.from({ length: count }, (_, index) => [
    command("task-notification", "next"),
    command(index % 2 === 0 ? "subagent-message" : "control-only-turn", "next"),
  ]).flat();
}

test("work budget: interleaved notification removal does not shift the retained queue quadratically", (context) => {
  const count = 1_000;
  const items = interleavedItems(count);
  const measured = measureQueueWork(createRuntimeCommandQueue(), items);
  assert.equal(measured.batch.length, count);
  context.diagnostic(JSON.stringify({ commands: items.length, ...measured.work }));
  assert.deepEqual(measured.work, {
    priorityReads: items.length * 2,
    spliceCalls: 0,
    shiftedSlots: 0,
  });
});

test("work budget: frozen queue oracle accounts for every retained-slot shift", () => {
  const count = 1_000;
  const measured = measureQueueWork(legacyQueue(), interleavedItems(count));
  assert.equal(measured.work.spliceCalls, count);
  assert.equal(measured.work.shiftedSlots, (count * (count + 1)) / 2);
});

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

const BENCHMARK_ENABLED = process.execArgv.includes("--test-name-pattern=benchmark");

test(
  "benchmark: alternating frozen and current notification compaction",
  { skip: !BENCHMARK_ENABLED },
  (context) => {
    let checksum = 0;
    for (const fixture of [
      { name: "small-mixed", items: interleavedItems(8) },
      { name: "1000-pairs", items: interleavedItems(1_000) },
      { name: "5000-pairs", items: interleavedItems(5_000) },
      { name: "10000-pairs", items: interleavedItems(10_000) },
      {
        name: "pure-10000-notifications",
        items: Array.from({ length: 10_000 }, () => command("task-notification", "next")),
      },
    ]) {
      const sample = (create: () => RuntimeCommandQueue) => {
        const queue = create();
        for (const item of fixture.items) queue.enqueue(item);
        const started = performance.now();
        const batch = queue.dequeueNextBatch();
        const elapsed = performance.now() - started;
        checksum ^= batch.length + queue.size();
        return elapsed;
      };
      for (let warmup = 0; warmup < 6; warmup += 1) {
        sample(legacyQueue);
        sample(createRuntimeCommandQueue);
      }
      const oldMs: number[] = [];
      const currentMs: number[] = [];
      for (let iteration = 0; iteration < 25; iteration += 1) {
        if (iteration % 2 === 0) {
          oldMs.push(sample(legacyQueue));
          currentMs.push(sample(createRuntimeCommandQueue));
        } else {
          currentMs.push(sample(createRuntimeCommandQueue));
          oldMs.push(sample(legacyQueue));
        }
      }
      const oldWork = measureQueueWork(legacyQueue(), fixture.items).work;
      const currentWork = measureQueueWork(createRuntimeCommandQueue(), fixture.items).work;
      context.diagnostic(
        JSON.stringify({
          node: process.version,
          fixture: fixture.name,
          commands: fixture.items.length,
          oldMedianMs: median(oldMs),
          currentMedianMs: median(currentMs),
          oldMs,
          currentMs,
          oldWork,
          currentWork,
        }),
      );
    }
    assert.equal(typeof checksum, "number");
  },
);
