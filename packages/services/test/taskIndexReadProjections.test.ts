import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import type { ZCodeTaskListKind, ZCodeTaskListSortBy } from "../src/session/zcodeTaskListTypes.js";

interface FixtureTask {
  meta: ZCodeTaskMeta;
  body: string;
  pinned: boolean;
  archived: boolean;
  deleted?: boolean;
}

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

async function createFixture(tasks: FixtureTask[]) {
  const root = await mkdtemp(join(tmpdir(), "zcodium-task-read-projections-"));
  const path = join(root, "tasks.sqlite");
  const repo = new TaskIndexRepo(path);
  disposals.push(async () => {
    repo.close();
    await rm(root, { recursive: true, force: true });
  });
  for (const task of tasks) {
    await repo.syncTaskMeta({
      meta: Object.freeze(task.meta),
      searchableText: task.body,
      pinned: task.pinned,
      archived: task.archived,
      deleted: task.deleted,
      titleOverridden: task.meta.titleOverridden,
    });
  }
  return { repo, path };
}

async function measureRead<T>(operation: () => Promise<T>) {
  let bodyCharacters = 0;
  let bodyRows = 0;
  const originalPrepare = DatabaseSync.prototype.prepare;
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (sql) {
    const statement = originalPrepare.call(this, sql);
    if (/\bSELECT\b[\s\S]*\bFROM tasks\b/u.test(sql)) {
      const originalAll = statement.all.bind(statement);
      vi.spyOn(statement, "all").mockImplementation((...args) => {
        const rows = originalAll(...args);
        for (const row of rows) {
          if (typeof row.searchable_text === "string") {
            bodyRows += 1;
            bodyCharacters += row.searchable_text.length;
          }
        }
        return rows;
      });
    }
    return statement;
  });
  try {
    const result = await operation();
    return { result, bodyCharacters, bodyRows };
  } finally {
    prepare.mockRestore();
    vi.restoreAllMocks();
  }
}

const localScope = { workspacePath: "/synthetic-index" };
const remoteScope = { ...localScope, workspaceIdentity: "remote-a" };
const workspaceScopes = [localScope, { ...remoteScope, workspaceIdentity: " remote-a " }];
const body = `needle ${"x".repeat(199_993)}`;

function fixtureTasks(): FixtureTask[] {
  return Array.from({ length: 64 }, (_, index) => ({
    meta: {
      ...localScope,
      workspaceIdentity: index < 32 ? undefined : remoteScope.workspaceIdentity,
      taskId: `task-${String(index % 32).padStart(3, "0")}`,
      traceId: `trace-${index}`,
      title: `title ${index}`,
      titleOverridden: index % 7 === 0,
      createdAt: index,
      updatedAt: 100 - index,
      mode: "build",
      provider: "glm",
      model: "model-a",
      thoughtLevel: "high",
      status: "completed",
      unreadAt: index % 5 === 0 ? 1_000 + index : undefined,
      cronAutomationId: "automation-a",
      ...(index === 0 ? { offPeakTaskId: "off-peak-a" } : {}),
    },
    body,
    pinned: index % 3 === 0,
    archived: index % 4 === 0,
  }));
}

function sorted(tasks: FixtureTask[], sortBy: ZCodeTaskListSortBy = "updated") {
  return [...tasks].sort((left, right) => {
    const primary = sortBy === "created" ? "createdAt" : "updatedAt";
    const secondary = sortBy === "created" ? "updatedAt" : "createdAt";
    return (
      right.meta[primary] - left.meta[primary] ||
      right.meta[secondary] - left.meta[secondary] ||
      right.meta.taskId.localeCompare(left.meta.taskId)
    );
  });
}

function belongsToKind(task: FixtureTask, kind: ZCodeTaskListKind) {
  if (kind === "archived") return task.archived;
  if (kind === "pinned") return task.pinned && !task.archived;
  return !task.pinned && !task.archived;
}

function emptySearchSnippets(meta: ZCodeTaskMeta) {
  expect(meta).not.toHaveProperty("searchSnippet");
  expect(meta).not.toHaveProperty("searchSnippets");
}

describe("TaskIndexRepo read projections", () => {
  it("returns full metadata without materializing the search body", async () => {
    const tasks = fixtureTasks();
    const { repo } = await createFixture(tasks);
    const measured = await measureRead(() => repo.listTaskMetas({ provider: "glm" }));
    expect(measured.result).toEqual(sorted(tasks).map((task) => task.meta));
    expect(measured.result).toHaveLength(64);
    expect(
      measured.bodyCharacters,
      `materialized ${measured.bodyRows} body rows / ${measured.bodyCharacters} characters`,
    ).toBe(0);
  });

  it("keeps scoped pin/archive reads and trimmed identity isolated without reading bodies", async () => {
    const tasks = fixtureTasks();
    const { repo } = await createFixture(tasks);
    const measurements = [];
    for (const params of [
      { ...localScope, pinned: false, archived: false },
      { ...localScope, pinned: true, archived: false },
      { ...remoteScope, workspaceIdentity: " remote-a ", archived: true },
    ]) {
      const targetIdentity =
        "workspaceIdentity" in params ? params.workspaceIdentity?.trim() : undefined;
      const expected = sorted(
        tasks.filter(
          (task) =>
            task.meta.workspaceIdentity === targetIdentity &&
            (params.pinned === undefined || task.pinned === params.pinned) &&
            task.archived === params.archived,
        ),
      ).map((task) => task.meta);
      const measured = await measureRead(() => repo.listTaskMetas({ ...params, provider: "glm" }));
      expect(measured.result).toEqual(expected);
      measurements.push(measured.bodyCharacters);
    }
    expect(measurements).toEqual([0, 0, 0]);
  });

  it("lists automation metadata in creation order without reading bodies", async () => {
    const tasks = fixtureTasks();
    const { repo } = await createFixture(tasks);
    const measured = await measureRead(() => repo.listSessionsByAutomation("automation-a"));
    expect(measured.result).toEqual(sorted(tasks, "created").map((task) => task.meta));
    expect(measured.bodyCharacters).toBe(0);
    expect(await repo.listSessionsByAutomation("missing-automation")).toEqual([]);
  });

  it("preserves kinds, both sorts, limits and counts for absent or whitespace search", async () => {
    const tasks = fixtureTasks();
    const { repo } = await createFixture(tasks);
    const measurements = [];
    for (const kind of ["active", "timeline", "pinned", "archived"] as const) {
      for (const sortBy of ["updated", "created"] as const) {
        const expected = sorted(
          tasks.filter((task) => belongsToKind(task, kind)),
          sortBy,
        );
        for (const search of [undefined, " \t "]) {
          for (const limit of [undefined, 5]) {
            const measured = await measureRead(() =>
              repo.queryTaskList({ kind, sortBy, workspaceScopes, search, limit, provider: "glm" }),
            );
            const visible = limit === undefined ? expected : expected.slice(0, limit);
            expect(measured.result).toEqual({
              items: visible.map((task) => task.meta),
              total: expected.length,
              hasMore: expected.length > visible.length,
            });
            measured.result.items.forEach(emptySearchSnippets);
            measurements.push(measured.bodyCharacters);
          }
        }
      }
    }
    expect(measurements.every((characters) => characters === 0)).toBe(true);
    expect(
      await repo.queryTaskList({ kind: "active", sortBy: "updated", workspaceScopes: [] }),
    ).toEqual({
      items: [],
      total: 0,
      hasMore: false,
    });
  });

  it("still reads complete bodies for searches and emits the same snippets and pagination", async () => {
    const tasks = fixtureTasks();
    const { repo } = await createFixture(tasks);
    const expected = sorted(tasks.filter((task) => belongsToKind(task, "active")));
    // 命中词后半径为 72 字符；其中一个字符是正文里已有的空格。
    const snippet = `needle ${"x".repeat(71)}...`;
    const measured = await measureRead(() =>
      repo.queryTaskList({
        kind: "active",
        sortBy: "updated",
        workspaceScopes,
        search: "  NEEDLE  ",
        limit: 5,
        provider: "glm",
      }),
    );
    expect(measured.result).toEqual({
      items: expected
        .slice(0, 5)
        .map((task) => ({ ...task.meta, searchSnippet: snippet, searchSnippets: [snippet] })),
      total: expected.length,
      hasMore: true,
    });
    expect(measured.bodyCharacters).toBe(5 * 200_000);
    expect(measured.bodyRows).toBe(5);
  });

  it("retains provider/deleted filters, workspacePurpose, title fallback and missing results", async () => {
    const tasks = fixtureTasks()
      .slice(0, 4)
      .map((task) => ({ ...task, pinned: false, archived: false }));
    tasks[0]!.meta = { ...tasks[0]!.meta, title: "Needle title", cronAutomationId: undefined };
    tasks[0]!.body = "title-only body";
    tasks[1]!.body = "prefix needle suffix";
    tasks[2]!.deleted = true;
    const { repo, path } = await createFixture(tasks);
    const db = new DatabaseSync(path);
    try {
      db.prepare(
        "UPDATE tasks SET provider = 'retired-provider' WHERE workspace_key = ? AND task_id = ?",
      ).run(localScope.workspacePath, tasks[3]!.meta.taskId);
    } finally {
      db.close();
    }
    const scopes = [{ ...localScope, workspacePurpose: "conversation" as const }];
    const result = await repo.queryTaskList({
      kind: "active",
      sortBy: "updated",
      workspaceScopes: scopes,
      search: "needle",
      provider: "glm",
    });
    expect(result).toEqual({
      items: [
        {
          ...tasks[0]!.meta,
          workspacePurpose: "conversation",
          searchSnippet: "title-only body",
          searchSnippets: ["title-only body"],
        },
        {
          ...tasks[1]!.meta,
          workspacePurpose: "conversation",
          searchSnippet: "prefix needle suffix",
          searchSnippets: ["prefix needle suffix"],
        },
      ],
      total: 2,
      hasMore: false,
    });
    expect(
      (await repo.listTaskMetas({ ...localScope, provider: "glm" })).map((meta) => meta.taskId),
    ).toEqual([tasks[0]!.meta.taskId, tasks[1]!.meta.taskId]);
    expect(
      (await repo.listTaskMetas({ ...localScope, provider: "glm", includeDeleted: true })).map(
        (meta) => meta.taskId,
      ),
    ).toEqual(tasks.slice(0, 3).map((task) => task.meta.taskId));
    expect(
      await repo.queryTaskList({
        kind: "active",
        sortBy: "updated",
        workspaceScopes: scopes,
        search: "missing-term",
        provider: "glm",
      }),
    ).toEqual({ items: [], total: 0, hasMore: false });
  });

  it("keeps body persistence, metadata-only writes and unread compare-and-swap unchanged", async () => {
    const task = fixtureTasks()[0]!;
    task.pinned = false;
    task.archived = false;
    const { repo, path } = await createFixture([task]);
    const target = { ...localScope, taskId: task.meta.taskId };
    await repo.updateTaskState({ ...target, patch: { pinned: true } });
    await repo.applyAgentPatch({ ...target, patch: { status: "completed", updatedAt: 200 } });
    const unread = await repo.updateTaskState({ ...target, patch: { unreadAt: 1_000 } });
    const stale = await repo.clearTaskUnreadIfMatches({
      ...target,
      expectedUnreadAt: task.meta.unreadAt!,
    });
    expect(stale.cleared).toBe(false);
    expect(stale.meta.unreadAt).toBe(unread.unreadAt);
    const current = await repo.clearTaskUnreadIfMatches({
      ...target,
      expectedUnreadAt: unread.unreadAt!,
    });
    expect(current.cleared).toBe(true);
    expect(current.meta.unreadAt).toBeUndefined();
    const db = new DatabaseSync(path);
    try {
      expect(
        db
          .prepare("SELECT searchable_text FROM tasks WHERE workspace_key = ? AND task_id = ?")
          .get(localScope.workspacePath, task.meta.taskId)?.searchable_text,
      ).toBe(body);
    } finally {
      db.close();
    }
    expect(
      (
        await repo.queryTaskList({
          kind: "pinned",
          sortBy: "updated",
          workspaceScopes: [localScope],
          search: "needle",
          provider: "glm",
        })
      ).total,
    ).toBe(1);
  });
});
