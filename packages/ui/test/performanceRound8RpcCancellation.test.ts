import { describe, expect, it } from "vitest";
import { CancellationTokenSource, ChannelClient, Emitter, type VSBuffer } from "@zcode/rpc";

describe("RPC cancellation token state", () => {
  it("updates the cached token before notifying listeners and cancels only once", () => {
    const source = new CancellationTokenSource();
    const token = source.token;
    const observed: boolean[] = [];
    token.onCancellationRequested(() => observed.push(token.isCancellationRequested));
    expect(token.isCancellationRequested).toBe(false);
    source.cancel();
    expect(token.isCancellationRequested).toBe(true);
    expect(source.token).toBe(token);
    source.cancel();
    expect(observed).toEqual([true]);
    source.dispose();
    expect(token.isCancellationRequested).toBe(true);
  });

  it("exposes cancellation when the token is first obtained after cancel", () => {
    const source = new CancellationTokenSource();
    source.cancel();
    expect(source.token.isCancellationRequested).toBe(true);
    source.dispose();
  });

  it("isolates sources and preserves dispose without implicit cancellation", () => {
    const first = new CancellationTokenSource();
    const second = new CancellationTokenSource();
    const token = second.token;
    first.cancel();
    expect(token.isCancellationRequested).toBe(false);
    second.dispose();
    expect(token.isCancellationRequested).toBe(false);
    first.dispose();
  });

  it("rejects a pre-cancelled client call without sending or waiting for Initialize", async () => {
    const source = new CancellationTokenSource();
    source.cancel();
    const incoming = new Emitter<VSBuffer>();
    let sent = 0;
    const client = new ChannelClient({
      onMessage: incoming.event,
      send: () => {
        sent += 1;
      },
    });
    try {
      await expect(
        client.getChannel("fixture").call("work", undefined, source.token),
      ).rejects.toThrow("Cancelled");
      expect(sent).toBe(0);
    } finally {
      client.dispose();
      incoming.dispose();
      source.dispose();
    }
  });
});
