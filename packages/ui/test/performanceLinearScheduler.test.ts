import { describe, expect, it } from "vitest";
import * as errors from "../../../apps/zcode-cli/packages/contracts/src/errors/index.js";
import {
  ToolScheduler,
  type ToolDependency,
} from "../../../apps/zcode-cli/packages/core/src/tool/scheduler.js";
import {
  freezeLinearInput,
  linearRandom,
  loadLinearBaseline,
  measureLinearHotpath,
} from "./performanceLinearBaseline.js";

const OriginalScheduler = (
  await loadLinearBaseline<{ ToolScheduler: typeof ToolScheduler }>("scheduler.ts.txt", {
    "@zcode/contracts": errors,
  })
).ToolScheduler;

function outcome(scheduler: ToolScheduler, tools: ToolDependency[]) {
  try {
    return { schedule: scheduler.schedule(tools) };
  } catch (error) {
    const value = error as errors.CoreError;
    return {
      error: {
        name: value.name,
        message: value.message,
        type: value.type,
        code: value.code,
        context: value.context,
        recoverable: value.recoverable,
        retryable: value.retryable,
      },
    };
  }
}

function tools(count: number, chain = false): ToolDependency[] {
  return Array.from({ length: count }, (_, index) => ({
    toolCallId: `tool-${index}` as ToolDependency["toolCallId"],
    toolName: "Read",
    dependsOn: chain && index ? [`tool-${index - 1}` as ToolDependency["toolCallId"]] : [],
  }));
}

describe("linear tool scheduling preserves admission and ordering", () => {
  it.each([1, 2, 10, 100])("matches original DAGs at concurrency %i", (maxConcurrency) => {
    const current = new ToolScheduler({ maxConcurrency });
    const original = new OriginalScheduler({ maxConcurrency });
    for (let seed = 1; seed <= 120; seed++) {
      const next = linearRandom(seed);
      const input = tools(next(60));
      for (let index = 0; index < input.length; index++) {
        const item = input[index]!;
        item.toolName = ["Read", "Edit", "Unknown", undefined][next(4)];
        item.readOnly = [true, false, undefined][next(3)];
        item.concurrentSafe = [true, false, undefined][next(3)];
        item.destructive = [true, false, undefined][next(3)];
        item.sideEffectScope = ["none", "workspace", "git", undefined][next(4)] as
          | ToolDependency["sideEffectScope"]
          | undefined;
        for (let dep = 0; dep < index; dep++) {
          if (next(9) === 0) item.dependsOn.push(input[dep]!.toolCallId);
        }
      }
      for (let index = input.length - 1; index > 0; index--) {
        const other = next(index + 1);
        [input[index], input[other]] = [input[other]!, input[index]!];
      }
      freezeLinearInput(input);
      expect(outcome(current, input), `DAG ${seed}`).toEqual(outcome(original, input));
    }
  });

  it("matches duplicate IDs, duplicate/missing dependencies, cycles and repeated calls", () => {
    const cases = [
      [],
      tools(12),
      tools(12, true),
      [{ toolCallId: "a", dependsOn: ["missing"] }],
      [{ toolCallId: "a", dependsOn: ["a"] }],
      [
        { toolCallId: "a", dependsOn: [] },
        { toolCallId: "b", dependsOn: ["a", "a"] },
      ],
      [
        { toolCallId: "a", dependsOn: ["b"] },
        { toolCallId: "b", dependsOn: ["a"] },
      ],
      [
        { toolCallId: "a", dependsOn: [] },
        { toolCallId: "a", dependsOn: [] },
      ],
      [
        { toolCallId: "a", dependsOn: [] },
        { toolCallId: "a", dependsOn: ["b"] },
        { toolCallId: "b", dependsOn: [] },
      ],
      [
        { toolCallId: "b", dependsOn: ["a"] },
        { toolCallId: "b", dependsOn: ["c"] },
        { toolCallId: "a", dependsOn: [] },
        { toolCallId: "c", dependsOn: [] },
      ],
      [
        { toolCallId: "a", dependsOn: [] },
        { toolCallId: "b", dependsOn: ["a"] },
        { toolCallId: "a", dependsOn: ["missing"] },
      ],
    ] as ToolDependency[][];
    const current = new ToolScheduler();
    const original = new OriginalScheduler();
    for (const input of [...cases, ...cases.toReversed()]) {
      freezeLinearInput(input);
      expect(outcome(current, input)).toEqual(outcome(original, input));
    }
  });

  it("matches arbitrary duplicate-ID and invalid graphs without changing error context", () => {
    const current = new ToolScheduler();
    const original = new OriginalScheduler();
    for (let seed = 1; seed <= 1000; seed++) {
      const next = linearRandom(seed);
      const input = Array.from({ length: next(18) }, () => ({
        toolCallId: `id-${next(10)}`,
        dependsOn: Array.from({ length: next(5) }, () => `id-${next(12)}`),
        readOnly: next(2) === 0,
        concurrentSafe: [true, false, undefined][next(3)],
      })) as ToolDependency[];
      freezeLinearInput(input);
      expect(outcome(current, input), `invalid graph ${seed}`).toEqual(outcome(original, input));
    }
  });

  it.each([false, true])("uses linear dependency visits for chain=%s", (chain) => {
    const count = 1500;
    const input = tools(count, chain);
    freezeLinearInput(input);
    let visits = 0;
    const measured = input.map((tool) => ({
      ...tool,
      dependsOn: new Proxy(tool.dependsOn, {
        get(target, key, receiver) {
          visits++;
          return Reflect.get(target, key, receiver);
        },
      }),
    }));
    const expected = new OriginalScheduler().schedule(input);
    expect(new ToolScheduler().schedule(measured)).toEqual(expected);
    expect(visits).toBeLessThan(count * 35);
  });

  it("does not move the entire ready queue on each scheduled tool", () => {
    const input = tools(1200);
    const originalShift = Array.prototype.shift;
    let calls = 0;
    Reflect.set(Array.prototype, "shift", function (this: unknown[]) {
      calls++;
      return originalShift.call(this);
    });
    try {
      new ToolScheduler().schedule(input);
    } finally {
      Reflect.set(Array.prototype, "shift", originalShift);
    }
    expect(calls).toBe(0);
  });

  it("records original and current scheduling time without timing gates", () => {
    const report = [];
    for (const count of [50, 500, 1500]) {
      for (const chain of [false, true]) {
        const input = tools(count, chain);
        const before = new OriginalScheduler();
        const after = new ToolScheduler();
        expect(after.schedule(input)).toEqual(before.schedule(input));
        report.push(
          measureLinearHotpath(
            `tool scheduling ${count} ${chain ? "chain" : "independent"}`,
            () => before.schedule(input),
            () => after.schedule(input),
          ),
        );
      }
    }
    console.info("PERFORMANCE_LINEAR", JSON.stringify(report));
  });
});
