// performanceGroupedTaskViewSortKeys 的合成 fixtures 与辅助函数（非测试文件，不会被收集执行）。
import { attachTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import type {
  ZCodeGroupedTaskView,
  ZCodeGroupedTaskViewStructureMember,
  ZCodeGroupedTaskViewStructureTopOrder,
  ZCodeTaskGroup,
  ZCodeTaskListItem,
} from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";

export const WS_A = "C:/ws/alpha";
export const WS_B = "C:/ws/beta";
export const BASE_TS = 1_700_000_000_000;

export function makeTask(
  taskId: string,
  options: {
    workspacePath?: string;
    workspaceIdentity?: string;
    createdAt?: number;
    updatedAt?: number;
  } = {},
): ZCodeTaskListItem {
  return {
    taskId,
    traceId: `trace-${taskId}`,
    title: `title ${taskId}`,
    workspacePath: options.workspacePath ?? WS_A,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    createdAt: options.createdAt ?? BASE_TS,
    updatedAt: options.updatedAt ?? BASE_TS,
    mode: "build",
    status: "completed",
  } as ZCodeTaskListItem;
}

export function makeGroup(id: string, createdAt = BASE_TS): ZCodeTaskGroup {
  return { id, title: `group ${id}`, color: "blue", createdAt, updatedAt: createdAt };
}

export function makeMember(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
  groupId: string,
  options: { sortOrder?: number | null; addedAt?: number; workspaceKey?: string } = {},
): ZCodeGroupedTaskViewStructureMember {
  const workspaceKey =
    options.workspaceKey ?? (task.workspaceIdentity?.trim() || task.workspacePath);
  return {
    groupId,
    workspaceKey,
    workspacePath: task.workspacePath,
    ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
    taskId: task.taskId,
    sortOrder: options.sortOrder === undefined ? 1000 : options.sortOrder,
    addedAt: options.addedAt ?? BASE_TS,
  };
}

export function makeParams(input: {
  groups: ZCodeTaskGroup[];
  members: ZCodeGroupedTaskViewStructureMember[];
  topLevelOrders?: ZCodeGroupedTaskViewStructureTopOrder[];
  tasks: ZCodeTaskListItem[];
  sessions?: ZCodeTaskListItem[];
  pinnedIds?: readonly string[];
  archivedIds?: readonly string[];
  deletedIds?: readonly string[];
}) {
  return {
    structure: {
      groups: input.groups,
      members: input.members,
      topLevelOrders: input.topLevelOrders ?? [],
    },
    taskIndexItems: input.tasks,
    sessions: input.sessions ?? [],
    pinnedIds: new Set(input.pinnedIds ?? []),
    archivedIds: new Set(input.archivedIds ?? []),
    deletedIds: new Set(input.deletedIds ?? []),
  };
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export function firstGroup(
  view: ZCodeGroupedTaskView,
): Extract<ZCodeGroupedTaskView["nodes"][number], { type: "group" }> {
  const node = view.nodes[0];
  if (!node || node.type !== "group") throw new Error("expected a leading group node");
  return node;
}

export function topLevelTaskIds(view: ZCodeGroupedTaskView): string[] {
  return view.nodes.flatMap((node) => (node.type === "task" ? [node.task.taskId] : []));
}

export function nodeKeys(view: ZCodeGroupedTaskView): string[] {
  return view.nodes.map((node) =>
    node.type === "group"
      ? `group:${node.group.id}`
      : `task:${JSON.stringify([node.task.workspaceIdentity?.trim() || node.task.workspacePath, node.task.taskId])}`,
  );
}

// 预算计数：workspacePath/workspaceIdentity 各配一个计数 getter。
// 每次 key 构造（buildTaskWorkspaceKey）两个属性各读一次，故 key 构造次数 = 读取数 / 2。
export function makeCountedTask(taskId: string, index: number) {
  const state = { reads: 0 };
  const task = {
    taskId,
    traceId: `trace-${taskId}`,
    title: `title ${taskId}`,
    createdAt: BASE_TS + index,
    updatedAt: BASE_TS + index,
    mode: "build",
    status: "completed",
    get workspacePath(): string {
      state.reads += 1;
      return WS_A;
    },
    get workspaceIdentity(): string | undefined {
      state.reads += 1;
      return undefined;
    },
  } as unknown as ZCodeTaskListItem;
  return { task, state };
}

export function countKeyBuilds(states: ReadonlyArray<{ reads: number }>): number {
  return states.reduce((sum, state) => sum + state.reads, 0) / 2;
}

export function seededRandom(seed: number): (limit: number) => number {
  let state = seed >>> 0;
  return (limit: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % limit;
  };
}

// seeded 差分场景：多 group/多 workspace、重复成员、缺序、顶层打平、sessions enrich、
// pinned/archived/deleted 过滤都在一个输入里覆盖。
export function seededScenario(seed: number): ReturnType<typeof makeParams> {
  const random = seededRandom(seed);
  const groupCount = 1 + random(3);
  const groups = Array.from({ length: groupCount }, (_, index) =>
    makeGroup(`g${index}`, BASE_TS + index),
  );
  const tasks: ZCodeTaskListItem[] = [];
  const members: ZCodeGroupedTaskViewStructureMember[] = [];
  const total = 8 + random(20);
  for (let index = 0; index < total; index += 1) {
    const task = makeTask(`t${index}`, {
      workspacePath: random(3) === 0 ? WS_B : WS_A,
      ...(random(4) === 0 ? { workspaceIdentity: `id-${random(2)}` } : {}),
      createdAt: BASE_TS + random(60),
      updatedAt: BASE_TS + random(60),
    });
    tasks.push(task);
    if (random(3) === 0) continue;
    const groupId = `g${random(groupCount)}`;
    members.push(
      makeMember(task, groupId, {
        sortOrder: random(5) === 0 ? null : random(6) * 1000,
        addedAt: BASE_TS + random(60),
      }),
    );
    if (random(6) === 0) {
      members.push(
        makeMember(task, groupId, {
          sortOrder: random(4) === 0 ? null : random(6) * 1000,
          addedAt: BASE_TS + random(60),
        }),
      );
    }
  }
  const topLevelOrders: ZCodeGroupedTaskViewStructureTopOrder[] = [];
  for (const task of tasks) {
    if (random(3) === 0) {
      topLevelOrders.push({
        type: "task",
        workspaceKey: task.workspaceIdentity?.trim() || task.workspacePath,
        taskId: task.taskId,
        sortOrder: random(4) === 0 ? 3000 : random(5) * 1000,
      });
    }
  }
  for (const group of groups) {
    if (random(2) === 0)
      topLevelOrders.push({ type: "group", groupId: group.id, sortOrder: random(5) * 1000 });
  }
  const sessions = tasks
    .filter(() => random(3) === 0)
    .map((task) =>
      attachTaskListRowActivity(
        { ...task, title: `${task.title} live`, updatedAt: BASE_TS + 900 } as ZCodeTaskMeta,
        { phase: "running", lastActivityAt: BASE_TS + 900, hasBackgroundWork: random(2) === 0 },
      ),
    );
  return makeParams({
    groups,
    members,
    topLevelOrders,
    tasks,
    sessions,
    pinnedIds: tasks.filter(() => random(8) === 0).map((task) => task.taskId),
    archivedIds: tasks.filter(() => random(8) === 0).map((task) => task.taskId),
    deletedIds: tasks.filter(() => random(10) === 0).map((task) => task.taskId),
  });
}
