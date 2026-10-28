import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeAgentServiceEvent } from "../../services/src/zcode-agent/zcodeAgent.js";
import { createBackgroundSessionEventCoalescer } from "../../services/src/zcode-agent/zcodeSessionEventCoalescer.js";
import {
  freezeLinearInput,
  linearRandom,
  loadLinearBaseline,
  measureLinearHotpath,
} from "./performanceLinearBaseline.js";

const original = (
  await loadLinearBaseline<{
    createBackgroundSessionEventCoalescer: typeof createBackgroundSessionEventCoalescer;
  }>("coalescer.ts.txt", {})
).createBackgroundSessionEventCoalescer;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function event(
  index: number,
  kind = "text_delta",
  sessionId = "session",
  extra: Record<string, unknown> = {},
): ZCodeAgentServiceEvent {
  return {
    type: "session.event",
    event: {
      type: "model.streaming",
      sessionId,
      turnId: "turn",
      traceId: "trace",
      eventId: `event-${index}`,
      timestamp: index,
      payload: { kind, delta: `中文😀\\"${index}`, ...extra },
    },
  } as unknown as ZCodeAgentServiceEvent;
}

function specialized(
  index: number,
  type: string,
  payload: Record<string, unknown>,
): ZCodeAgentServiceEvent {
  const base = event(index) as Extract<ZCodeAgentServiceEvent, { type: "session.event" }>;
  return { ...base, event: { ...base.event, type, payload } } as ZCodeAgentServiceEvent;
}

type Action = ZCodeAgentServiceEvent | "flush" | "dispose";
function replay(create: typeof original, actions: Action[], maxItems = 96) {
  const emitted: ZCodeAgentServiceEvent[] = [];
  const owner = create({
    emit: (incoming) => emitted.push(incoming),
    flushDelayMs: 60_000,
    maxItems,
  });
  for (const action of actions) {
    if (action === "flush") owner.flush();
    else if (action === "dispose") owner.dispose();
    else owner.accept(action);
  }
  owner.dispose();
  return emitted;
}

describe("linear background event lookup preserves batching and scope", () => {
  it.each([1, 3, 96])("matches complete emitted sequences at maxItems=%i", (maxItems) => {
    vi.useFakeTimers();
    for (let seed = 1; seed <= 100; seed++) {
      const next = linearRandom(seed);
      const actions: Action[] = [];
      for (let index = 0; index < 120; index++) {
        const choice = next(12);
        if (choice === 0) actions.push("flush");
        else if (choice === 1)
          actions.push(
            specialized(index, "tool.updated", {
              kind: "progress",
              inputId: `input-${next(3)}`,
              toolCallId: `tool-${next(4)}`,
              progress: index,
            }),
          );
        else if (choice === 2)
          actions.push(
            specialized(index, "streamRecovery.updated", {
              inputId: `input-${next(3)}`,
              state: index,
            }),
          );
        else if (choice === 3)
          actions.push(specialized(index, "tool.completed", { toolCallId: "tool", result: index }));
        else if (choice === 4)
          actions.push({
            type: "state.updated",
            marker: index,
          } as unknown as ZCodeAgentServiceEvent);
        else
          actions.push(
            event(
              index,
              ["text_delta", "reasoning_delta", "tool_input_delta"][next(3)]!,
              `session-${next(4)}`,
              {
                inputId: `input-${next(3)}`,
                assistantMessageId: `assistant-${next(2)}`,
                toolCallId: `tool-${next(4)}`,
                parentToolUseId: `use-${next(2)}`,
                parentToolCallId: `parent-${next(2)}`,
              },
            ),
          );
      }
      actions.push("dispose", event(900));
      freezeLinearInput(actions);
      expect(
        replay(createBackgroundSessionEventCoalescer, actions, maxItems),
        `events ${seed}`,
      ).toEqual(replay(original, actions, maxItems));
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("retains first-key order, latest metadata and barriers", () => {
    vi.useFakeTimers();
    const a = event(1);
    const b = event(2, "reasoning_delta");
    const actions = [
      a,
      b,
      event(3),
      specialized(4, "tool.updated", { kind: "progress", toolCallId: "t", progress: 1 }),
      specialized(5, "tool.updated", { kind: "progress", toolCallId: "t", progress: 2 }),
      specialized(6, "permission.requested", { toolCallId: "t" }),
    ];
    freezeLinearInput(actions);
    const result = replay(createBackgroundSessionEventCoalescer, actions);
    expect(result).toEqual(replay(original, actions));
    expect(result).toHaveLength(4);
    expect(
      (result[0] as Extract<ZCodeAgentServiceEvent, { type: "session.event" }>).event.payload,
    ).toMatchObject({ delta: '中文😀\\"1中文😀\\"3' });
    expect(
      (result[2] as Extract<ZCodeAgentServiceEvent, { type: "session.event" }>).event.payload,
    ).toMatchObject({ progress: 2 });
  });

  it.each([0, -1, 1500])("keeps original timer boundary at flushDelayMs=%i", (flushDelayMs) => {
    vi.useFakeTimers();
    const before: ZCodeAgentServiceEvent[] = [];
    const after: ZCodeAgentServiceEvent[] = [];
    const current = createBackgroundSessionEventCoalescer({
      emit: (value) => after.push(value),
      flushDelayMs,
    });
    const reference = original({ emit: (value) => before.push(value), flushDelayMs });
    for (let index = 0; index < 5; index++) {
      current.accept(event(index));
      reference.accept(event(index));
    }
    expect(after).toEqual(before);
    vi.advanceTimersByTime(1499);
    expect(after).toEqual(before);
    vi.advanceTimersByTime(1);
    expect(after).toEqual(before);
    current.dispose();
    reference.dispose();
    expect(after).toEqual(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["accept", "flush", "dispose"] as const)(
    "keeps synchronous %s reentrancy at flush",
    (operation) => {
      vi.useFakeTimers();
      const run = (create: typeof original) => {
        const emitted: ZCodeAgentServiceEvent[] = [];
        let first = true;
        const owner = create({
          emit: (value) => {
            emitted.push(value);
            if (first) {
              first = false;
              if (operation === "accept") owner.accept(event(3));
              else owner[operation]();
            }
          },
          flushDelayMs: 60_000,
        });
        owner.accept(event(1));
        owner.accept(event(2, "reasoning_delta"));
        owner.flush();
        owner.flush();
        owner.dispose();
        return emitted;
      };
      expect(run(createBackgroundSessionEventCoalescer)).toEqual(run(original));
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not scan pending keys to find a repeated event", () => {
    vi.useFakeTimers();
    const emitted: ZCodeAgentServiceEvent[] = [];
    const owner = createBackgroundSessionEventCoalescer({
      emit: (value) => emitted.push(value),
      maxItems: 96,
    });
    for (let index = 0; index < 95; index++) owner.accept(event(index, "text_delta", `s-${index}`));
    const find = vi.spyOn(Array.prototype, "find");
    let calls: number;
    try {
      for (let index = 0; index < 1000; index++) owner.accept(event(index, "text_delta", "s-94"));
      calls = find.mock.calls.length;
    } finally {
      find.mockRestore();
    }
    owner.dispose();
    expect(emitted).toHaveLength(95);
    expect(calls).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("records batching time without timing gates", () => {
    const report = [];
    for (const count of [500, 20_000]) {
      const actions = Array.from({ length: count }, (_, index) =>
        event(index, "text_delta", `s-${index % 95}`),
      );
      const options = (create: typeof original) => {
        const owner = create({ emit: () => {}, flushDelayMs: 60_000 });
        for (const action of actions) owner.accept(action);
        owner.dispose();
      };
      expect(replay(createBackgroundSessionEventCoalescer, actions)).toEqual(
        replay(original, actions),
      );
      report.push(
        measureLinearHotpath(
          `background coalescing ${count} events / 95 keys`,
          () => options(original),
          () => options(createBackgroundSessionEventCoalescer),
        ),
      );
    }
    console.info("PERFORMANCE_LINEAR", JSON.stringify(report));
  });
});
