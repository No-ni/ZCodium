import { describe, expect, it } from "vitest";
import { DEFAULT_HOOK_TIMEOUT_SECONDS, parseHookTimeoutSeconds } from "./HookForm.js";

describe("parseHookTimeoutSeconds", () => {
  it("falls back to the default for blank input", () => {
    expect(parseHookTimeoutSeconds("")).toEqual({ seconds: DEFAULT_HOOK_TIMEOUT_SECONDS });
    expect(parseHookTimeoutSeconds("   ")).toEqual({ seconds: DEFAULT_HOOK_TIMEOUT_SECONDS });
  });

  it("keeps valid whole seconds and truncates decimals like the previous parseInt semantics", () => {
    expect(parseHookTimeoutSeconds("60")).toEqual({ seconds: 60 });
    expect(parseHookTimeoutSeconds("1")).toEqual({ seconds: 1 });
    expect(parseHookTimeoutSeconds("1.5")).toEqual({ seconds: 1 });
    // 旧 parseInt("1e12") 会得到 1；改用 Number 后超大合法值不再被悄悄改写成 1。
    expect(parseHookTimeoutSeconds("1e12")).toEqual({ seconds: 1_000_000_000_000 });
  });

  it("rejects non-positive, non-numeric, non-finite and overflowing values", () => {
    for (const raw of ["-1", "-0.5", "0", "0.5", "abc", "Infinity", "-Infinity", "NaN", "1e20"]) {
      expect(parseHookTimeoutSeconds(raw)).toEqual({ error: "invalid" });
    }
  });
});
