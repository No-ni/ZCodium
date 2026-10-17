import { describe, expect, it } from "vitest";
import {
  filterWorkspaceFileTreeRows,
  getWorkspaceDirectoryGitStatuses,
  getWorkspaceFileGitStatus,
  type WorkspaceFileGitStatus,
  type WorkspaceFileTreeRow,
} from "@/workspace-file-tree/model.js";

function row(path: string, type: "file" | "directory" = "directory"): WorkspaceFileTreeRow {
  return Object.freeze({
    path,
    name: path.split(/[\\/]/).at(-1) ?? path,
    type,
    depth: 0,
    expanded: true,
    loaded: true,
    loading: false,
    error: null,
  });
}

function reference(
  rows: WorkspaceFileTreeRow[],
  statusByPath: ReadonlyMap<string, WorkspaceFileGitStatus>,
) {
  return rows.filter((entry) => {
    const status = getWorkspaceFileGitStatus(statusByPath, entry.path);
    return (
      (status !== null && status !== "ignored") ||
      (entry.type === "directory" &&
        getWorkspaceDirectoryGitStatuses(statusByPath, entry.path).length > 0)
    );
  });
}

describe("file tree changed directory filter", () => {
  it("preserves strict descendant, separator, case and ignored status semantics", () => {
    const rows = [
      row("/"),
      row("/repo"),
      row("/repo/src"),
      row("/repo/src/"),
      row("/repo/sr"),
      row("/repo/src/deleted.ts", "file"),
      row("/repo/ignored", "file"),
      row("/repo/ignored-only"),
      row("/repo/empty"),
      row("/repo/SRC"),
      row("C:\\repo"),
      row("C:/repo/src"),
      row("C:\\repo\\src\\deep"),
      row("C:/repo/src/changed.ts", "file"),
      row("C:/repo/sr"),
      row("C:"),
      row("//server/share"),
      row("//server/share/folder"),
    ];
    const statuses = new Map<string, WorkspaceFileGitStatus>([
      ["/repo/src/deleted.ts", "deleted"],
      ["/repo/ignored", "ignored"],
      ["/repo/ignored-only/a", "ignored"],
      ["C:\\repo\\src\\deep\\changed.ts\\", "modified"],
      ["C:/repo/src/changed.ts", "added"],
      ["//server/share/folder/file", "renamed"],
    ]);
    const before = [...statuses];
    const result = filterWorkspaceFileTreeRows({
      rows,
      searchQuery: "",
      changedOnly: true,
      statusByPath: statuses,
    });
    expect(result).toEqual(reference(rows, statuses));
    expect(result).toContain(rows[0]);
    expect(result).toContain(rows[7]);
    expect(result).not.toContain(rows[4]);
    expect(result).not.toContain(rows[6]);
    expect(result).not.toContain(rows[9]);
    expect([...statuses]).toEqual(before);
    expect(result.every((entry) => rows.includes(entry))).toBe(true);
  });

  it("keeps direct directory changes and search parent/child ordering", () => {
    const rows = [
      row("/repo/src"),
      row("/repo/src/keep.txt", "file"),
      row("/repo/src/other.txt", "file"),
      row("/repo/direct"),
      row("/repo/ignored"),
    ];
    const statuses = new Map<string, WorkspaceFileGitStatus>([
      ["/repo/src/keep.txt", "modified"],
      ["/repo/src/other.txt", "added"],
      ["/repo/direct", "deleted"],
      ["/repo/ignored", "ignored"],
    ]);
    expect(
      filterWorkspaceFileTreeRows({
        rows,
        searchQuery: "keep",
        changedOnly: true,
        statusByPath: statuses,
      }),
    ).toEqual([rows[0], rows[1]]);
    expect(
      filterWorkspaceFileTreeRows({
        rows,
        searchQuery: "",
        changedOnly: true,
        statusByPath: statuses,
      }),
    ).toEqual(reference(rows, statuses));
    expect(
      filterWorkspaceFileTreeRows({
        rows,
        searchQuery: "",
        changedOnly: false,
        statusByPath: statuses,
      }),
    ).toBe(rows);
  });

  it("uses current Git contents on every call instead of retaining an index", () => {
    const rows = [row("/repo/a"), row("/repo/b")];
    const statuses = new Map<string, WorkspaceFileGitStatus>([["/repo/a/file", "modified"]]);
    const filter = () =>
      filterWorkspaceFileTreeRows({
        rows,
        searchQuery: "",
        changedOnly: true,
        statusByPath: statuses,
      });
    expect(filter()).toEqual([rows[0]]);
    statuses.clear();
    statuses.set("/repo/b/file", "deleted");
    expect(filter()).toEqual([rows[1]]);
  });

  it("visits Git entries once for a thousand-directory changed filter", () => {
    let entryVisits = 0;
    class ObservedMap extends Map<string, WorkspaceFileGitStatus> {
      override *[Symbol.iterator]() {
        for (const entry of super[Symbol.iterator]()) {
          entryVisits++;
          yield entry;
        }
      }
      override *keys() {
        for (const key of super.keys()) {
          entryVisits++;
          yield key;
        }
      }
    }
    const rows = Array.from({ length: 1000 }, (_, index) => row(`/repo/dir-${index}`));
    const statuses = new ObservedMap(rows.map((entry) => [`${entry.path}/file`, "modified"]));
    expect(
      filterWorkspaceFileTreeRows({
        rows,
        searchQuery: "",
        changedOnly: true,
        statusByPath: statuses,
      }),
    ).toEqual(rows);
    expect(entryVisits).toBe(1000);
  });
});
