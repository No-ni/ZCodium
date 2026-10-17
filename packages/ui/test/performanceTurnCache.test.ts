import { describe, expect, it } from "vitest";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";
import { ConversationTurnRenderCache } from "@/v4/conversationTurnRenderCache.js";

function turn(id: number, running = false): ConversationRow[] {
  const base = { turnId: `t${id}`, createdAt: 100, createdAtSeq: id };
  return [
    {
      ...base,
      rowId: id * 3,
      kind: "turnHeader",
      executionKind: "agent",
      state: running ? "running" : "completedSuccess",
      startedAt: 100,
      ...(running ? {} : { endedAt: 300 }),
    },
    { ...base, rowId: id * 3 + 1, kind: "userInput", origin: "realUser", text: "question" },
    {
      ...base,
      rowId: id * 3 + 2,
      kind: "assistantText",
      text: "answer",
      state: running ? "streaming" : "final",
    },
  ] as ConversationRow[];
}
describe("turn rendering cache", () => {
  it("retains a clock anchor when a remote start time is ahead of the renderer", () => {
    const units = buildConversationTurnRenderUnits(turn(1, true), { nowMs: 50 });
    expect(units[0]?.workSegments?.[0]?.workStatus).toMatchObject({
      durationMs: 0,
      liveStartedAt: 100,
    });
  });
  it("reuses history and invalidates only changed immutable rows", () => {
    const rows = [...turn(1), ...turn(2, true)];
    const cache = new ConversationTurnRenderCache();
    const first = buildConversationTurnRenderUnits(rows, { cache, nowMs: 400 });
    const nextRows = [...rows];
    nextRows[5] = { ...nextRows[5], text: "new answer" } as ConversationRow;
    const next = buildConversationTurnRenderUnits(nextRows, { cache, nowMs: 600 });
    expect(next[0]).toBe(first[0]);
    expect(next[1]).not.toBe(first[1]);
    expect(next).toEqual(buildConversationTurnRenderUnits(nextRows, { nowMs: 600 }));
    expect(next[1]?.workSegments?.[0]?.workStatus?.liveStartedAt).toBe(100);
    expect(first[0]?.workSegments?.[0]?.workStatus?.liveStartedAt).toBeUndefined();
  });
  it("handles rewind, same-ID replacement and a newly appended last turn", () => {
    const cache = new ConversationTurnRenderCache();
    const history = turn(1);
    buildConversationTurnRenderUnits([...history, ...turn(2)], { cache });
    for (const rows of [history, [...turn(1), ...turn(3, true)]]) {
      expect(buildConversationTurnRenderUnits(rows, { cache, nowMs: 400 })).toEqual(
        buildConversationTurnRenderUnits(rows, { nowMs: 400 }),
      );
    }
  });
});
