import { describe, expect, it } from "vitest";
import {
  filterWorkspaceFileTreeRows,
  isWorkspaceFilePathInside,
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

const EMPTY_STATUSES: ReadonlyMap<string, WorkspaceFileGitStatus> = new Map();

/**
 * 行为基准：按当前产品契约复述的旧实现（两轮 some 全表扫描）。
 * 只用于等价性对照，不进入生产代码；changedOnly 分支由
 * performanceFileTreeChangedFilter.test.ts 覆盖，这里只锁定搜索展开语义。
 */
function referenceSearchExpansion(
  rows: WorkspaceFileTreeRow[],
  searchQuery: string,
): WorkspaceFileTreeRow[] {
  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase();
  if (!normalizedSearchQuery) return rows;
  const matchedRows = rows.filter((entry) =>
    entry.name.toLocaleLowerCase().includes(normalizedSearchQuery),
  );
  if (matchedRows.length === 0) return [];
  const matchedPathSet = new Set(matchedRows.map((entry) => entry.path));
  const matchedDirectoryPaths = matchedRows
    .filter((entry) => entry.type === "directory")
    .map((entry) => entry.path);
  return rows.filter((entry) => {
    if (matchedPathSet.has(entry.path)) return true;
    if (
      entry.type === "directory" &&
      matchedRows.some((matched) => isWorkspaceFilePathInside(entry.path, matched.path))
    ) {
      return true;
    }
    return matchedDirectoryPaths.some((directoryPath) =>
      isWorkspaceFilePathInside(directoryPath, entry.path),
    );
  });
}

function pathsOf(rows: WorkspaceFileTreeRow[]): string[] {
  return rows.map((entry) => entry.path);
}

function filterPaths(rows: WorkspaceFileTreeRow[], searchQuery: string): string[] {
  return pathsOf(
    filterWorkspaceFileTreeRows({
      rows,
      searchQuery,
      changedOnly: false,
      statusByPath: EMPTY_STATUSES,
    }),
  );
}

/** 统计一次纯计算内的字符串前缀/成员比较次数，作为修复前后的工作量证据。 */
const COUNTED_STRING_METHODS = ["startsWith", "endsWith", "includes", "indexOf", "lastIndexOf"];

function countStringComparisons(run: () => void): number {
  const prototype = String.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const originals = COUNTED_STRING_METHODS.map((name) => ({ name, original: prototype[name] }));
  let count = 0;
  for (const { name, original } of originals) {
    prototype[name] = function counted(this: string, ...args: unknown[]): unknown {
      count += 1;
      return original.apply(this, args);
    };
  }
  try {
    run();
  } finally {
    for (const { name, original } of originals) {
      prototype[name] = original;
    }
  }
  return count;
}

describe("file tree search expansion equivalence", () => {
  it("keeps matched rows, their ancestors and input order", () => {
    const rows = [
      row("/repo"),
      row("/repo/match"),
      row("/repo/match/a.txt", "file"),
      row("/repo/match/b.txt", "file"),
      row("/repo/other"),
      row("/repo/other/c.txt", "file"),
      row("/repo/other/deep"),
      row("/repo/other/deep/d.txt", "file"),
    ];
    expect(filterPaths(rows, "match")).toEqual([
      "/repo",
      "/repo/match",
      "/repo/match/a.txt",
      "/repo/match/b.txt",
    ]);
    expect(filterPaths(rows, "match")).toEqual(pathsOf(referenceSearchExpansion(rows, "match")));
  });

  it("preserves separator, trailing slash, case and UNC semantics", () => {
    const rows = [
      row("/"),
      row("/repo"),
      row("/repo/src"),
      row("/repo/src/"),
      row("/repo/sr"),
      row("/repo/src/keep.txt", "file"),
      row("/repo/SRC"),
      row("C:\\repo"),
      row("C:\\repo\\src"),
      row("C:\\repo\\src\\"),
      row("C:/repo/src/keep2.txt", "file"),
      row("//server/share"),
      row("//server/share/folder"),
      row("//server/share/folder/keep3.txt", "file"),
    ];
    const result = filterPaths(rows, "keep");
    expect(result).toEqual(pathsOf(referenceSearchExpansion(rows, "keep")));
    expect(result).toEqual([
      "/",
      "/repo",
      "/repo/src",
      "/repo/src/",
      "/repo/src/keep.txt",
      "C:\\repo",
      "C:\\repo\\src",
      "C:\\repo\\src\\",
      "C:/repo/src/keep2.txt",
      "//server/share",
      "//server/share/folder",
      "//server/share/folder/keep3.txt",
    ]);
    expect(result).not.toContain("/repo/sr");
    expect(result).not.toContain("/repo/SRC");
  });

  it("keeps every descendant of a matched directory", () => {
    const rows = [
      row("/repo"),
      row("/repo/match-dir"),
      row("/repo/match-dir/x.txt", "file"),
      row("/repo/match-dir/sub"),
      row("/repo/match-dir/sub/y.txt", "file"),
      row("/repo/plain.txt", "file"),
    ];
    expect(filterPaths(rows, "match")).toEqual([
      "/repo",
      "/repo/match-dir",
      "/repo/match-dir/x.txt",
      "/repo/match-dir/sub",
      "/repo/match-dir/sub/y.txt",
    ]);
    expect(filterPaths(rows, "match")).toEqual(pathsOf(referenceSearchExpansion(rows, "match")));
  });

  it("treats raw separator and trailing slash differences as the same path", () => {
    const rows = [
      row("/repo/src/"),
      row("/repo/src"),
      row("/repo/src/a.txt", "file"),
      row("/repo/src/b.txt", "file"),
    ];
    // 匹配目录的原始路径带尾斜杠；其余行经归一化后与其相等或位于其内。
    expect(filterPaths(rows, "src")).toEqual(pathsOf(referenceSearchExpansion(rows, "src")));
    expect(filterPaths(rows, "src")).toEqual(pathsOf(rows));
  });

  it("keeps duplicate paths and returns empty for no matches", () => {
    const rows = [row("/repo/match"), row("/repo/match"), row("/repo/other"), row("/repo/other")];
    expect(filterPaths(rows, "match")).toEqual(["/repo/match", "/repo/match"]);
    expect(filterPaths(rows, "zzz")).toEqual([]);
    expect(filterPaths(rows, "zzz")).toEqual(pathsOf(referenceSearchExpansion(rows, "zzz")));
  });

  it("returns the same array reference for empty or whitespace query", () => {
    const rows = [row("/repo/a"), row("/repo/b")];
    const empty = filterWorkspaceFileTreeRows({
      rows,
      searchQuery: "",
      changedOnly: false,
      statusByPath: EMPTY_STATUSES,
    });
    const whitespace = filterWorkspaceFileTreeRows({
      rows,
      searchQuery: "   ",
      changedOnly: false,
      statusByPath: EMPTY_STATUSES,
    });
    expect(empty).toBe(rows);
    expect(whitespace).toBe(rows);
  });

  it("matches the reference expansion on seeded random trees", () => {
    // 线性同余 PRNG：种子固定、结果可复现；覆盖混合分隔符、尾斜杠、大小写、UNC 与重复路径。
    let state = 0x2f6e2b1;
    const random = (): number => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    const roots = ["/repo", "C:\\repo", "//server/share", "/repo/src", "/repo/src/", "/"];
    const segments = [
      "src",
      "match",
      "Match",
      "other",
      "deep",
      "a",
      "b-c",
      "x.txt",
      "match.txt",
      "SRC",
    ];
    const queries = ["match", "Match", "src", "", "  ", "a", "z", ".", "x.txt"];
    for (let round = 0; round < 200; round += 1) {
      const rows: WorkspaceFileTreeRow[] = [];
      const count = 4 + Math.floor(random() * 24);
      for (let index = 0; index < count; index += 1) {
        const root = roots[Math.floor(random() * roots.length)];
        const separator = root.includes("\\") ? "\\" : "/";
        const depth = Math.floor(random() * 4);
        let path = root;
        for (let level = 0; level < depth; level += 1) {
          path += separator + segments[Math.floor(random() * segments.length)];
        }
        if (random() < 0.15) path += separator;
        rows.push(row(path, random() < 0.4 ? "file" : "directory"));
      }
      const query = queries[Math.floor(random() * queries.length)];
      expect(filterPaths(rows, query)).toEqual(pathsOf(referenceSearchExpansion(rows, query)));
    }
  });
});

describe("file tree search expansion cost", () => {
  it("does not scan every matched row for each unrelated directory row", () => {
    const rows: WorkspaceFileTreeRow[] = [];
    for (let index = 0; index < 750; index += 1) {
      rows.push(row("/repo/match/match-" + index + ".txt", "file"));
    }
    for (let index = 0; index < 750; index += 1) {
      rows.push(row("/repo/other/dir-" + index));
    }
    let result: string[] = [];
    const comparisons = countStringComparisons(() => {
      result = filterPaths(rows, "match");
    });
    // 修复前：750 个无关目录行各扫满 750 个命中行，约 56.3 万次 startsWith（平方级）。
    // 修复后：命中行前缀登记与每行逐级上溯都只和路径深度线性相关。
    expect(comparisons).toBeLessThanOrEqual(rows.length * 64);
    expect(result).toEqual(pathsOf(referenceSearchExpansion(rows, "match")));
  });

  it("does not scan every matched directory for each row", () => {
    const rows: WorkspaceFileTreeRow[] = [];
    for (let index = 0; index < 500; index += 1) {
      rows.push(row("/repo/match-dir-" + index));
    }
    for (let index = 0; index < 750; index += 1) {
      rows.push(row("/repo/other/dir-" + index));
    }
    let result: string[] = [];
    const comparisons = countStringComparisons(() => {
      result = filterPaths(rows, "match");
    });
    // 修复前：两轮 some 各约 37.5 万次 startsWith，合计约 75 万次（平方级）。
    expect(comparisons).toBeLessThanOrEqual(rows.length * 64);
    expect(result).toEqual(pathsOf(referenceSearchExpansion(rows, "match")));
  });
});
