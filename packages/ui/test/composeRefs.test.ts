import { describe, expect, it } from "vitest";
import { composeRefs } from "@/lib/composeRefs.js";

describe("composed ref cleanup failures", () => {
  it("releases the other owner even when caller cleanup throws, preserving the error", () => {
    const failure = new Error("caller cleanup failed");
    const node = {};
    const resource = { current: null as object | null };
    const ref = composeRefs<object>(
      () => () => {
        throw failure;
      },
      resource,
    );
    const cleanup = ref(node);
    expect(resource.current).toBe(node);
    expect(cleanup).toBeTypeOf("function");
    expect(() => cleanup?.()).toThrow(failure);
    expect(resource.current).toBeNull();
  });

  it("clears a legacy ref before surfacing the second owner's cleanup failure", () => {
    const failure = new Error("scope cleanup failed");
    const received: Array<object | null> = [];
    const node = {};
    const cleanup = composeRefs<object>(
      (value) => {
        received.push(value);
      },
      () => () => {
        throw failure;
      },
    )(node);
    expect(() => cleanup?.()).toThrow(failure);
    expect(received).toEqual([node, null]);
  });
});
