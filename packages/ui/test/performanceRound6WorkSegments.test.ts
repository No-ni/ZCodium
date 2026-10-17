import { describe, expect, it } from "vitest";
import {
  turnHeaderRowSchema,
  userInputRowSchema,
  type TurnHeaderRow,
  type TurnWorkSegment,
  type UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { buildConversationTurnWorkSegments } from "@/v4/conversationTurnWorkSegments.js";

function user(index: number, entityId: string | undefined = `input-${index}`): UserInputRow {
  return userInputRowSchema.parse({
    kind: "userInput",
    rowId: index + 1,
    turnId: "turn",
    createdAt: 100 + index * 10,
    createdAtSeq: index,
    origin: "realUser",
    text: `query ${index}`,
    entityId,
    ...(index > 0 ? { guided: true } : {}),
  });
}

function header(facts?: TurnWorkSegment[]): TurnHeaderRow {
  return turnHeaderRowSchema.parse({
    kind: "turnHeader",
    rowId: 0,
    turnId: "turn",
    createdAt: 100,
    createdAtSeq: 0,
    origin: "userInput",
    executionKind: "agent",
    startedAt: 100,
    state: "running",
    workSegments: facts,
  });
}

function fact(index: number, extra: Partial<TurnWorkSegment> = {}): TurnWorkSegment {
  return {
    segmentId: `segment-${index}`,
    triggerEntityId: `input-${index}`,
    startedAt: 100 + index,
    ...extra,
  };
}

function build(rows: UserInputRow[], source?: TurnHeaderRow, running = true, nowMs = 1000) {
  return buildConversationTurnWorkSegments({
    key: "turn",
    header: source,
    orderedRows: rows,
    assistantTailRows: [],
    isRunning: running,
    isLastTurn: true,
    isInterrupted: false,
    forceOpenHistory: false,
    timelineOnly: false,
    nowMs,
  });
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

describe("guide work-segment fact lookup", () => {
  it("uses a linear trigger lookup budget across 1,000 guide segments", () => {
    const count = 1000;
    const rows = freeze(Array.from({ length: count }, (_, i) => user(i)));
    const source = header(Array.from({ length: count }, (_, i) => fact(count - i - 1)));
    let reads = 0;
    for (const entry of source.workSegments!) {
      const id = entry.triggerEntityId;
      Object.defineProperty(entry, "triggerEntityId", {
        get: () => {
          reads += 1;
          return id;
        },
      });
      Object.freeze(entry);
    }
    const result = build(rows, source);
    expect(result).toHaveLength(count);
    expect(result.at(-1)?.workStatus).toEqual({
      state: "running",
      durationMs: 0,
      liveStartedAt: 1099,
    });
    expect(reads).toBeLessThanOrEqual(count * 4);
    expect(reads).toBe(count);
  });

  it("keeps first matching facts, positional fallback and one timing source", () => {
    const rows = freeze([user(0), user(1), user(2, undefined), user(3, "missing"), user(4)]);
    // undefined 默认参数需显式移除，模拟兼容旧行。
    const withoutId = { ...rows[2]! };
    delete withoutId.entityId;
    const facts = [
      fact(9, { activeMs: 9 }),
      fact(1, { activeMs: 17, endedAt: 999 }),
      fact(2, { activeMs: 23 }),
      fact(1, { activeMs: 99 }),
      fact(4, { startedAt: 1200 }),
    ];
    const result = build(
      freeze([rows[0]!, rows[1]!, withoutId, rows[3]!, rows[4]!]),
      freeze(header(facts)),
    );
    expect(result.map((segment) => segment.workStatus)).toEqual([
      { state: "completed", durationMs: 9 },
      { state: "completed", durationMs: 17 },
      { state: "completed", durationMs: 23 },
      { state: "completed", durationMs: 99 },
      { state: "running", durationMs: 0, liveStartedAt: 1200 },
    ]);
    expect(result[1]?.triggerRow).toBe(rows[1]);
  });

  it("retains legacy snapshot boundaries and control-only behavior", () => {
    const rows = freeze([user(0), user(1), user(2)]);
    expect(build(rows, freeze(header())).map((s) => s.workStatus)).toEqual([
      { state: "completed", durationMs: 10 },
      { state: "completed", durationMs: 10 },
      { state: "running", durationMs: 880, liveStartedAt: 120 },
    ]);
    const ended = freeze({ ...header(), endedAt: 150, state: "completedSuccess" as const });
    expect(build(rows, ended, false).at(-1)?.workStatus).toEqual({
      state: "completed",
      durationMs: 30,
    });
    expect(
      build(rows, freeze({ ...ended, executionKind: "controlOnly" as const }), false).every(
        (segment) => segment.workStatus === undefined,
      ),
    ).toBe(true);
    expect(build([user(0)], freeze({ ...header(), activeMs: 7 }))[0]?.workStatus).toEqual({
      state: "running",
      durationMs: 7,
    });
  });

  it("does not scan facts for a single visual segment", () => {
    const source = header([fact(0, { activeMs: 12 })]);
    Object.defineProperty(source.workSegments![0], "triggerEntityId", {
      get: () => {
        throw new Error("single segment must use its positional fact");
      },
    });
    expect(build([user(0)], source)[0]?.workStatus).toEqual({ state: "running", durationMs: 12 });
  });

  it("rebuilds same-ID facts and follows original find semantics for mixed tables", () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const rows = freeze(Array.from({ length: 40 }, (_, i) => user(i)));
      const facts = Array.from({ length: 50 }, (_, i) =>
        fact((i * seed + 7) % 45, {
          segmentId: `fact-${i}`,
          startedAt: 500 + i,
          ...(i % 3 === 0 ? { activeMs: i } : i % 3 === 1 ? { endedAt: 550 + i } : {}),
        }),
      );
      const source = freeze(header(facts));
      for (const running of [true, false]) {
        const result = build(rows, source, running);
        result.forEach((segment, index) => {
          const expectedFact =
            (segment.triggerRow?.entityId
              ? source.workSegments?.find(
                  (candidate) => candidate.triggerEntityId === segment.triggerRow?.entityId,
                )
              : undefined) ?? source.workSegments?.[index];
          const isRunning = running && index === rows.length - 1;
          const legacyStart = segment.triggerRow?.createdAt ?? source.startedAt;
          const legacyEnd = result[index + 1]?.triggerRow?.createdAt ?? source.endedAt;
          const legacyDuration =
            legacyEnd !== undefined
              ? Math.max(0, legacyEnd - legacyStart)
              : isRunning
                ? Math.max(0, 1000 - legacyStart)
                : undefined;
          const duration =
            expectedFact?.activeMs ??
            (expectedFact?.endedAt !== undefined
              ? Math.max(0, expectedFact.endedAt - expectedFact.startedAt)
              : expectedFact && isRunning
                ? Math.max(0, 1000 - expectedFact.startedAt)
                : legacyDuration);
          expect(segment.workStatus).toEqual(
            duration !== undefined || isRunning
              ? {
                  state: isRunning ? "running" : "completed",
                  ...(duration !== undefined ? { durationMs: duration } : {}),
                  ...(isRunning &&
                  expectedFact &&
                  expectedFact.activeMs === undefined &&
                  expectedFact.endedAt === undefined
                    ? { liveStartedAt: expectedFact.startedAt }
                    : {}),
                }
              : undefined,
          );
        });
      }
      const changed = freeze({
        ...source,
        workSegments: source.workSegments!.map((entry) => ({ ...entry, activeMs: 77 })),
      });
      expect(build(rows, changed).at(-1)?.workStatus).toEqual({ state: "running", durationMs: 77 });
    }
  });
});
