import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitCliRepo } from "../src/git/repo/gitCliRepo.js";
import type {
  GitCommandExecutionOptions,
  GitCommandExecutionResult,
  GitCommandProvider,
} from "../src/git/providers/gitCommandProvider.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function commandResult(
  options: GitCommandExecutionOptions,
  stdout = "",
): GitCommandExecutionResult {
  return {
    binaryPath: "git-test-double",
    cwd: options.cwd,
    args: options.args,
    stdout,
    stderr: "",
    exitCode: 0,
    signal: null,
    durationMs: 0,
    timedOut: false,
    outputTruncated: false,
  };
}

function trackedPathStatus(path: string): string {
  return `1 .M N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ${path}\0`;
}

describe("GitCliRepo selected commit path membership", () => {
  it("keeps staged-only cleanup order while bounding membership comparisons", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "git-path-membership-"));
    cleanup.push(() => rm(workspacePath, { recursive: true, force: true }));

    const pathCount = 256;
    const ascendingPaths = Array.from(
      { length: pathCount },
      (_, index) => `file/${String(index).padStart(4, "0")}.txt`,
    );
    const selectedPaths = [...ascendingPaths].reverse();
    const originalRenamePath = "file/0001-old.txt";
    const statusOutput = ascendingPaths
      .map((path, index) => {
        if (index === 0)
          return `1 D. N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ${path}\0`;
        if (index === 1)
          return `2 R. N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa R100 ${path}\0${originalRenamePath}\0`;
        return trackedPathStatus(path);
      })
      .join("");

    const commands: GitCommandExecutionOptions[] = [];
    const provider: GitCommandProvider = {
      resolveGitBinary: async () => "git-test-double",
      run: async (options) => {
        commands.push(options);
        const [command, ...args] = options.args;
        if (command === "rev-parse" && args[0] === "--show-toplevel")
          return commandResult(options, `${workspacePath}\n\n${workspacePath}\n${workspacePath}\n`);
        if (command === "status") return commandResult(options, statusOutput);
        if (command === "ls-files")
          return commandResult(
            options,
            `100644 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 0\tfile/0002.txt\0`,
          );
        if (command === "rev-parse" && args[0] === "--verify")
          return commandResult(options, "old-head\n");
        if (command === "rev-parse" && args[0] === "HEAD")
          return commandResult(options, "new-head\n");
        return commandResult(options);
      },
    };

    const originalIncludes = Array.prototype.includes;
    let membershipComparisons = 0;
    Array.prototype.includes = function (searchElement, fromIndex) {
      const values = this as unknown[];
      if (
        values.length === pathCount &&
        values[0] === selectedPaths[0] &&
        values.at(-1) === selectedPaths.at(-1) &&
        typeof searchElement === "string" &&
        searchElement.startsWith("file/")
      ) {
        const start = fromIndex === undefined ? 0 : Math.max(0, fromIndex);
        for (let index = start; index < values.length; index += 1) {
          membershipComparisons += 1;
          if (values[index] === searchElement) return true;
        }
        return false;
      }
      return originalIncludes.call(this, searchElement, fromIndex);
    };

    try {
      const repo = createGitCliRepo({ commandProvider: provider });
      const result = await repo.commit(workspacePath, "selected commit", selectedPaths, {
        stagedOnly: true,
      });
      expect(result).toEqual({ commitHash: "new-head" });
    } finally {
      Array.prototype.includes = originalIncludes;
    }

    expect(commands.map(({ args }) => args[0])).toEqual([
      "rev-parse",
      "status",
      "ls-files",
      "rev-parse",
      "read-tree",
      "update-index",
      "update-index",
      "commit",
      "rev-parse",
      "reset",
    ]);

    const removeCommand = commands.find(
      ({ args }) => args[0] === "update-index" && args[1] === "--force-remove",
    );
    expect(removeCommand?.args.slice(3)).toEqual([...selectedPaths, originalRenamePath]);
    const resetCommand = commands.find(({ args }) => args[0] === "reset");
    expect(resetCommand?.args.slice(4)).toEqual([...selectedPaths, originalRenamePath]);
    expect(commands.find(({ args }) => args[0] === "status")?.args.slice(4)).toEqual(selectedPaths);
    expect(membershipComparisons).toBeLessThanOrEqual(pathCount * 4);
  });

  it("keeps ordinary commit path normalization and first-seen deduplication", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "git-path-membership-"));
    cleanup.push(() => rm(workspacePath, { recursive: true, force: true }));
    const commands: GitCommandExecutionOptions[] = [];
    const provider: GitCommandProvider = {
      resolveGitBinary: async () => "git-test-double",
      run: async (options) => {
        commands.push(options);
        if (options.args[0] === "rev-parse" && options.args[1] === "--show-toplevel")
          return commandResult(options, `${workspacePath}\n\n${workspacePath}\n${workspacePath}\n`);
        if (options.args[0] === "rev-parse") return commandResult(options, "new-head\n");
        return commandResult(options);
      },
    };

    const repo = createGitCliRepo({ commandProvider: provider });
    const selectedResult = await repo.commit(
      workspacePath,
      "ordinary commit",
      ["file/selected.txt", join(workspacePath, "file", "selected.txt"), "file/selected.txt"],
      { stagedOnly: false },
    );

    expect(selectedResult).toEqual({ commitHash: "new-head" });
    expect(commands.map(({ args }) => args[0])).toEqual(["rev-parse", "commit", "rev-parse"]);
    expect(commands[1]?.args).toEqual([
      "commit",
      "-m",
      "ordinary commit",
      "--",
      "file/selected.txt",
    ]);

    commands.length = 0;
    const emptyResult = await repo.commit(workspacePath, "whole index commit", [], {
      stagedOnly: false,
    });
    expect(emptyResult).toEqual({ commitHash: "new-head" });
    expect(commands.map(({ args }) => args[0])).toEqual(["rev-parse", "commit", "rev-parse"]);
    expect(commands[1]?.args).toEqual(["commit", "-m", "whole index commit"]);
  });
});
