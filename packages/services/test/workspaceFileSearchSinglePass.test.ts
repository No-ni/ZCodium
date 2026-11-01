import assert from "node:assert/strict";
import { test } from "node:test";
import * as search from "@zcode/shared/workspaceFileSearch";
import type { WorkspaceFileSearchCandidate } from "@zcode/shared/workspaceFileSearch";
import { searchHostFileCandidates } from "../src/file/workspaceFileSearch.js";

function makeCandidates(count: number): WorkspaceFileSearchCandidate[] {
  return search.mapWorkspaceFileEntriesToSearchCandidates(
    Array.from({ length: count }, (_, index) => {
      const name =
        index % 5 === 0
          ? `模块-${String(index).padStart(5, "0")}.tsx`
          : `module-${String(index).padStart(5, "0")}.ts`;
      const relativePath = `src/group-${index % 97}/${name}`;
      return {
        name,
        path: `fixture/${relativePath}`,
        relativePath,
        type: index % 7 === 0 ? ("directory" as const) : ("file" as const),
      };
    }),
  );
}

function rows(candidates: WorkspaceFileSearchCandidate[]) {
  return candidates.map(({ name, path, relativePath, type }) => ({
    name,
    path,
    relativePath,
    type,
  }));
}

// 独立全排序 oracle 复用唯一公开评分函数，但不复用 top-K 插入/增量选择实现。
function sortedReference(candidates: WorkspaceFileSearchCandidate[], query: string, limit: number) {
  const normalized = query.trim();
  const matches = normalized
    ? candidates
        .map((candidate, index) => ({
          candidate,
          index,
          score: search.getWorkspaceFileSearchCandidateScore(candidate, normalized),
        }))
        .filter((item): item is typeof item & { score: number } => item.score !== null)
        .sort((a, b) => a.score - b.score || a.index - b.index)
        .map(({ candidate }) => candidate)
    : candidates
        .map((candidate, index) => ({ candidate, index }))
        .sort(
          (a, b) =>
            Number(a.candidate.type === "directory") - Number(b.candidate.type === "directory") ||
            a.index - b.index,
        )
        .map(({ candidate }) => candidate);
  return rows(Number.isFinite(limit) ? matches.slice(0, Math.max(0, Math.trunc(limit))) : matches);
}

function legacyBatchReference(
  candidates: WorkspaceFileSearchCandidate[],
  query: string,
  limit: number,
) {
  let best: WorkspaceFileSearchCandidate[] = [];
  for (let offset = 0; offset < candidates.length; offset += 2048) {
    best = search.filterWorkspaceFileSearchCandidates(
      [...best, ...candidates.slice(offset, offset + 2048)],
      query,
      { limit },
    );
  }
  return rows(best);
}

test("40k 候选各打分一次，不重复处理旧 top-K", async () => {
  const base = makeCandidates(40_000);
  const reads = new Uint16Array(base.length);
  const candidates = base.map(
    (candidate, index) =>
      new Proxy(candidate, {
        get(target, property, receiver) {
          if (property === "lowercaseName") reads[index] = (reads[index] ?? 0) + 1;
          return Reflect.get(target, property, receiver);
        },
      }),
  );
  const actual = await searchHostFileCandidates(candidates, "module", 1000);
  assert.deepEqual(actual, sortedReference(base, "module", 1000));
  const count = reads.reduce((sum, value) => sum + value, 0);
  console.log(
    `score-budget candidates=${base.length} scorings=${count} repeated=${reads.filter((value) => value > 1).length}`,
  );
  assert.equal(count, base.length, "每个候选应只评分一次，不能把旧 top-K 重新送入打分");
  assert.ok(reads.every((value) => value === 1));
});

test("多查询与整数 limit 保持独立全排序结果", async () => {
  const candidates = makeCandidates(6147);
  for (const query of ["module", "  mOdUlE ", "src/模块", "mle", "missing-no-match", ""]) {
    for (const limit of [0, 1, 17, 1000, Infinity]) {
      assert.deepEqual(
        await searchHostFileCandidates(candidates, query, limit),
        sortedReference(candidates, query, limit),
        `${query}/${limit}`,
      );
    }
  }
});

test("同分跨批仍按原始索引稳定，重复引用也不去重", async () => {
  const one = search.mapWorkspaceFileEntriesToSearchCandidates([
    { name: "module.ts", path: "fixture/module.ts", relativePath: "module.ts", type: "file" },
  ])[0]!;
  const candidates = Array.from({ length: 5000 }, (_, index) => ({
    ...one,
    id: String(index),
    path: `fixture/module-${index}.ts`,
  }));
  candidates[4097] = candidates[3]!;
  assert.deepEqual(
    await searchHostFileCandidates(candidates, "module", 4099),
    sortedReference(candidates, "module", 4099),
  );
});

test("空查询保留 files-first 与各类内部原序", async () => {
  const candidates = makeCandidates(8200);
  assert.deepEqual(
    await searchHostFileCandidates(candidates, " ", 1000),
    sortedReference(candidates, "", 1000),
  );
  assert.deepEqual(await searchHostFileCandidates([], "module", 1000), []);
});

test("非标准 limit 不顺手改变既有批合并行为", async () => {
  const candidates = makeCandidates(4200);
  for (const query of ["module", " "]) {
    for (const limit of [-1, 0, 0.5, 1.5, NaN, Infinity, -Infinity]) {
      assert.deepEqual(
        await searchHostFileCandidates(candidates, query, limit),
        legacyBatchReference(candidates, query, limit),
      );
    }
  }
});

test("并发不同 query 不共享 top-K 状态", async () => {
  const candidates = makeCandidates(8200);
  const [a, b] = await Promise.all([
    searchHostFileCandidates(candidates, "module", 1000),
    searchHostFileCandidates(candidates, "模块", 17),
  ]);
  assert.deepEqual(a, sortedReference(candidates, "module", 1000));
  assert.deepEqual(b, sortedReference(candidates, "模块", 17));
});

test("每 2048 项仍向事件循环让出", async () => {
  let scorings = 0;
  const candidates = makeCandidates(5000).map(
    (candidate) =>
      new Proxy(candidate, {
        get(target, property, receiver) {
          if (property === "lowercaseName") scorings += 1;
          return Reflect.get(target, property, receiver);
        },
      }),
  );
  const probe = new Promise<number>((resolve) => setImmediate(() => resolve(scorings)));
  const pending = searchHostFileCandidates(candidates, "module", 1000);
  assert.equal(await probe, 2048);
  await pending;
});

test("不修改候选，返回仍是四字段投影", async () => {
  const candidates = makeCandidates(32);
  const before = structuredClone(candidates);
  const result = await searchHostFileCandidates(candidates, "module", 10);
  assert.deepEqual(candidates, before);
  assert.deepEqual(Object.keys(result[0]!), ["name", "path", "relativePath", "type"]);
});

test("公开 selector 契约：append/快照/requireQuery", () => {
  assert.equal(typeof search.createWorkspaceFileSearchCandidateSelector, "function");
  const candidates = makeCandidates(20);
  const selector = search.createWorkspaceFileSearchCandidateSelector("module", { limit: 5 });
  selector.append(candidates.slice(0, 7));
  const oldSnapshot = selector.getMatches();
  const oldLength = oldSnapshot.length;
  selector.append(candidates.slice(7));
  assert.deepEqual(rows(selector.getMatches()), sortedReference(candidates, "module", 5));
  assert.equal(oldSnapshot.length, oldLength);
  const editableSnapshot = selector.getMatches();
  editableSnapshot.length = 0;
  assert.equal(selector.getMatches().length, 5);
  const empty = search.createWorkspaceFileSearchCandidateSelector(" ", { requireQuery: true });
  empty.append(candidates);
  assert.deepEqual(empty.getMatches(), []);
});
