import assert from "node:assert/strict";
import test from "node:test";
import { mergeZCodeBackgroundTaskControlItems } from "../src/background-task-control-merge.js";
import { parseZCodeBackgroundTaskControlItems } from "../src/background-task-controls.js";
import type { ZCodeBackgroundTaskControlItem } from "../src/background-task-controls.js";
import { deriveZCodeTaskStatusFromSessionSnapshot } from "../src/zcode-session-task-status.js";
import type { ZCodeSessionStateSnapshot } from "../src/zcode-protocol/index.js";

const currentItem = {
  jobId: "task-1",
  toolCallId: "call-1",
  command: "fixture command",
  taskKind: "bash",
  status: "running",
  startedAt: 100,
  pid: 123,
  stdoutTail: "running tail",
  raw: { status: "running" },
} as const;

test("partial background task update preserves fields not carried by the update", () => {
  const payload = {
    jobId: "task-1",
    command: "fixture command",
    taskKind: "bash",
    status: "failed",
    pid: undefined,
  };
  const [update] = parseZCodeBackgroundTaskControlItems([payload]);
  assert.ok(update, "parser must retain the partial update");

  const merged = mergeZCodeBackgroundTaskControlItems([currentItem], [update]);

  assert.deepEqual(merged, [
    {
      ...currentItem,
      status: "failed",
      raw: payload,
    } satisfies ZCodeBackgroundTaskControlItem,
  ]);
});

test("unknown background task jobs keep their update reference and append in order", () => {
  const job = {
    jobId: "task-2",
    command: "next command",
    taskKind: "agent",
    status: "running",
  } as const;

  const merged = mergeZCodeBackgroundTaskControlItems([currentItem], [job]);

  assert.equal(merged.length, 2);
  assert.equal(merged[0], currentItem);
  assert.equal(merged[1], job);
});

function snapshot(input: {
  status: ZCodeSessionStateSnapshot["session"]["status"];
  messages: unknown[];
  activeTurnId?: string;
}): ZCodeSessionStateSnapshot {
  return Object.freeze({
    session: {
      sessionId: "session-1",
      workspace: { workspacePath: "/fixture", workspaceKey: "fixture" },
      sessionKind: "interactive",
      title: "",
      mode: "build",
      status: input.status,
      createdAt: 1,
      updatedAt: 2,
    },
    settings: {
      model: { available: [] },
      thoughtLevel: { enabled: false, available: [] },
      mode: { current: "build" },
    },
    projection: {
      sessionId: "session-1",
      status: input.status,
      mode: "build",
      turnCount: 0,
      totalTokenCount: 0,
      contextUsed: 0,
      contextWindow: 0,
      pendingPermissions: [],
      activeToolCalls: [],
      backgroundJobs: [],
    },
    runtime: {
      eventSeq: 0,
      stateRevision: 0,
      pendingRequestIds: [],
      ...(input.activeTurnId ? { activeTurnId: input.activeTurnId } : {}),
    },
    messages: input.messages,
  }) as ZCodeSessionStateSnapshot;
}

function messagesThatCountReads(count: { value: number }): unknown[] {
  const messages = Object.freeze(
    Array.from({ length: 1_000 }, (_, index) => ({
      info: {
        role: "assistant",
        messageId: `message-${index}`,
        finish: "end_turn",
        time: { completed: 1 },
      },
    })),
  );
  return new Proxy(messages, {
    get(target, property, receiver) {
      if (property === Symbol.iterator) {
        return function* () {
          for (const message of target) {
            count.value += 1;
            yield message;
          }
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

test("blocking runtime settles running status before scanning visible history", () => {
  const reads = { value: 0 };
  const status = deriveZCodeTaskStatusFromSessionSnapshot(
    snapshot({
      status: "running",
      messages: messagesThatCountReads(reads),
      activeTurnId: "turn-1",
    }),
  );

  assert.equal(status, "running");
  assert.ok(reads.value === 0, `Visible messages scanned while blocked: ${reads.value}`);
});

test("a completed visible turn still wins when runtime is not blocked", () => {
  const reads = { value: 0 };
  const status = deriveZCodeTaskStatusFromSessionSnapshot(
    snapshot({ status: "running", messages: messagesThatCountReads(reads) }),
  );

  assert.equal(status, "completed");
  assert.equal(reads.value, 1_000);
});

test("error and completed session statuses keep their existing priority", () => {
  const reads = { value: 0 };
  const messages = messagesThatCountReads(reads);

  assert.equal(
    deriveZCodeTaskStatusFromSessionSnapshot(snapshot({ status: "error", messages })),
    "error",
  );
  assert.equal(
    deriveZCodeTaskStatusFromSessionSnapshot(snapshot({ status: "completed", messages })),
    "completed",
  );
  assert.equal(reads.value, 0);
});
