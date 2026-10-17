import type { ZCodeTaskMeta } from "@zcode/shared";
import { describe, expect, it } from "vitest";
import { buildWorkspaceTaskListScopeItems } from "@/hooks/workspaceTaskListScopeItems.js";
import { buildTaskEntityKey, buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { buildTaskListResult } from "@/v4/buildTaskListResultFromSessions.js";
import { attachTaskListRowActivity } from "@/v4/taskListRowActivity.js";

type ScopeInputs = Parameters<typeof buildWorkspaceTaskListScopeItems>[0];

function task(taskId: string, fields: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId,
    traceId: "trace-test" as ZCodeTaskMeta["traceId"],
    title: taskId,
    workspacePath: "/repo",
    createdAt: 1,
    updatedAt: 1,
    mode: "auto",
    ...fields,
  };
}

function legacyScopeItems(params: ScopeInputs) {
  return params.scopes.map((scope) => {
    const workspaceKey = buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity);
    return {
      scope,
      workspaceKey,
      sessions: params.sessions.filter(
        (item) =>
          buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity) === workspaceKey,
      ),
      taskIndexItems: params.taskIndexItems.filter(
        (item) =>
          buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity) === workspaceKey,
      ),
    };
  });
}

describe("workspace task scope grouping work", () => {
  it("scans each input row once across 48 workspace scopes", () => {
    let pathReads = 0;
    const scopes = Array.from({ length: 48 }, (_, index) => ({ workspacePath: `/repo-${index}` }));
    const makeRows = () => {
      const rows = Array.from({ length: 1440 }, (_, index) => task(`task-${index}`));
      rows.forEach((row, index) => {
        Object.defineProperty(row, "workspacePath", {
          get() {
            pathReads++;
            return `/repo-${index % scopes.length}`;
          },
        });
      });
      return rows;
    };
    const params = {
      scopes,
      sessions: makeRows(),
      taskIndexItems: makeRows(),
    };
    pathReads = 0;
    legacyScopeItems(params);
    expect(pathReads).toBe(48 * 2880);
    pathReads = 0;
    const groups = buildWorkspaceTaskListScopeItems(params);
    expect(pathReads).toBe(2880);
    expect(groups).toHaveLength(48);
    expect(
      groups.every((group) => group.sessions.length === 30 && group.taskIndexItems.length === 30),
    ).toBe(true);
  });

  it("preserves scope order, identity isolation, fallback, duplicate scopes and empty keys", () => {
    const scopes = [
      { workspacePath: "/alias", workspaceIdentity: " remote-A:/repo " },
      { workspacePath: "/repo", workspaceIdentity: "" },
      { workspacePath: "/repo", workspaceIdentity: "remote-B:/repo" },
      { workspacePath: "/second-alias", workspaceIdentity: "remote-A:/repo" },
      { workspacePath: "", workspaceIdentity: " " },
      { workspacePath: "/missing" },
    ];
    const rows = [
      task("same", { workspaceIdentity: "remote-B:/repo" }),
      task("same", { workspaceIdentity: " remote-A:/repo " }),
      task("same", { workspaceIdentity: " " }),
      task("next", { workspacePath: "/another-path", workspaceIdentity: "remote-A:/repo" }),
      task("empty", { workspacePath: "" }),
      task("outside", { workspacePath: "/outside" }),
    ];
    rows.forEach(Object.freeze);
    Object.freeze(rows);
    const params = { scopes, sessions: rows, taskIndexItems: rows };
    const expected = legacyScopeItems(params);
    const groups = buildWorkspaceTaskListScopeItems(params);
    expect(groups).toEqual(expected);
    groups.forEach((group, index) => {
      expect(group.scope).toBe(scopes[index]);
      group.sessions.forEach((row, rowIndex) =>
        expect(row).toBe(expected[index]!.sessions[rowIndex]),
      );
      expect(group.sessions).not.toBe(group.taskIndexItems);
    });
    expect(groups[0]!.sessions).not.toBe(groups[3]!.sessions);
    expect(groups[5]!.sessions).not.toBe(groups[5]!.taskIndexItems);
    groups[0]!.sessions.pop();
    expect(groups[3]!.sessions).toHaveLength(2);
    expect(rows).toHaveLength(6);
  });

  it("recomputes changed row membership without retaining earlier input", () => {
    const scopes = [{ workspacePath: "/repo" }, { workspacePath: "/other" }];
    const first = task("moving");
    const second = task("moving", { workspacePath: "/other" });
    const oldGroups = buildWorkspaceTaskListScopeItems({
      scopes,
      sessions: [first],
      taskIndexItems: [],
    });
    const newGroups = buildWorkspaceTaskListScopeItems({
      scopes,
      sessions: [second],
      taskIndexItems: [],
    });
    expect(oldGroups.map((group) => group.sessions)).toEqual([[first], []]);
    expect(newGroups.map((group) => group.sessions)).toEqual([[], [second]]);
  });

  it("does not read input rows when no scopes are requested", () => {
    const unreadable = task("unused");
    Object.defineProperty(unreadable, "workspacePath", {
      get() {
        throw new Error("unused workspace row was read");
      },
    });
    expect(
      buildWorkspaceTaskListScopeItems({
        scopes: [],
        sessions: [unreadable],
        taskIndexItems: [unreadable],
      }),
    ).toEqual([]);
  });

  it.each(["created", "updated"] as const)(
    "keeps existing left join, membership and %s ordering",
    (sortBy) => {
      const scopes = [
        { workspacePath: "/repo" },
        { workspacePath: "/repo", workspaceIdentity: "remote-A:/repo" },
      ];
      const remote = { workspaceIdentity: "remote-A:/repo" };
      const taskIndexItems = [
        task("stored", { createdAt: 8, updatedAt: 2, unreadAt: 10 }),
        task("recent", { createdAt: 4, updatedAt: 12 }),
        task("same", { createdAt: 2, updatedAt: 8, title: "manual", titleOverridden: true }),
        task("same", { ...remote, title: "remote stored" }),
        task("pinned"),
        task("archived"),
        task("deleted"),
      ];
      const sessions = [
        attachTaskListRowActivity(
          task("same", { title: "live title", createdAt: 3, updatedAt: 9 }),
          {
            phase: "running",
            lastActivityAt: 9,
            hasBackgroundWork: false,
          },
        ),
        task("same", { ...remote, title: "remote live" }),
        task("session-only", { createdAt: 100 }),
      ];
      const params = { scopes, sessions, taskIndexItems };
      const buildResults = (groups: ReturnType<typeof buildWorkspaceTaskListScopeItems>) =>
        groups.map((group) => {
          const result = buildTaskListResult({
            sessions: group.sessions,
            taskIndexItems: group.taskIndexItems,
            kind: "timeline",
            sortBy,
            pinnedIds: new Set(["pinned"]),
            archivedIds: new Set(["archived"]),
            deletedIds: new Set(["deleted"]),
            unreadAtByTaskId: new Map([["stored", 10]]),
          });
          return {
            ...result,
            unreadTaskKeys: result.items
              .filter((row) => typeof row.unreadAt === "number")
              .map(buildTaskEntityKey),
          };
        });
      const expected = buildResults(legacyScopeItems(params));
      const results = buildResults(buildWorkspaceTaskListScopeItems(params));
      expect(results).toEqual(expected);
      expect(results[0]!.items.map((row) => row.taskId)).toEqual(
        sortBy === "created" ? ["same", "stored", "recent"] : ["same", "recent", "stored"],
      );
      expect(results[0]!.items[0]!.title).toBe("manual");
      expect(results[0]!.items.find((row) => row.taskId === "stored")).toBe(taskIndexItems[0]);
      expect(results[0]!.unreadTaskKeys).toEqual(["/repo::stored"]);
      expect(results[1]!.items.map((row) => row.title)).toEqual(["remote live"]);
    },
  );
});
