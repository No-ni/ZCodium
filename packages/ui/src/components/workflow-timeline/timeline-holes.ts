import {
  WORKFLOW_HOLE_SITE_ID_PATTERN,
  type WorkflowRunHole,
  type WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";

/**
 * 留白在时间线模型上的派生（最小实现）。
 *
 * 一个留白就是**一个阶段**：id = 站点 id（`hole#<8 位十六进制>`）、name = 脚本里的字面量。
 * 数据来源有两处，展示**不自算状态**：
 *   - **v4 归约**：`run.holes[]` 说这一站 waiting / filled，`run.phaseHoles` 说 `run.phaseNames`
 *     里哪几站还开着；这是补全 / 新一世之后仍然正确的活来源。
 *   - **display 载荷**：`graph.holes[]`（还开着的留白 + 类型）与 `phases[].fill` / `steps[].fill`
 *     （某次补全写进来的阶段 / 站点）。旧宿主没有这两块时归约仍够画出虚线灯。
 *
 * 无 React、无 DOM、无时间。留白的类型（`hole<T>` 的 T）不进画面，只是编译契约。
 */

export type TimelineHoleState = "open" | "waiting" | "filled";

export interface TimelineHole {
  siteId: string;
  /** 等待中来自 `run.holes`，开着的来自 display；两处都没有时退回站点 id。 */
  name?: string;
  state: TimelineHoleState;
  /** 主代理收到的提示语（等待中，来自 `run.holes`）。 */
  prompt?: string;
  /** 脚本的尾巴：轨道在它之后多跑一截。 */
  tail?: true;
  /** 到达时刻（等待中）；补全时刻（补全后）。 */
  since?: number;
  filledAt?: number;
  filledBy?: string;
}

/** 一次有阶段的补全留下的头：覆盖 `from..to` 这几站（下标指向阶段表）。 */
export interface TimelineFill {
  holeId: string;
  name: string;
  from: number;
  to: number;
  filledAt?: number;
}

export type HoleLabels = ReadonlyMap<string, { name: string }>;

/** 留白 id → 包着它的留白 id（顶层留白不在表里）。 */
export type HoleParents = Readonly<Record<string, string>>;

export interface HoleTable {
  /** 阶段 id → 这一站是留白（开着的，或补全过的自己那站）。 */
  byPhase: ReadonlyMap<string, TimelineHole>;
  /** 有阶段的补全的头，按 `from` 升序。 */
  fills: TimelineFill[];
  /** 留白之间的包含关系。 */
  parents: HoleParents;
}

export function isHoleSiteId(id: string): boolean {
  return WORKFLOW_HOLE_SITE_ID_PATTERN.test(id);
}

/** `id` 起、沿父表一路向外的每一层留白（自己在最前）；防环：同一个 id 不走第二次。 */
function holeAncestors(id: string, parents: HoleParents): string[] {
  const out: string[] = [];
  for (
    let cur: string | undefined = id;
    cur !== undefined && !out.includes(cur);
    cur = parents[cur]
  ) {
    if (isHoleSiteId(cur)) out.push(cur);
  }
  return out;
}

/** `id` 是补全 `holeId` 本身、还是它里面（任意深度）的留白。 */
export function fillContains(holeId: string, id: string, parents: HoleParents): boolean {
  return holeAncestors(id, parents).includes(holeId);
}

/**
 * 父表：每个留白自己的阶段与站点上的 `fill` 就是包着它的留白。阶段优先（补全过的留白只剩阶段），
 * 站兜底（开着的留白在 display 上是一个 kind hole 的站）。
 */
export function holeParentsOf(
  graph: Pick<WorkflowCausalityGraphData, "steps">,
  phases: readonly { id: string; fill?: string }[],
): HoleParents {
  const parents: Record<string, string> = {};
  for (const step of graph.steps) {
    if (step.fill !== undefined && step.fill !== step.id) parents[step.id] = step.fill;
  }
  for (const phase of phases) {
    if (isHoleSiteId(phase.id) && phase.fill !== undefined && phase.fill !== phase.id)
      parents[phase.id] = phase.fill;
  }
  return parents;
}

/** 一个留白记录从归约 / display 合成统一的展示态。 */
function timelineHoleOf(
  siteId: string,
  name: string | undefined,
  live: WorkflowRunHole | undefined,
  tail: boolean,
): TimelineHole {
  const waiting = live?.state === "waiting";
  const filled = live?.state === "filled";
  return {
    siteId,
    ...(name === undefined ? {} : { name }),
    state: waiting ? "waiting" : filled ? "filled" : "open",
    ...(tail ? { tail: true as const } : {}),
    ...(waiting && live?.since !== undefined ? { since: live.since } : {}),
    ...(waiting && live?.prompt !== undefined ? { prompt: live.prompt } : {}),
    ...(filled && live?.filledAt !== undefined ? { filledAt: live.filledAt } : {}),
    ...(filled && live?.filledBy !== undefined ? { filledBy: live.filledBy } : {}),
  };
}

/**
 * 从 display 与 run 读出留白表。`phases` 是模型建站用的那张阶段表（隐式阶段已合成），下标与站一致。
 * 补全过的留白自己的阶段装着体的 ask 时也进表，状态是 `filled`。
 */
export function holeTable(
  graph: WorkflowCausalityGraphData,
  phases: readonly { id: string; name?: string; fill?: string }[],
  run: WorkflowRunState | undefined,
  labels: HoleLabels | undefined,
  parents: HoleParents = holeParentsOf(graph, phases),
): HoleTable {
  const runHoles = new Map((run?.holes ?? []).map((hole) => [hole.siteId, hole]));
  const byPhase = new Map<string, TimelineHole>();
  const open = new Set<string>();
  const names = run?.phaseNames;
  const openIndices = run?.phaseHoles;
  const liveOpen =
    names === undefined || openIndices === undefined
      ? undefined
      : new Set(
          openIndices.flatMap((i) => {
            const name = names[i];
            const phase =
              phases.find((candidate) => candidate.id === name) ??
              phases.find((candidate) => candidate.name === name);
            return phase === undefined ? [] : [phase.id];
          }),
        );
  for (const hole of graph.holes ?? []) {
    // 创建图可能仍带开放留白；补全后的空 phaseHoles 也是权威事实，不能让旧图把灯重新打开。
    if (
      runHoles.get(hole.siteId)?.state === "filled" ||
      (liveOpen !== undefined && !liveOpen.has(hole.siteId))
    )
      continue;
    open.add(hole.siteId);
    byPhase.set(
      hole.siteId,
      timelineHoleOf(hole.siteId, hole.name, runHoles.get(hole.siteId), hole.tail === true),
    );
  }
  // run 的归约是补全 / 新一世之后仍然正确的活来源：`phaseHoles` 说哪几站还开着，
  // `holes[]` 说它是 waiting 还是 filled。display 缺席（旧宿主）时这里仍然画得出虚线灯。
  const phaseNames = run?.phaseNames;
  const phaseHoles = run?.phaseHoles;
  if (phaseNames !== undefined && phaseHoles !== undefined) {
    for (const index of phaseHoles) {
      const name = phaseNames[index];
      const phase =
        phases.find((candidate) => candidate.id === name) ??
        phases.find((candidate) => candidate.name === name);
      if (phase === undefined || byPhase.has(phase.id)) continue;
      const live =
        (run?.holes ?? []).find((hole) => hole.name === name || hole.siteId === phase.id) ??
        runHoles.get(phase.id);
      open.add(phase.id);
      byPhase.set(phase.id, timelineHoleOf(phase.id, name, live, false));
    }
  }
  // 补全过的留白：run 记过 filled 的、被某个阶段 / 站点的 `fill` 点名的、阶段 id 本身就是留白 id 的。
  const filled = new Set<string>();
  for (const hole of runHoles.values()) if (hole.state === "filled") filled.add(hole.siteId);
  for (const phase of phases) {
    if (phase.fill !== undefined)
      for (const id of holeAncestors(phase.fill, parents)) filled.add(id);
    if (isHoleSiteId(phase.id)) filled.add(phase.id);
  }
  for (const step of graph.steps) {
    if (step.fill !== undefined) for (const id of holeAncestors(step.fill, parents)) filled.add(id);
  }
  for (const id of open) filled.delete(id);

  const index = new Map(phases.map((phase, i) => [phase.id, i]));
  const fills: TimelineFill[] = [];
  for (const holeId of filled) {
    const own = index.get(holeId);
    if (own === undefined) continue;
    const live = runHoles.get(holeId);
    const label = labels?.get(holeId);
    // 已补记录也必须进站表；只生成 fills 会让旧开放灯无法翻转成普通灯。
    const metadata = graph.holes?.find((candidate) => candidate.siteId === holeId);
    byPhase.set(holeId, {
      ...timelineHoleOf(
        holeId,
        label?.name ?? live?.name ?? phases[own]?.name,
        live,
        metadata?.tail === true,
      ),
      state: "filled",
    });
    // 体：`fill` 是它、或是它里面任一层留白的站。
    const body = phases.flatMap((phase, i) =>
      phase.fill !== undefined && fillContains(holeId, phase.fill, parents) ? [i] : [],
    );
    fills.push({
      holeId,
      name: label?.name ?? live?.name ?? holeId,
      from: own,
      to: body.length === 0 ? own : Math.max(own, ...body),
      ...(live?.filledAt === undefined ? {} : { filledAt: live.filledAt }),
    });
  }
  fills.sort((left, right) => left.from - right.from);
  return { byPhase, fills, parents };
}

/** 一站属于哪片补全区域：已补全的留白自己的站属于它自己，其余站属于阶段的 `fill`。 */
export function stationFillOf(
  phase: { id: string; fill?: string },
  hole: TimelineHole | undefined,
): { fill?: string } {
  const fill = hole?.state === "filled" ? phase.id : phase.fill;
  return fill === undefined ? {} : { fill };
}

/** 末站是尾巴留白时的残段画法；末站不是留白时 undefined。 */
export function tailStubOf(
  stations: readonly { hole?: TimelineHole }[],
): "open" | "filled" | undefined {
  const hole = stations[stations.length - 1]?.hole;
  if (hole?.tail !== true) return undefined;
  return hole.state === "filled" ? "filled" : "open";
}

/**
 * 补全后的「同时在跑」表：把 v4 归约算好的 `run.phaseAlongside`（有名阶段下标空间）映射回阶段 id，
 * 供时间线呈现插入了 k 站之后右移过的带。归约已按插入位置把旧表 `> h` 的下标一律 `+k`，这里**只搬运**，
 * 不再计算偏移。`phaseNames` / `phaseAlongside` 缺席时 undefined（沿用 display）；空项明确清除旧 alongside。
 */
export function phaseAlongsideOfRun(
  run: WorkflowRunState | undefined,
  phases: readonly { id: string; name?: string }[],
): Map<string, string[]> | undefined {
  const names = run?.phaseNames;
  const alongside = run?.phaseAlongside;
  if (names === undefined || alongside === undefined) return undefined;
  const idByName = new Map(
    phases.flatMap((phase) => (phase.name === undefined ? [] : [[phase.name, phase.id] as const])),
  );
  const out = new Map<string, string[]>();
  for (let i = 0; i < names.length; i += 1) {
    const selfId = idByName.get(names[i]!);
    if (selfId === undefined) continue;
    const ids: string[] = [];
    for (const j of alongside[i] ?? []) {
      const name = names[j];
      const id = name === undefined ? undefined : idByName.get(name);
      if (id === undefined || id === selfId || ids.includes(id)) continue;
      ids.push(id);
    }
    // 空项表示归约已清除此站的并行带，不能回落旧 display.alongside。
    out.set(selfId, ids);
  }
  return out;
}

/** 开放留白画成虚线灯的判据（状态不是 filled）。 */
export function holeLampDashed(hole: TimelineHole | undefined): boolean {
  return hole !== undefined && hole.state !== "filled";
}
