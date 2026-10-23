import { describe, expect, it, vi } from "vitest";
import { createCloseEventController } from "../src/remote/closeEvent.js";

describe("remote command close replay", () => {
  it("cancels late replay when the subscription is disposed before the microtask", async () => {
    const close = createCloseEventController();
    close.fire(23);
    const cancelled = vi.fn();
    close.event(cancelled).dispose();
    const active = vi.fn();
    close.event(active);
    await Promise.resolve();
    expect(cancelled).not.toHaveBeenCalled();
    expect(active).toHaveBeenCalledExactlyOnceWith(23);
  });

  it("publishes only the first exit code and preserves normal subscription cancellation", () => {
    const close = createCloseEventController();
    const cancelled = vi.fn();
    close.event(cancelled).dispose();
    const active = vi.fn();
    close.event(active);
    close.fire(7);
    close.fire(8);
    expect(cancelled).not.toHaveBeenCalled();
    expect(active).toHaveBeenCalledExactlyOnceWith(7);
  });
});
