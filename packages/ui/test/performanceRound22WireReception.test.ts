import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import {
  encodeTopicWireFrames,
  PROTOCOL_V4_LIMITS,
  sessionsIndexTopicFrameSchema,
  TopicWireFrameAssembler,
  utf8JsonByteLength,
  V4_WIRE_PROTOCOL_VERSION,
  type HelloMessage,
  type SessionsIndexTopicFrame,
  type SessionsIndexTopicWireCandidate,
  type TopicFrameDeliveryKind,
  type V4SessionsIndexSubscribeResult,
} from "@zcode/shared/zcode-protocol-v4";
import { createAckActivationBarrier } from "@/v4/ackActivationBarrier.js";
import { createTopicWireDecoder } from "@/v4/topicWireDecoder.js";
import { createAgentSessionsIndexTransport } from "@/v4/agentSessionsIndexTransport.js";
import { SessionsIndexStore } from "@/v4/sessionsIndexStore.js";

vi.mock("@/logger.js", () => ({ logger: { warn: vi.fn() } }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function flush() {
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
}

function transportFixture(clientMode: HelloMessage["clientMode"]) {
  const frames = new Emitter<SessionsIndexTopicWireCandidate>();
  const restarts = new Emitter<{ workspaceKey: string }>();
  const workspacePath = "C:/synthetic/workspace";
  const workspaceIdentity = "synthetic";
  const service = {
    helloConversationV4: vi.fn(
      async (): Promise<HelloMessage> => ({
        kind: "hello",
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
        connectionId: "synthetic-connection",
        clientMode,
        deliveryProfile: clientMode === "desktop-continuous" ? "continuous" : "replayable",
        serverTime: 1,
        capabilities: {
          nativeDialogs: false,
          localTerminal: false,
          binaryFrames: true,
          compression: "none",
        },
        auth: {},
      }),
    ),
    initializeConversationV4: vi.fn(async () => {}),
    subscribeSessionsIndexV4:
      vi.fn<Parameters<typeof createAgentSessionsIndexTransport>[0]["subscribeSessionsIndexV4"]>(),
    resyncSessionsIndexV4:
      vi.fn<Parameters<typeof createAgentSessionsIndexTransport>[0]["resyncSessionsIndexV4"]>(),
    unsubscribeSessionsIndexV4: vi.fn(async () => {}),
    onDynamicSessionsIndexFrame: () => frames.event,
    onAgentRuntimeRestarted: restarts.event,
  };
  const transport = createAgentSessionsIndexTransport(service, {
    workspacePath,
    workspaceIdentity,
  });
  const store = new SessionsIndexStore();
  return { frames, restarts, service, transport, store };
}

describe.each(["desktop-continuous", "web-remote-replayable"] as const)(
  "%s production sessions transport",
  (clientMode) => {
    it("stages before ACK, applies atomically and recovers after a lost fragment", async () => {
      const { store, transport, service, frames, restarts } = transportFixture(clientMode);
      let resolveAck!: (value: V4SessionsIndexSubscribeResult) => void;
      service.subscribeSessionsIndexV4.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveAck = resolve;
          }),
      );
      const initial = snapshot();
      const initialWires = wires(initial, "initial");
      const lostWires = wires(snapshot("sub", 2), "online", 2);
      const recoveredSnapshot = snapshot("sub", 2);
      if (recoveredSnapshot.payload.kind !== "snapshot")
        throw new Error("fixture requires a snapshot");
      const recoveredSession = {
        ...recoveredSnapshot.payload.snapshot.sessions[0],
        title: "恢复完成",
      };
      recoveredSnapshot.payload.snapshot.sessions = [recoveredSession];
      const recovered: SessionsIndexTopicFrame =
        clientMode === "desktop-continuous"
          ? recoveredSnapshot
          : {
              ...recoveredSnapshot,
              fromSeq: 1,
              payload: {
                kind: "deltas",
                deltas: [{ op: "session.upserted", session: recoveredSession }],
              },
            };
      service.resyncSessionsIndexV4.mockImplementation(async () => {
        encodeTopicWireFrames(recovered, {
          topic: recovered.topic,
          subscriptionId: "sub",
          deliveryKind: "recovery",
          logicalFrameId: "recover",
          logicalFrameOrdinal: 3,
          measurePhysicalFrameBytes: utf8JsonByteLength,
        }).forEach((wire) => frames.fire(wire));
        return {
          ack: {
            subscriptionId: "sub",
            logEpoch: "epoch",
            mode: clientMode === "desktop-continuous" ? "snapshot" : "resume",
          },
        };
      });
      try {
        const connection = store.connect(transport);
        await flush();
        expect(service.subscribeSessionsIndexV4).toHaveBeenCalledExactlyOnceWith({
          workspacePath: "C:/synthetic/workspace",
          workspaceIdentity: "synthetic",
          runtimePolicy: "existing-only",
        });
        initialWires.forEach((wire) => frames.fire(wire));
        expect(store.getSessions()).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
        const schedule = vi.spyOn(globalThis, "setTimeout");
        resolveAck({ ack: { subscriptionId: "sub", logEpoch: "epoch", mode: "snapshot" } });
        await connection;
        expect(store.getState().seq).toBe(1);
        expect(store.getSessions()).toHaveLength(1);
        expect(schedule).toHaveBeenCalledTimes(1);
        expect(service.initializeConversationV4).toHaveBeenCalledWith(
          expect.objectContaining({
            clientKind: clientMode === "desktop-continuous" ? "desktop" : "web",
          }),
        );
        frames.fire(lostWires[0]);
        vi.advanceTimersByTime(PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
        await flush();
        expect(service.resyncSessionsIndexV4).toHaveBeenCalledExactlyOnceWith({
          workspacePath: "C:/synthetic/workspace",
          workspaceIdentity: "synthetic",
          runtimePolicy: "existing-only",
          subscriptionId: "sub",
          base: { logEpoch: "epoch", seq: 1 },
        });
        expect(store.getState().seq).toBe(2);
        expect(store.getSessions()[0].title).toBe("恢复完成");
        lostWires.slice(1).forEach((wire) => frames.fire(wire));
        expect(store.getState().seq).toBe(2);
        expect(service.resyncSessionsIndexV4).toHaveBeenCalledTimes(1);
        expect(store.getStatus()).toBe("live");
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        store.close();
        await flush();
        frames.dispose();
        restarts.dispose();
      }
    });

    it("rejects an overflowed subscription and accepts the store's bounded fresh retry", async () => {
      const { store, transport, service, frames, restarts } = transportFixture(clientMode);
      const first = wires(snapshot(), "initial")[0];
      const fresh = wires(snapshot("fresh"), "initial");
      service.subscribeSessionsIndexV4.mockImplementationOnce(async () => {
        for (let index = 0; index < 1537; index += 1) frames.fire(first);
        return { ack: { subscriptionId: "sub", logEpoch: "epoch", mode: "snapshot" } };
      });
      service.subscribeSessionsIndexV4.mockImplementationOnce(async () => {
        fresh.forEach((wire) => frames.fire(wire));
        return { ack: { subscriptionId: "fresh", logEpoch: "epoch", mode: "snapshot" } };
      });
      try {
        await store.connect(transport);
        expect(service.subscribeSessionsIndexV4).toHaveBeenCalledTimes(2);
        expect(service.unsubscribeSessionsIndexV4).toHaveBeenCalledExactlyOnceWith({
          workspacePath: "C:/synthetic/workspace",
          workspaceIdentity: "synthetic",
          runtimePolicy: "existing-only",
          subscriptionId: "sub",
        });
        expect(store.getStatus()).toBe("live");
        expect(store.getSessions()).toHaveLength(1);
        expect(store.getState().seq).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        store.close();
        await flush();
        frames.dispose();
        restarts.dispose();
      }
    });
  },
);

const overflow = "fault.subscription.initialFrameStagingOverflow";
const staged = (body = "", subscriptionId = "sub") => ({ topic: "topic", subscriptionId, body });

describe("ACK staging avoids work for rejected frames", () => {
  it("stops serialization and UTF-8 allocation at the frame-count limit", () => {
    const deliver = vi.fn();
    const barrier = createAckActivationBarrier<ReturnType<typeof staged>>(deliver);
    const token = barrier.begin("topic");
    const frame = staged();
    for (let index = 0; index < 1024; index += 1) barrier.accept(frame);
    const stringify = vi.spyOn(JSON, "stringify");
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    for (let index = 0; index < 513; index += 1) barrier.accept(frame);
    const calls = [stringify.mock.calls.length, encode.mock.calls.length];
    expect(() => barrier.bind(token, "sub")).toThrow(overflow);
    expect(barrier.activate("sub")).toBeUndefined();
    expect(deliver).not.toHaveBeenCalled();
    expect(calls).toEqual([0, 0]);
  });

  it("accepts exactly 1024 frames in order and filters another subscription at activation", () => {
    const deliver = vi.fn();
    const barrier = createAckActivationBarrier<ReturnType<typeof staged>>(deliver);
    const token = barrier.begin("topic");
    const frames = Array.from({ length: 1024 }, (_, index) =>
      staged(String(index), index % 2 ? "sub" : "foreign"),
    );
    frames.forEach((frame) => barrier.accept(frame));
    barrier.bind(token, "sub");
    barrier.activate("sub");
    expect(deliver.mock.calls.map(([frame]) => frame)).toEqual(
      frames.filter((frame) => frame.subscriptionId === "sub"),
    );
  });

  it("keeps the exact byte limit and stops encoding after byte overflow", () => {
    const barrier = createAckActivationBarrier<ReturnType<typeof staged>>(() => {});
    const token = barrier.begin("topic");
    const chunk = staged("x".repeat(1024 * 1024 - utf8JsonByteLength(staged())));
    for (let index = 0; index < 32; index += 1) barrier.accept(chunk);
    // 恰好 32 MiB 可激活，另一组在同一边界后多一帧才失败。
    barrier.bind(token, "sub");
    expect(barrier.activate("sub")).toBeDefined();
    barrier.forget("sub");
    const failing = barrier.begin("topic");
    for (let index = 0; index < 32; index += 1) barrier.accept(chunk);
    barrier.accept(staged());
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    for (let index = 0; index < 64; index += 1) barrier.accept(staged("tail"));
    const calls = encode.mock.calls.length;
    expect(() => barrier.bind(failing, "sub")).toThrow(overflow);
    expect(calls).toBe(0);
  });

  it("measures UTF-8 bytes instead of UTF-16 length", () => {
    const barrier = createAckActivationBarrier<ReturnType<typeof staged>>(() => {});
    const token = barrier.begin("topic");
    const frame = staged("界🙂".repeat(100_000));
    const count = Math.floor((32 * 1024 * 1024) / utf8JsonByteLength(frame)) + 1;
    expect(JSON.stringify(frame).length * count).toBeLessThan(32 * 1024 * 1024);
    for (let index = 0; index < count; index += 1) barrier.accept(frame);
    expect(() => barrier.bind(token, "sub")).toThrow(overflow);
  });

  it("shares encoding across healthy pending subscriptions beside a failed one", () => {
    const deliver = vi.fn();
    const barrier = createAckActivationBarrier<ReturnType<typeof staged>>(deliver);
    const old = barrier.begin("topic");
    for (let index = 0; index < 1025; index += 1) barrier.accept(staged());
    const first = barrier.begin("topic");
    const second = barrier.begin("topic");
    const frame = staged("fresh", "fresh");
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    barrier.accept(frame);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(() => barrier.bind(old, "old")).toThrow(overflow);
    barrier.cancel(first);
    barrier.bind(second, "fresh");
    barrier.activate("fresh");
    expect(deliver).toHaveBeenCalledExactlyOnceWith(frame);
  });

  it("does not encode active, unknown, cancelled or cleared routes", () => {
    const deliver = vi.fn();
    const barrier = createAckActivationBarrier<ReturnType<typeof staged>>(deliver);
    const token = barrier.begin("topic");
    barrier.bind(token, "sub");
    barrier.activate("sub");
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    barrier.accept(staged("live"));
    barrier.accept({ ...staged(), topic: "unknown" });
    barrier.forget("sub");
    barrier.cancel(barrier.begin("topic"));
    barrier.accept(staged());
    barrier.begin("topic");
    barrier.clear();
    barrier.accept(staged());
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(encode).not.toHaveBeenCalled();
  });
});

function snapshot(subscriptionId = "sub", seq = 1): SessionsIndexTopicFrame {
  return {
    topic: "sessions-index/synthetic",
    subscriptionId,
    fromSeq: 0,
    toSeq: seq,
    sentAt: 1,
    payload: {
      kind: "snapshot",
      snapshot: {
        protocolVersion: 1,
        workspaceId: "synthetic",
        logEpoch: "epoch",
        sessions: [
          {
            sessionId: "session",
            workspaceId: "synthetic",
            title: "分片🙂".repeat(1000),
            phase: "draft",
            sessionEnded: false,
            hasBackgroundWork: false,
            lastActivityAt: 1,
            createdAt: 1,
          },
        ],
      },
    },
  };
}

function wires(
  frame: SessionsIndexTopicFrame,
  deliveryKind: TopicFrameDeliveryKind = "online",
  ordinal = 1,
) {
  const result = encodeTopicWireFrames(frame, {
    topic: frame.topic,
    subscriptionId: frame.subscriptionId,
    deliveryKind,
    logicalFrameId: `frame-${ordinal}`,
    logicalFrameOrdinal: ordinal,
    maxPhysicalFrameBytes: 1024,
    measurePhysicalFrameBytes: utf8JsonByteLength,
  });
  expect(result.length).toBeGreaterThan(10);
  return result;
}

function fixture() {
  const assembler = new TopicWireFrameAssembler(sessionsIndexTopicFrameSchema);
  const deliver = vi.fn();
  const fault = vi.fn();
  const decoder = createTopicWireDecoder(assembler, deliver, fault);
  return { assembler, deliver, fault, decoder };
}

describe("physical frame decoder expiry scheduling", () => {
  it.each(["initial", "online", "recovery"] as const)(
    "installs one timer for a fragmented %s frame",
    (kind) => {
      const { decoder, deliver, fault, assembler } = fixture();
      const frame = snapshot();
      const fragments = wires(frame, kind);
      const schedule = vi.spyOn(globalThis, "setTimeout");
      const cancel = vi.spyOn(globalThis, "clearTimeout");
      for (const fragment of fragments.slice(0, -1)) {
        decoder.accept(fragment);
        expect(deliver).not.toHaveBeenCalled();
      }
      decoder.accept(fragments.at(-1)!);
      expect(deliver).toHaveBeenCalledExactlyOnceWith(frame, kind);
      expect(fault).not.toHaveBeenCalled();
      expect(assembler.getStats()).toEqual({ assemblies: 0, stagedDecodedBytes: 0 });
      expect(vi.getTimerCount()).toBe(0);
      expect(schedule).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );

  it("does not extend the deadline for repeated fragments and expires once", () => {
    const { decoder, fault, assembler } = fixture();
    const fragments = wires(snapshot());
    decoder.accept(fragments[0]);
    vi.advanceTimersByTime(29_999);
    const schedule = vi.spyOn(globalThis, "setTimeout");
    for (let index = 0; index < 64; index += 1) decoder.accept(fragments[0]);
    vi.advanceTimersByTime(1);
    expect(fault).toHaveBeenCalledTimes(1);
    expect(fault.mock.calls[0][0]).toMatchObject({ subscriptionId: "sub", deliveryKind: "online" });
    expect(assembler.getStats()).toEqual({ assemblies: 0, stagedDecodedBytes: 0 });
    expect(vi.getTimerCount()).toBe(0);
    expect(schedule).not.toHaveBeenCalled();
  });

  it("keeps the earliest timer and moves to the next route after discard", () => {
    const { decoder, fault } = fixture();
    const first = wires(snapshot("first"));
    const second = wires(snapshot("second"));
    const schedule = vi.spyOn(globalThis, "setTimeout");
    decoder.accept(first[0]);
    vi.advanceTimersByTime(10);
    decoder.accept(second[0]);
    expect(schedule).toHaveBeenCalledTimes(1);
    decoder.discard(first[0].topic, "first");
    expect(schedule).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(29_999);
    expect(fault).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fault).toHaveBeenCalledTimes(1);
    expect(fault.mock.calls[0][0].subscriptionId).toBe("second");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("schedules the next route from the timer callback", () => {
    const { decoder, fault } = fixture();
    decoder.accept(wires(snapshot("first"))[0]);
    vi.advanceTimersByTime(10);
    decoder.accept(wires(snapshot("second"))[0]);
    vi.advanceTimersByTime(29_990);
    expect(fault.mock.calls.map(([event]) => event.subscriptionId)).toEqual(["first"]);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(10);
    expect(fault.mock.calls.map(([event]) => event.subscriptionId)).toEqual(["first", "second"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows recovery after timeout and still drops stale ordinal frames", () => {
    const { decoder, deliver, fault } = fixture();
    const old = wires(snapshot());
    decoder.accept(old[0]);
    vi.advanceTimersByTime(PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
    expect(fault).toHaveBeenCalledTimes(1);
    old.slice(1).forEach((wire) => decoder.accept(wire));
    expect(deliver).not.toHaveBeenCalled();
    const frame = snapshot("sub", 2);
    wires(frame, "recovery", 2).forEach((wire) => decoder.accept(wire));
    old.forEach((wire) => decoder.accept(wire));
    expect(deliver).toHaveBeenCalledExactlyOnceWith(frame, "recovery");
    expect(fault).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears timer state so a new assembly at the same clock time can expire", () => {
    const { decoder, fault } = fixture();
    const first = wires(snapshot());
    decoder.accept(first[0]);
    decoder.clear();
    expect(vi.getTimerCount()).toBe(0);
    decoder.accept(first[0]);
    vi.advanceTimersByTime(PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
    expect(fault).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a timer installed by a reentrant timeout listener", () => {
    const { decoder, fault } = fixture();
    const next = wires(snapshot("next"));
    fault.mockImplementationOnce(() => decoder.accept(next[0]));
    decoder.accept(wires(snapshot())[0]);
    const schedule = vi.spyOn(globalThis, "setTimeout");
    vi.advanceTimersByTime(PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
    expect(fault).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
