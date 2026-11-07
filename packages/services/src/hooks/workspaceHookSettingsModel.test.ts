import { describe, expect, it } from "vitest";
import type { Hook } from "@zcode/shared";
import {
  buildValidatedZCodeHooksPatch,
  HooksConfigValidationError,
} from "./workspaceHookSettingsModel.js";

function createHook(overrides: Partial<Hook> = {}): Hook {
  return {
    id: "hook-fixture",
    event: "Stop",
    type: "process",
    command: "fixture-command",
    enabled: false,
    ...overrides,
  };
}

describe("buildValidatedZCodeHooksPatch", () => {
  it("writes process timeout seconds as milliseconds", () => {
    const patch = buildValidatedZCodeHooksPatch(undefined, [createHook({ timeout: 60 })]);
    expect(patch.events?.Stop?.[0]?.hooks[0]).toMatchObject({ timeoutMs: 60_000 });
  });

  it("keeps command hook timeout in seconds", () => {
    const patch = buildValidatedZCodeHooksPatch(undefined, [
      createHook({ type: "command", timeout: 5 }),
    ]);
    expect(patch.events?.Stop?.[0]?.hooks[0]).toMatchObject({ timeout: 5 });
  });

  // QA-BUG-002：负数 timeout 经 timeout * 1000 变成负的 timeoutMs，会被共享 schema 拒绝。
  it("rejects a negative timeout instead of writing an invalid config", () => {
    expect(() => buildValidatedZCodeHooksPatch(undefined, [createHook({ timeout: -1 })])).toThrow(
      HooksConfigValidationError,
    );
  });

  it("rejects an infinite timeout", () => {
    expect(() =>
      buildValidatedZCodeHooksPatch(undefined, [createHook({ timeout: Number.POSITIVE_INFINITY })]),
    ).toThrow(HooksConfigValidationError);
  });

  it("omits defaulted timeouts instead of writing invalid values", () => {
    for (const timeout of [0, Number.NaN]) {
      const patch = buildValidatedZCodeHooksPatch(undefined, [createHook({ timeout })]);
      expect(patch.events?.Stop?.[0]?.hooks[0]).not.toHaveProperty("timeoutMs");
    }
  });

  it("does not echo command text in the validation error", () => {
    try {
      buildValidatedZCodeHooksPatch(undefined, [
        createHook({ timeout: -1, command: "fixture-secret-command" }),
      ]);
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(HooksConfigValidationError);
      expect((error as Error).message).not.toContain("fixture-secret-command");
    }
  });

  it("preserves a valid root enabled flag and passthrough custom fields", () => {
    const patch = buildValidatedZCodeHooksPatch(undefined, [
      createHook({ enabled: true, timeout: 30, custom: { fixtureNote: "kept" } }),
    ]);
    expect(patch.enabled).toBe(true);
    expect(patch.events?.Stop?.[0]?.hooks[0]).toMatchObject({
      timeoutMs: 30_000,
      fixtureNote: "kept",
    });
  });
});
