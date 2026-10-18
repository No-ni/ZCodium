import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { RelayPairingRegistry } from "./registry.js";

const logger = { info() {}, warn() {} };

function registry(pairTtlMs = 1_000): RelayPairingRegistry {
  return new RelayPairingRegistry({
    logger,
    maxPhysicalFrameBytes: 100_000,
    pairTtlMs,
    allowConnect: () => true,
    allowFrame: () => true,
  });
}

function socket(close: () => void = () => {}): WebSocket & { sent: string[] } {
  const sent: string[] = [];
  return {
    OPEN: 1,
    readyState: 1,
    sent,
    send(frame: string) {
      sent.push(frame);
    },
    close,
  } as unknown as WebSocket & { sent: string[] };
}

afterEach(() => vi.restoreAllMocks());

describe("RelayPairingRegistry current bindings", () => {
  it("does not let an old still-open socket forward or unbind its replacement", () => {
    const pairs = registry();
    const entry = pairs.lookup(pairs.register("hash-A"))!;
    const staleDevice = socket();
    const currentDevice = socket();
    const mobile = socket();
    pairs.bindRole(entry, "device", staleDevice);
    pairs.bindRole(entry, "mobile", mobile);

    pairs.bindRole(entry, "device", currentDevice);

    expect(pairs.isCurrentBinding(entry, "device", staleDevice)).toBe(false);
    expect(pairs.unbind(entry, staleDevice)).toBeNull();
    expect(pairs.pairStatusOf(entry)).toBe("matched");
    expect(pairs.forward("device", entry, staleDevice, { zcode_type: "stale" })).toBe(false);
    expect(mobile.sent).toEqual([]);
    expect(pairs.forward("device", entry, currentDevice, { zcode_type: "current" })).toBe(true);
    expect(JSON.parse(mobile.sent[0]!)).toEqual({
      type: "data",
      payload: { zcode_type: "current" },
    });
  });

  it("rejects an otherwise valid challenge after its pair TTL expires", () => {
    const now = 1_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const pairs = registry(100);
    const entry = pairs.lookup(pairs.register("hash-A"))!;
    const challenge = pairs.issueChallenge("mobile");
    const validProof = createHmac("sha256", entry.passHash)
      .update(`${challenge.value}|mobile|${entry.deviceSid}`)
      .digest("base64url");

    vi.spyOn(Date, "now").mockReturnValue(now + 101);

    expect(challenge.expiresAt).toBeGreaterThan(Date.now());
    expect(pairs.verifyProof(entry, challenge, "mobile", validProof)).toBe(false);
    expect(pairs.lookup(entry.deviceSid)).toBeUndefined();
  });
});
