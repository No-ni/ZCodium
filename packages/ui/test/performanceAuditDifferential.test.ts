import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  applyConversationDeltas,
  coalesceConversationDeltas,
  DELIVERY_PROFILES,
  filterConversationDeltasForProfile,
  type ConversationDelta,
  type ConversationRow,
  type ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import * as workflow from "../../shared/src/zcode-protocol-v4/workflow-runs-delta.js";
import * as paths from "@/lib/path.js";
import * as codeViewer from "@/lib/codeViewer.js";
import * as tree from "@/workspace-file-tree/model.js";

// 固定审计时从 Git 导出的原始源码，避免提交后 HEAD 改变使基线变成新算法。
// 来源与内容哈希见同目录 fixtures/performance-audit-baseline/manifest.json。
// 只为这三个纯计算模块提供显式依赖；其他模块或运行时 IO 不会被这个加载器执行。
function baseline<T>(file: string, dependencies: Record<string, unknown>): T {
  const source = readFileSync(
    new URL(`./fixtures/performance-audit-baseline/${file}`, import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function("require", "exports", compiled)((id: string) => {
    if (!Object.hasOwn(dependencies, id)) throw new Error(`Unexpected baseline dependency: ${id}`);
    return dependencies[id];
  }, exports);
  return exports as T;
}

const oldApply = baseline<{ applyConversationDeltas: typeof applyConversationDeltas }>(
  "apply.ts.txt",
  { "./workflow-runs-delta.js": workflow },
).applyConversationDeltas;
const oldCoalesce = baseline<{ coalesceConversationDeltas: typeof coalesceConversationDeltas }>(
  "coalesce.ts.txt",
  { "./workflow-runs-delta.js": workflow },
).coalesceConversationDeltas;
const oldTree = baseline<typeof tree>("file-tree-model.ts.txt", {
  "@/lib/path.js": paths,
  "@/lib/codeViewer.js": codeViewer,
});

function row(rowId: number, text = "body"): ConversationRow {
  return {
    kind: "assistantText",
    rowId,
    turnId: `turn-${Math.floor(rowId / 10)}`,
    createdAt: rowId,
    createdAtSeq: rowId,
    state: "streaming",
    text,
  };
}

function snapshot(count = 60): ConversationSnapshot {
  return {
    rows: {
      window: Array.from({ length: count }, (_, i) => row(i * 2 + 1)),
      totalCount: count,
      firstRowId: count ? 1 : null,
    },
    queue: { items: [], autoDrain: true },
  } as ConversationSnapshot;
}

function freeze(value: unknown): void {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}

function random(seed: number) {
  let value = seed;
  return (limit: number) => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value % limit;
  };
}

function measure(name: string, before: () => unknown, after: () => unknown, iterations = 1) {
  const sample = (action: () => unknown) => {
    const started = performance.now();
    for (let i = 0; i < iterations; i++) action();
    return (performance.now() - started) / iterations;
  };
  for (let i = 0; i < 4; i++) {
    before();
    after();
  }
  const oldTimes: number[] = [];
  const newTimes: number[] = [];
  for (let i = 0; i < 15; i++) {
    if (i % 2) {
      newTimes.push(sample(after));
      oldTimes.push(sample(before));
    } else {
      oldTimes.push(sample(before));
      newTimes.push(sample(after));
    }
  }
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  return { name, beforeMs: median(oldTimes), afterMs: median(newTimes), samples: 15, iterations };
}

describe("whole-change audit against original source snapshots", () => {
  it("preserves values across 200 mixed histories in both delivery profiles", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const next = random(seed);
      const initial = snapshot(next(30));
      let cursor = 100;
      const deltas: ConversationDelta[] = [];
      for (let step = 0; step < 80; step++) {
        const id = next(cursor + 5);
        switch (next(5)) {
          case 0:
            deltas.push({ op: "row.appended", row: row(cursor++) });
            break;
          case 1:
            deltas.push({ op: "row.upserted", row: row(id, `replacement-${step}`) });
            break;
          case 2:
            deltas.push({ op: "row.delta", rowId: id, path: "text", append: `:${step}` });
            break;
          case 3:
            deltas.push({ op: "row.removed", fromRowId: id });
            break;
          default:
            deltas.push({ op: "state.updated", patch: { revision: step } });
        }
      }
      freeze(initial);
      freeze(deltas);
      for (const profile of [DELIVERY_PROFILES.continuous, DELIVERY_PROFILES.replayable]) {
        const filtered = filterConversationDeltasForProfile(deltas, profile);
        const expected = oldApply(initial, filtered);
        expect(applyConversationDeltas(initial, filtered), `apply seed ${seed}`).toEqual(expected);
        const merged = coalesceConversationDeltas(filtered);
        expect(merged, `coalesce seed ${seed}`).toEqual(oldCoalesce(filtered));
        expect(oldApply(initial, merged), `coalesced final state seed ${seed}`).toEqual(expected);
      }
    }
  });

  it("preserves deleted-row and changed-only results across 120 Windows/POSIX path sets", () => {
    for (let seed = 1; seed <= 120; seed++) {
      const next = random(seed);
      const rootPath = seed % 2 ? "C:/repo" : "/repo";
      const children = Array.from({ length: 24 }, (_, i) => ({
        path: `${rootPath}/entry-${i}`,
        name: `entry-${i}`,
        type: i % 3 ? ("file" as const) : ("directory" as const),
        depth: 0,
      }));
      const statuses = ["deleted", "modified", "untracked", "ignored"] as const;
      const statusByPath = new Map<string, tree.WorkspaceFileGitStatus>();
      for (let i = 0; i < 48; i++) {
        let path = `${rootPath}/entry-${next(36)}${next(2) ? "/nested/file" : ""}`;
        if (seed % 2 && next(2)) path = path.replaceAll("/", "\\");
        statusByPath.set(path, statuses[next(statuses.length)]!);
      }
      freeze(children);
      const input = {
        rootPath,
        childrenByDirectory: new Map([[rootPath, children]]),
        statusByPath,
      };
      expect(tree.addDeletedGitStatusRowsToWorkspaceFileTree(input)).toEqual(
        oldTree.addDeletedGitStatusRowsToWorkspaceFileTree(input),
      );
      const rows = children.map((node) => ({
        ...node,
        expanded: false,
        loaded: false,
        loading: false,
        error: null,
      }));
      for (const searchQuery of ["", "entry-1", "file"]) {
        const query = { rows, searchQuery, changedOnly: true, statusByPath };
        expect(tree.filterWorkspaceFileTreeRows(query)).toEqual(
          oldTree.filterWorkspaceFileTreeRows(query),
        );
      }
    }
  });

  it.each(["apply", "coalesce", "deleted rows"] as const)(
    "records uninstrumented %s elapsed time without speed assertions",
    (kind) => {
      const measurements = [];
      for (const count of kind === "apply" ? [60, 20_000] : []) {
        const initial = snapshot(count);
        const deltas: ConversationDelta[] = Array.from({ length: 20 }, () => ({
          op: "row.delta",
          rowId: count * 2 - 1,
          path: "text",
          append: ":chunk",
        }));
        expect(applyConversationDeltas(initial, deltas)).toEqual(oldApply(initial, deltas));
        measurements.push(
          measure(
            `apply ${count} rows / 20 deltas`,
            () => oldApply(initial, deltas),
            () => applyConversationDeltas(initial, deltas),
            count === 60 ? 100 : 1,
          ),
        );
      }
      for (const count of kind === "coalesce" ? [8, 2_000] : []) {
        const deltas: ConversationDelta[] = Array.from({ length: count }, (_, i) => ({
          op: "row.upserted",
          row: row(i),
        }));
        expect(coalesceConversationDeltas(deltas)).toEqual(oldCoalesce(deltas));
        measurements.push(
          measure(
            `coalesce ${count} unrelated upserts`,
            () => oldCoalesce(deltas),
            () => coalesceConversationDeltas(deltas),
            count === 8 ? 100 : 1,
          ),
        );
      }
      for (const count of kind === "deleted rows" ? [4, 500] : []) {
        const input = {
          rootPath: "/repo",
          childrenByDirectory: new Map([
            [
              "/repo",
              Array.from({ length: count }, (_, i) => ({
                path: `/repo/existing-${i}`,
                name: `existing-${i}`,
                type: "file" as const,
                depth: 0,
              })),
            ],
          ]),
          statusByPath: new Map(
            Array.from({ length: count }, (_, i) => [`/repo/deleted-${i}`, "deleted" as const]),
          ),
        };
        expect(tree.addDeletedGitStatusRowsToWorkspaceFileTree(input)).toEqual(
          oldTree.addDeletedGitStatusRowsToWorkspaceFileTree(input),
        );
        measurements.push(
          measure(
            `deleted rows ${count} existing / ${count} deleted`,
            () => oldTree.addDeletedGitStatusRowsToWorkspaceFileTree(input),
            () => tree.addDeletedGitStatusRowsToWorkspaceFileTree(input),
          ),
        );
      }
      // 数值用于审计报告，不用抖动敏感的快慢断言把 CI 变成基准机。
      console.info("PERFORMANCE_AUDIT", JSON.stringify(measurements));
    },
  );
});
