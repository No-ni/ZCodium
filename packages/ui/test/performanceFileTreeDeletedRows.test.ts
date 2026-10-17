import { describe, expect, it, vi } from "vitest";
import {
  addDeletedGitStatusRowsToWorkspaceFileTree,
  type WorkspaceFileGitStatus,
  type WorkspaceFileTreeNode,
} from "@/workspace-file-tree/model.js";

function node(
  path: string,
  name: string,
  type: WorkspaceFileTreeNode["type"] = "file",
  depth = 0,
): WorkspaceFileTreeNode {
  return Object.freeze({ path, name, type, depth });
}

function frozenChildren(...nodes: WorkspaceFileTreeNode[]): WorkspaceFileTreeNode[] {
  return Object.freeze(nodes) as unknown as WorkspaceFileTreeNode[];
}

describe("file tree deleted row batch work", () => {
  it("returns the input Map if no missing deleted file can be added", () => {
    const existing = node("/repo/kept.txt", "kept.txt");
    const children = frozenChildren(existing);
    const childrenByDirectory = new Map([["/repo", children]]);
    const statusByPath = new Map<string, WorkspaceFileGitStatus>([
      ["/repo/kept.txt", "deleted"],
      ["/repo/modified.txt", "modified"],
      ["/repo/untracked.txt", "untracked"],
      ["/repo/unloaded/deleted.txt", "deleted"],
      ["/other/deleted.txt", "deleted"],
      ["/repo", "deleted"],
    ]);
    expect(
      addDeletedGitStatusRowsToWorkspaceFileTree({
        rootPath: "/repo",
        childrenByDirectory,
        statusByPath,
      }),
    ).toBe(childrenByDirectory);
    expect(children).toEqual([existing]);
  });

  it("copies only changed directories and keeps directories before sorted files", () => {
    const directory = node("/repo/z-dir", "z-dir", "directory");
    const retained = node("/repo/m.txt", "m.txt");
    const rootChildren = frozenChildren(directory, retained);
    const unrelatedChildren = frozenChildren(node("/repo/other/a.txt", "a.txt", "file", 1));
    const childrenByDirectory = new Map([
      ["/repo", rootChildren],
      ["/repo/other", unrelatedChildren],
    ]);
    const result = addDeletedGitStatusRowsToWorkspaceFileTree({
      rootPath: "/repo",
      childrenByDirectory,
      statusByPath: new Map([
        ["/repo/z.txt", "deleted"],
        ["/repo/a.txt", "deleted"],
      ]),
    });
    expect(result).not.toBe(childrenByDirectory);
    expect(result.get("/repo")?.map((entry) => entry.name)).toEqual([
      "z-dir",
      "a.txt",
      "m.txt",
      "z.txt",
    ]);
    expect(result.get("/repo")?.[0]).toBe(directory);
    expect(result.get("/repo")?.[2]).toBe(retained);
    expect(result.get("/repo/other")).toBe(unrelatedChildren);
    expect(childrenByDirectory.get("/repo")).toBe(rootChildren);
    expect(rootChildren).toEqual([directory, retained]);
  });

  it("deduplicates normalized existing and newly added paths without folding case", () => {
    const existing = node("C:\\repo\\present.txt", "present.txt");
    const childrenByDirectory = new Map([["C:/repo", frozenChildren(existing)]]);
    const result = addDeletedGitStatusRowsToWorkspaceFileTree({
      rootPath: "C:/repo",
      childrenByDirectory,
      statusByPath: new Map([
        ["C:/repo/present.txt/", "deleted"],
        ["C:/repo/new.txt", "deleted"],
        ["C:\\repo\\new.txt\\", "deleted"],
        ["C:/repo/NEW.txt", "deleted"],
      ]),
    });
    const rows = result.get("C:/repo")!;
    expect(rows).toHaveLength(3);
    expect(rows).toContain(existing);
    expect(rows.filter((entry) => entry.name === "new.txt")).toHaveLength(1);
    expect(rows.some((entry) => entry.path === "C:/repo/NEW.txt")).toBe(true);
  });

  it("preserves stable equal-name order and directory priority", () => {
    const firstFile = node("/repo/retained-a", "same");
    const secondFile = node("/repo/retained-b", "same");
    const directory = node("/repo/directory", "same", "directory");
    const result = addDeletedGitStatusRowsToWorkspaceFileTree({
      rootPath: "/repo",
      childrenByDirectory: new Map([["/repo", frozenChildren(firstFile, secondFile, directory)]]),
      statusByPath: new Map([["/repo/same", "deleted"]]),
    });
    expect(result.get("/repo")).toEqual([
      directory,
      firstFile,
      secondFile,
      { path: "/repo/same", name: "same", type: "file", depth: 0 },
    ]);
  });

  it("uses the existing nested Windows parent/depth rules", () => {
    const childrenByDirectory = new Map([
      ["C:\\repo\\src\\deep", frozenChildren()],
      ["C:\\repo", frozenChildren()],
    ]);
    const result = addDeletedGitStatusRowsToWorkspaceFileTree({
      rootPath: "C:\\repo\\",
      childrenByDirectory,
      statusByPath: new Map([
        ["C:\\repo\\src\\deep\\gone.ts", "deleted"],
        ["C:\\repo\\gone.ts", "deleted"],
      ]),
    });
    expect(result.get("C:\\repo\\src\\deep")).toEqual([
      { path: "C:\\repo\\src\\deep\\gone.ts", name: "gone.ts", type: "file", depth: 2 },
    ]);
    expect(result.get("C:\\repo")?.[0]?.depth).toBe(0);
  });

  it("sorts a 1,000-file deletion batch with one directory-sized comparison budget", () => {
    const count = 1000;
    const statusByPath = new Map<string, WorkspaceFileGitStatus>(
      Array.from({ length: count }, (_, index) => [
        `/repo/deleted-${String(index).padStart(4, "0")}.txt`,
        "deleted",
      ]),
    );
    const compare = vi.spyOn(String.prototype, "localeCompare");
    let result: Map<string, WorkspaceFileTreeNode[]>;
    let comparisonCount: number;
    try {
      result = addDeletedGitStatusRowsToWorkspaceFileTree({
        rootPath: "/repo",
        childrenByDirectory: new Map([["/repo", frozenChildren()]]),
        statusByPath,
      });
      comparisonCount = compare.mock.calls.length;
    } finally {
      compare.mockRestore();
    }
    expect(result.get("/repo")?.map((entry) => entry.path)).toEqual([...statusByPath.keys()]);
    expect(comparisonCount).toBeLessThan(count * 12);
  });
});
