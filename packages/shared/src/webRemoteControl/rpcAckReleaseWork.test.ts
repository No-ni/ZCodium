import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encodeWebRemoteControlRpcFrames,
  WebRemoteControlRpcReplayBuffer,
  WEB_REMOTE_CONTROL_RPC_FAULT_REASONS,
  WEB_REMOTE_CONTROL_RPC_LIMITS,
  type WebRemoteControlRpcMessageFrame,
} from "./rpcTransport.js";

const STREAM = 'ack-桥-"\\🙂';
afterEach(() => vi.restoreAllMocks());

function frames(seq: number, fragmented = false) {
  return encodeWebRemoteControlRpcFrames(
    { seq, text: fragmented ? "x".repeat(2048) : "value" },
    {
      streamId: STREAM,
      seq,
      ...(fragmented
        ? {
            measurePhysicalFrameBytes: (frame: unknown) =>
              new TextEncoder().encode(JSON.stringify(frame)).byteLength +
              WEB_REMOTE_CONTROL_RPC_LIMITS.maxPhysicalFrameBytes -
              512,
          }
        : {}),
    },
  );
}

function state(buffer: WebRemoteControlRpcReplayBuffer) {
  return {
    acked: buffer.ackedSeq,
    sent: buffer.lastSentSeq,
    count: buffer.pendingMessageCount,
    bytes: buffer.pendingBytes,
  };
}

function replayWork(spy: ReturnType<typeof observeReplay>) {
  return {
    calls: spy.mock.calls.length,
    frameReferences: spy.mock.results.reduce(
      (total, result) => total + (result.type === "return" ? result.value.length : 0),
      0,
    ),
  };
}

function observeReplay() {
  return vi.spyOn(WebRemoteControlRpcReplayBuffer.prototype, "replayUnacknowledged");
}

function fill(buffer: WebRemoteControlRpcReplayBuffer, count: number) {
  for (let seq = 1; seq <= count; seq += 1) {
    expect(buffer.record(seq, frames(seq)).accepted).toBe(true);
  }
}

describe("ACK release preserves the public replay contract", () => {
  it("default/true returns ordered original frame references for new, repeated and old ACKs", () => {
    const buffer = new WebRemoteControlRpcReplayBuffer();
    const first = frames(1);
    const second = frames(2, true);
    const third = frames(3);
    expect(second.length).toBeGreaterThan(1);
    for (const [index, value] of [first, second, third].entries()) {
      expect(buffer.record(index + 1, value).accepted).toBe(true);
    }
    const expected = [...second, ...third];
    for (const returned of [
      buffer.acknowledge(1),
      buffer.acknowledge(1, true),
      buffer.acknowledge(0),
    ]) {
      expect(returned).toEqual(expected);
      for (const [index, frame] of returned.entries()) expect(frame).toBe(expected[index]);
      returned.length = 0;
      expect(buffer.replayUnacknowledged()).toEqual(expected);
    }
    const before = state(buffer);
    expect(buffer.acknowledge(4)).toEqual([]);
    expect(state(buffer)).toEqual(before);
    expect(buffer.acknowledge(2)).toEqual(third);
    expect(buffer.acknowledge(3)).toEqual([]);
    expect(state(buffer)).toEqual({ acked: 3, sent: 3, count: 0, bytes: 0 });
    buffer.clear();
  });

  it("false follows the same ACK, capacity, snapshot and clear/reuse transitions", () => {
    const options = { maxMessages: 2, maxBytes: 16, measureFrameBytes: () => 8 };
    const reference = new WebRemoteControlRpcReplayBuffer(options);
    const releaseOnly = new WebRemoteControlRpcReplayBuffer(options);
    const first = frames(1);
    const second = frames(2);
    const third = frames(3);
    for (const buffer of [reference, releaseOnly]) {
      expect(buffer.record(1, first)).toEqual({ accepted: true });
      expect(buffer.record(2, second)).toEqual({ accepted: true });
      expect(buffer.record(3, third).accepted).toBe(false);
      expect(buffer.record(2, third)).toEqual({ accepted: true });
    }
    // record 只快照输入数组，不改变帧对象的引用语义。
    first.length = 0;
    for (const ack of [3, 0, 1, 1, 0]) {
      reference.acknowledge(ack);
      releaseOnly.acknowledge(ack, false);
      expect(state(releaseOnly)).toEqual(state(reference));
      expect(releaseOnly.replayUnacknowledged()).toEqual(reference.replayUnacknowledged());
    }
    for (const buffer of [reference, releaseOnly]) {
      expect(buffer.record(3, third)).toEqual({ accepted: true });
      expect(buffer.pendingBytes).toBe(16);
      buffer.clear();
      expect(state(buffer)).toEqual({ acked: 0, sent: 0, count: 0, bytes: 0 });
      expect(buffer.record(1, second)).toEqual({ accepted: true });
    }
    expect(releaseOnly.acknowledge(1, false)).toEqual(reference.acknowledge(1));
    expect(state(releaseOnly)).toEqual(state(reference));
  });

  it("release-only immediately drops acknowledged references through compaction", () => {
    const buffer = new WebRemoteControlRpcReplayBuffer();
    fill(buffer, 128);
    const originalFrames = buffer.replayUnacknowledged();
    buffer.acknowledge(1, false);
    const internal = buffer as unknown as {
      entries: Array<{ frames: WebRemoteControlRpcMessageFrame[] } | undefined>;
      headIndex: number;
    };
    expect(internal.entries[0]).toBeUndefined();
    buffer.acknowledge(64, false);
    expect(internal.headIndex).toBe(0);
    expect(internal.entries.flatMap((entry) => entry?.frames ?? [])).toEqual(
      originalFrames.slice(64),
    );
    buffer.acknowledge(128, false);
    expect(internal.entries).toEqual([]);
    expect(buffer.pendingBytes).toBe(0);
  });

  it("mixed default/true/false ACKs preserve the same fragmented tail and isolated returns", () => {
    const reference = new WebRemoteControlRpcReplayBuffer();
    const mixed = new WebRemoteControlRpcReplayBuffer();
    const recorded = [frames(1), frames(2, true), frames(3), frames(4, true)];
    for (const buffer of [reference, mixed]) {
      for (const [index, value] of recorded.entries()) {
        expect(buffer.record(index + 1, value)).toEqual({ accepted: true });
      }
    }
    const steps: Array<[number, boolean | undefined]> = [
      [0, false],
      [1, false],
      [1, true],
      [0, undefined],
      [2, undefined],
      [2, false],
      [1, false],
      [5, false],
      [3, true],
      [4, false],
    ];
    for (const [ack, includeReplay] of steps) {
      const expected = reference.acknowledge(ack);
      const returned =
        includeReplay === undefined
          ? mixed.acknowledge(ack)
          : mixed.acknowledge(ack, includeReplay);
      expect(returned).toEqual(includeReplay === false ? [] : expected);
      if (includeReplay !== false) {
        for (const [index, frame] of returned.entries()) expect(frame).toBe(expected[index]);
      }
      returned.length = 0;
      expect(state(mixed)).toEqual(state(reference));
      const tail = mixed.replayUnacknowledged();
      expect(tail).toEqual(reference.replayUnacknowledged());
      for (const frame of tail) expect(recorded.flat().includes(frame)).toBe(true);
    }
    const empty = mixed.acknowledge(4, false);
    expect(mixed.acknowledge(4, false)).not.toBe(empty);
  });

  it.each(["count", "bytes"])(
    "release-only restores %s admission without changing the rejected sequence",
    (limit) => {
      const first = frames(1);
      const fragmented = frames(2, true);
      expect(fragmented.length).toBeGreaterThan(1);
      const expected = [...fragmented];
      const batchBytes = expected.length * 8;
      const buffer = new WebRemoteControlRpcReplayBuffer({
        maxMessages: limit === "count" ? 1 : 3,
        maxBytes: limit === "bytes" ? batchBytes : batchBytes + 8,
        measureFrameBytes: () => 8,
      });
      expect(buffer.record(1, first)).toEqual({ accepted: true });
      const before = state(buffer);
      expect(buffer.record(2, fragmented)).toEqual({
        accepted: false,
        reasonCode: WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.replayBufferOverflow,
      });
      expect(state(buffer)).toEqual(before);
      expect(buffer.acknowledge(2, false)).toEqual([]);
      expect(state(buffer)).toEqual(before);
      expect(buffer.record(1, fragmented)).toEqual({ accepted: true });
      expect(state(buffer)).toEqual(before);
      expect(buffer.acknowledge(1, false)).toEqual([]);
      expect(buffer.record(2, fragmented)).toEqual({ accepted: true });
      expect(state(buffer)).toEqual({ acked: 1, sent: 2, count: 1, bytes: batchBytes });
      fragmented.length = 0;
      const tail = buffer.replayUnacknowledged();
      expect(tail).toEqual(expected);
      for (const [index, frame] of tail.entries()) expect(frame).toBe(expected[index]);
    },
  );

  it("release-only invalid/empty ACKs do no replay work and clear resets all owner state", () => {
    const buffer = new WebRemoteControlRpcReplayBuffer();
    const replay = observeReplay();
    expect(buffer.acknowledge(0, false)).toEqual([]);
    expect(buffer.acknowledge(1, false)).toEqual([]);
    fill(buffer, 4);
    const before = state(buffer);
    expect(buffer.acknowledge(5, false)).toEqual([]);
    expect(buffer.acknowledge(Number.MAX_SAFE_INTEGER, false)).toEqual([]);
    expect(state(buffer)).toEqual(before);
    buffer.acknowledge(1, false);
    const internal = buffer as unknown as {
      entries: unknown[];
      headIndex: number;
    };
    expect(internal.entries[0]).toBeUndefined();
    buffer.clear();
    expect(internal.entries).toEqual([]);
    expect(internal.headIndex).toBe(0);
    expect(state(buffer)).toEqual({ acked: 0, sent: 0, count: 0, bytes: 0 });
    expect(buffer.record(1, frames(1))).toEqual({ accepted: true });
    expect(buffer.acknowledge(1, false)).toEqual([]);
    expect(replayWork(replay)).toEqual({ calls: 0, frameReferences: 0 });
  });

  it.each([64, 128])("release-only avoids flattening the tail for %i individual ACKs", (count) => {
    const buffer = new WebRemoteControlRpcReplayBuffer();
    fill(buffer, count);
    const replay = observeReplay();
    const returned = [];
    for (let ack = 1; ack <= count; ack += 1) returned.push(buffer.acknowledge(ack, false));
    expect(state(buffer)).toEqual({ acked: count, sent: count, count: 0, bytes: 0 });
    expect(replayWork(replay)).toEqual({ calls: 0, frameReferences: 0 });
    expect(returned.every((result) => result.length === 0)).toBe(true);
    buffer.clear();
  });

  it("a steady 64-message window does no replay work for 1000 normal/old/repeated ACKs", () => {
    const buffer = new WebRemoteControlRpcReplayBuffer();
    fill(buffer, 64);
    const replay = observeReplay();
    for (let ack = 1; ack <= 1000; ack += 1) {
      buffer.acknowledge(ack, false);
      buffer.acknowledge(ack, false);
      buffer.acknowledge(ack - 1, false);
      expect(buffer.record(ack + 64, frames(ack + 64))).toEqual({ accepted: true });
    }
    expect(buffer.ackedSeq).toBe(1000);
    expect(buffer.lastSentSeq).toBe(1064);
    expect(buffer.pendingMessageCount).toBe(64);
    expect(replayWork(replay)).toEqual({ calls: 0, frameReferences: 0 });
    replay.mockRestore();
    expect(buffer.replayUnacknowledged().map((frame) => frame.seq)).toEqual(
      Array.from({ length: 64 }, (_, index) => 1001 + index),
    );
    buffer.clear();
  });
});
