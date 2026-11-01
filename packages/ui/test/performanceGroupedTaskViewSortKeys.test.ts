import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { buildGroupedTaskViewFromSessions } from "@/lib/buildGroupedTaskViewFromSessions.js";
import * as taskQueryCacheModule from "@/lib/taskQueryCache.js";
import * as buildTaskListResultModule from "@/v4/buildTaskListResultFromSessions.js";
import {
  BASE_TS,
  countKeyBuilds,
  deepFreeze,
  firstGroup,
  makeCountedTask,
  makeGroup,
  makeMember,
  makeParams,
  makeTask,
  nodeKeys,
  seededRandom,
  seededScenario,
  topLevelTaskIds,
  WS_A,
} from "./performanceGroupedTaskViewSortFixtures.js";

// Oracle：改动前生产源码的冻结副本（fixtures/performance-grouped-sort-baseline）。
// 只注入两个纯计算依赖（真实模块，本次不改）；import type 已被转译剔除，不执行其它模块。
const BASELINE_FIXTURE =
  "./fixtures/performance-grouped-sort-baseline/buildGroupedTaskViewFromSessions.ts.txt";
const BASELINE_MANIFEST = "./fixtures/performance-grouped-sort-baseline/manifest.json";

function loadFrozenOracle(): typeof buildGroupedTaskViewFromSessions {
  const source = readFileSync(new URL(BASELINE_FIXTURE, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded: Record<string, unknown> = {};
  new Function("require", "exports", compiled)((id: string) => {
    if (id === "@/lib/taskQueryCache.js") return taskQueryCacheModule;
    if (id === "@/v4/buildTaskListResultFromSessions.js") return buildTaskListResultModule;
    throw new Error(`Unexpected baseline dependency: ${id}`);
  }, loaded);
  return loaded.buildGroupedTaskViewFromSessions as typeof buildGroupedTaskViewFromSessions;
}

const frozenOracle = loadFrozenOracle();

describe("grouped task view sort keys", () => {
  it("冻结 fixture 与 manifest 记录的 sha256 一致", () => {
    const manifest = JSON.parse(
      readFileSync(new URL(BASELINE_MANIFEST, import.meta.url), "utf8"),
    ) as {
      sources: Array<{ fixture: string; source: string; sha256: string }>;
    };
    const entry = manifest.sources.find((source) => source.fixture.endsWith(".ts.txt"));
    expect(entry?.source).toBe("packages/ui/src/lib/buildGroupedTaskViewFromSessions.ts");
    const digest = createHash("sha256")
      .update(readFileSync(new URL(BASELINE_FIXTURE, import.meta.url)))
      .digest("hex");
    expect(digest).toBe(entry?.sha256);
  });

  it("空 structure 返回空视图", () => {
    const build = () => makeParams({ groups: [], members: [], tasks: [] });
    expect(buildGroupedTaskViewFromSessions(build())).toStrictEqual({ nodes: [] });
    expect(frozenOracle(build())).toStrictEqual({ nodes: [] });
  });

  it("单组单任务保持成员序", () => {
    const build = () => {
      const task = makeTask("solo");
      return makeParams({
        groups: [makeGroup("g1")],
        members: [makeMember(task, "g1", { sortOrder: 1000 })],
        tasks: [task],
      });
    };
    const actual = buildGroupedTaskViewFromSessions(build());
    expect(actual).toStrictEqual(frozenOracle(build()));
    expect(firstGroup(actual).tasks.map((task) => task.taskId)).toEqual(["solo"]);
  });

  it("重复成员键：缺序补写以 Map 最后写入为准且不去重", () => {
    const build = () => {
      const shared = makeTask("dup");
      const solo = makeTask("solo");
      return makeParams({
        groups: [makeGroup("g1")],
        members: [
          makeMember(solo, "g1", { sortOrder: 500, addedAt: BASE_TS + 1 }),
          makeMember(shared, "g1", { sortOrder: null, addedAt: BASE_TS + 9 }),
          makeMember(shared, "g1", { sortOrder: null, addedAt: BASE_TS + 2 }),
        ],
        tasks: [shared, solo],
      });
    };
    const actual = buildGroupedTaskViewFromSessions(build());
    expect(actual).toStrictEqual(frozenOracle(build()));
    expect(firstGroup(actual).tasks.map((task) => task.taskId)).toEqual(["solo", "dup", "dup"]);
  });

  it("重复成员键：相同 sortOrder 时保持输入次序", () => {
    const build = () => {
      const shared = makeTask("dup");
      return makeParams({
        groups: [makeGroup("g1")],
        members: [
          makeMember(shared, "g1", { sortOrder: 1000, addedAt: BASE_TS + 5 }),
          makeMember(shared, "g1", { sortOrder: 1000, addedAt: BASE_TS + 6 }),
        ],
        tasks: [shared],
      });
    };
    const actual = buildGroupedTaskViewFromSessions(build());
    expect(actual).toStrictEqual(frozenOracle(build()));
    expect(firstGroup(actual).tasks.map((task) => task.taskId)).toEqual(["dup", "dup"]);
  });

  it("缺序成员按 addedAt 降序在 max(sortOrder,0) 后补序", () => {
    const build = () => {
      const fresh = makeTask("fresh");
      const late = makeTask("late");
      const early = makeTask("early");
      return makeParams({
        groups: [makeGroup("g1")],
        members: [
          makeMember(fresh, "g1", { sortOrder: null, addedAt: BASE_TS + 100 }),
          makeMember(late, "g1", { sortOrder: 700, addedAt: BASE_TS + 50 }),
          makeMember(early, "g1", { sortOrder: null, addedAt: BASE_TS + 10 }),
        ],
        tasks: [fresh, late, early],
      });
    };
    const actual = buildGroupedTaskViewFromSessions(build());
    expect(actual).toStrictEqual(frozenOracle(build()));
    expect(firstGroup(actual).tasks.map((task) => task.taskId)).toEqual(["late", "fresh", "early"]);
  });

  it("缺序成员 addedAt 打平按 key 升序补序", () => {
    const build = () => {
      const zebra = makeTask("zebra");
      const alpha = makeTask("alpha");
      return makeParams({
        groups: [makeGroup("g1")],
        members: [
          makeMember(zebra, "g1", { sortOrder: null, addedAt: BASE_TS + 7 }),
          makeMember(alpha, "g1", { sortOrder: null, addedAt: BASE_TS + 7 }),
        ],
        tasks: [zebra, alpha],
      });
    };
    const actual = buildGroupedTaskViewFromSessions(build());
    expect(actual).toStrictEqual(frozenOracle(build()));
    expect(firstGroup(actual).tasks.map((task) => task.taskId)).toEqual(["alpha", "zebra"]);
  });

  it("负 sortOrder 不拉低 max 初始 0，补序仍从 0 起跳", () => {
    const build = () => {
      const negative = makeTask("negative");
      const missing = makeTask("missing");
      return makeParams({
        groups: [makeGroup("g1")],
        members: [
          makeMember(negative, "g1", { sortOrder: -5000, addedAt: BASE_TS + 1 }),
          makeMember(missing, "g1", { sortOrder: null, addedAt: BASE_TS + 2 }),
        ],
        tasks: [negative, missing],
      });
    };
    const actual = buildGroupedTaskViewFromSessions(build());
    expect(actual).toStrictEqual(frozenOracle(build()));
    expect(firstGroup(actual).tasks.map((task) => task.taskId)).toEqual(["negative", "missing"]);
  });

  it("同路径不同 identity 是独立 key", () => {
    const build = () => {
      const remoteA = makeTask("same", { workspaceIdentity: "id-a" });
      const remoteB = makeTask("same", { workspaceIdentity: "id-b" });
      const local = makeTask("same");
      return makeParams({
        groups: [makeGroup("g1")],
        members: [
          makeMember(remoteA, "g1", { sortOrder: 1000 }),
          makeMember(remoteB, "g1", { sortOrder: 2000 }),
          makeMember(local, "g1", { sortOrder: 3000 }),
        ],
        tasks: [remoteA, remoteB, local],
      });
    };
    const actual = buildGroupedTaskViewFromSessions(build());
    expect(actual).toStrictEqual(frozenOracle(build()));
    expect(firstGroup(actual).tasks.map((task) => task.workspaceIdentity ?? null)).toEqual([
      "id-a",
      "id-b",
      null,
    ]);
  });

  it("顶层 sortOrder 打平按 nodeMapKey 决胜", () => {
    const build = () => {
      const zebra = makeTask("zebra");
      const alpha = makeTask("alpha");
      return makeParams({
        groups: [],
        members: [],
        topLevelOrders: [
          { type: "task", workspaceKey: WS_A, taskId: "zebra", sortOrder: 2000 },
          { type: "task", workspaceKey: WS_A, taskId: "alpha", sortOrder: 2000 },
        ],
        tasks: [zebra, alpha],
      });
    };
    const actual = buildGroupedTaskViewFromSessions(build());
    expect(actual).toStrictEqual(frozenOracle(build()));
    expect(topLevelTaskIds(actual)).toEqual(["alpha", "zebra"]);
  });

  it("缺序顶层节点 createdAt 打平按 nodeMapKey 决胜", () => {
    const build = () => {
      const zebra = makeTask("zebra", { createdAt: BASE_TS + 5, updatedAt: BASE_TS + 5 });
      const alpha = makeTask("alpha", { createdAt: BASE_TS + 5, updatedAt: BASE_TS + 5 });
      return makeParams({
        groups: [makeGroup("gZ", BASE_TS + 5)],
        members: [],
        tasks: [zebra, alpha],
      });
    };
    const actual = buildGroupedTaskViewFromSessions(build());
    expect(actual).toStrictEqual(frozenOracle(build()));
    expect(nodeKeys(actual)).toEqual([
      "group:gZ",
      `task:${JSON.stringify([WS_A, "alpha"])}`,
      `task:${JSON.stringify([WS_A, "zebra"])}`,
    ]);
  });

  it("深冻结输入下成功，输出与 oracle 一致且保持输入引用", () => {
    const build = () => {
      const shared = makeTask("dup");
      const solo = makeTask("solo");
      return makeParams({
        groups: [makeGroup("g1")],
        members: [
          makeMember(shared, "g1", { sortOrder: null, addedAt: BASE_TS + 3 }),
          makeMember(solo, "g1", { sortOrder: 100 }),
        ],
        tasks: [shared, solo],
      });
    };
    const params = deepFreeze(build());
    const actual = buildGroupedTaskViewFromSessions(params);
    expect(actual).toStrictEqual(frozenOracle(build()));
    const groupNode = firstGroup(actual);
    expect(groupNode.tasks).toContain(params.taskIndexItems[0]);
    expect(groupNode.tasks).toContain(params.taskIndexItems[1]);
    expect(groupNode.group).toBe(params.structure.groups[0]);
  });

  it("seeded 随机结构与冻结 oracle 全函数输出一致", () => {
    for (const seed of [1, 7, 42, 909, 2026, 31337, 55555, 777777]) {
      const actual = buildGroupedTaskViewFromSessions(deepFreeze(seededScenario(seed)));
      const expected = frozenOracle(seededScenario(seed));
      expect(actual).toStrictEqual(expected);
    }
  });

  it("预算：随机 sortOrder 分布下单组 key 构造不超 4n+64", () => {
    const total = 256;
    const random = seededRandom(20261031);
    const orders = Array.from({ length: total }, (_, index) => 1000 + index);
    for (let index = total - 1; index > 0; index -= 1) {
      const swap = random(index + 1);
      const left = orders[index]!;
      orders[index] = orders[swap]!;
      orders[swap] = left;
    }
    const counted = Array.from({ length: total }, (_, index) =>
      makeCountedTask(`t${index}`, index),
    );
    const members = counted.map((entry, index) => ({
      groupId: "g1",
      workspaceKey: WS_A,
      workspacePath: WS_A,
      taskId: entry.task.taskId,
      sortOrder: orders[index]!,
      addedAt: BASE_TS + index,
    }));
    const view = buildGroupedTaskViewFromSessions(
      makeParams({ groups: [makeGroup("g1")], members, tasks: counted.map((entry) => entry.task) }),
    );
    expect(firstGroup(view).tasks).toHaveLength(total);
    expect(countKeyBuilds(counted.map((entry) => entry.state))).toBeLessThanOrEqual(4 * total + 64);
  });

  it("预算：已有序输入贴近结构下限，防止为所有节点预热 key", () => {
    const total = 256;
    const counted = Array.from({ length: total }, (_, index) =>
      makeCountedTask(`t${index}`, index),
    );
    const members = counted.map((entry, index) => ({
      groupId: "g1",
      workspaceKey: WS_A,
      workspacePath: WS_A,
      taskId: entry.task.taskId,
      sortOrder: 1000 + index,
      addedAt: BASE_TS + index,
    }));
    const view = buildGroupedTaskViewFromSessions(
      makeParams({ groups: [makeGroup("g1")], members, tasks: counted.map((entry) => entry.task) }),
    );
    expect(firstGroup(view).tasks).toHaveLength(total);
    // 结构下限：merge join + active 桶 + 首轮记录各一次 key 构造。
    expect(countKeyBuilds(counted.map((entry) => entry.state))).toBeLessThanOrEqual(3 * total + 8);
  });
});
