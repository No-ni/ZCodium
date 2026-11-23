import { describe, expect, it } from "vitest";
import { join, resolve, sep } from "node:path";
import { getProjectMemoryRoot, projectIdFromDirectory } from "../src/app/paths.js";

it("keeps internal project IDs distinct for different long directories sharing the first eighty characters", () => {
  const prefix = "/synthetic/" + "shared-prefix/".repeat(10);
  expect(projectIdFromDirectory(prefix + "alpha")).not.toBe(projectIdFromDirectory(prefix + "beta"));
});

describe("projectIdFromDirectory compatibility", () => {
  it("preserves short directory IDs and the empty fallback", () => {
    expect(projectIdFromDirectory("C:\\Work\\My Project")).toBe("proj_c-work-my-project");
    expect(projectIdFromDirectory("")).toBe("proj_default");
    expect(projectIdFromDirectory("a".repeat(80))).toBe("proj_" + "a".repeat(80));
  });

  it("bounds long IDs and preserves the existing case-insensitive contract", () => {
    const directory = "C:\\Synthetic\\" + "SharedPrefix\\".repeat(12) + "Alpha";
    expect(projectIdFromDirectory(directory)).toMatch(/^proj_.{15}-[a-f0-9]{64}$/);
    expect(projectIdFromDirectory(directory)).toBe(projectIdFromDirectory(directory.toUpperCase()));
    expect(projectIdFromDirectory(directory)).not.toBe(projectIdFromDirectory(directory.replace("Alpha", "Beta")));
  });
});

describe("getProjectMemoryRoot", () => {
  it("uses an opaque workspace identity and the canonical memory suffix", () => {
    const first = getProjectMemoryRoot(
      "/tmp/zcode-cli",
      "/workspace/first",
      "  remote:ssh:host:/workspace/app  ",
    );
    const second = getProjectMemoryRoot(
      "/tmp/zcode-cli",
      "/workspace/second",
      "remote:ssh:host:/workspace/app",
    );

    expect(first).toBe(join("/tmp/zcode-cli", "memories", "projects", "project-dce7d1610bbf24dd", "memory"));
    expect(second).toBe(first);
  });

  it("normalizes the workspace path only when identity is absent", () => {
    const relativeRoot = getProjectMemoryRoot("/tmp/zcode-cli", ".");
    const absoluteRoot = getProjectMemoryRoot("/tmp/zcode-cli", resolve("."));
    const blankIdentityRoot = getProjectMemoryRoot("/tmp/zcode-cli", ".", "   ");

    expect(relativeRoot).toBe(absoluteRoot);
    expect(blankIdentityRoot).toBe(absoluteRoot);
    expect(relativeRoot.split(sep).slice(-4)).toEqual(["memories", "projects", expect.any(String), "memory"]);
  });
});
