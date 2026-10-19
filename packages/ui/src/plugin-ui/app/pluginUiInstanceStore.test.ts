import { afterEach, expect, it, vi } from "vitest";
import {
  createPluginUiInstancePublisher,
  getPluginUiRowDisposition,
  resetPluginUiInstancesForTest,
  subscribePluginUiInstances,
} from "./pluginUiInstanceStore.js";

const data = (key: string) => ({
  instances: [],
  byToolCallId: { tool: { key, superseded: false, autoExpand: true, forcedInline: false } },
});
afterEach(resetPluginUiInstancesForTest);

it("releases all historical sessions when their last publisher leaves", () => {
  for (let i = 0; i < 300; i++) {
    const publisher = createPluginUiInstancePublisher(`session-${i}`);
    publisher.set(data("first"));
    expect(getPluginUiRowDisposition(`session-${i}`, "tool")?.key).toBe("first");
    publisher.dispose();
  }
  for (let i = 0; i < 300; i++)
    expect(getPluginUiRowDisposition(`session-${i}`, "tool")).toBeUndefined();
});

it("falls back to a live publisher and ignores late cleanup/writes", () => {
  const first = createPluginUiInstancePublisher("session");
  const second = createPluginUiInstancePublisher("session");
  first.set(data("first"));
  second.set(data("second"));
  expect(getPluginUiRowDisposition("session", "tool")?.key).toBe("second");
  second.dispose();
  expect(getPluginUiRowDisposition("session", "tool")?.key).toBe("first");
  const next = createPluginUiInstancePublisher("session");
  next.set(data("next"));
  second.dispose();
  second.set(data("stale"));
  first.dispose();
  expect(getPluginUiRowDisposition("session", "tool")?.key).toBe("next");
  next.dispose();
  expect(getPluginUiRowDisposition("session", "tool")).toBeUndefined();
});

it("publishes updates without an intermediate absent snapshot", () => {
  const publisher = createPluginUiInstancePublisher("session");
  const listener = vi.fn(() => expect(getPluginUiRowDisposition("session", "tool")).toBeDefined());
  const off = subscribePluginUiInstances(listener);
  publisher.set(data("one"));
  publisher.set(data("two"));
  expect(listener).toHaveBeenCalledTimes(2);
  off();
  publisher.dispose();
});
