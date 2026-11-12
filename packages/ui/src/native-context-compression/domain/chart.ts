import type { NativeContextObservation, NativeContextOperationSummary } from "../contract.js";

export interface NativeContextChartPoint {
  observation: NativeContextObservation;
  values: Readonly<Record<string, number | null>>;
}
export interface NativeContextChartSeries {
  key: string;
  label: string;
  color: string;
  dash?: string;
  kind?: "line" | "point";
}
export interface NativeContextChartRow {
  index: number;
  observation: NativeContextObservation | null;
  values: Readonly<Record<string, number | null>>;
}

export interface NativeContextTrendSegment {
  segmentId: string;
  generation: number;
  policyVersion: number;
  model: NativeContextObservation["model"] | null;
  createdAt: number;
}

/** 范围只过滤原始主请求，不改写版本、位置或计量。 */
export function nativeContextMainRequests(
  observations: readonly NativeContextObservation[],
  segmentId: string | null,
  range: "50" | "200" | "segment",
): NativeContextObservation[] {
  const main = observations
    .filter((item) => item.purpose === "main" && (!segmentId || item.segmentId === segmentId))
    .sort(
      (left, right) => left.requestSeq - right.requestSeq || left.attemptIndex - right.attemptIndex,
    );
  return range === "segment" ? main : main.slice(-Number(range));
}

/** 只有操作/维护的段也可浏览；模型标签只能来自该段真正的主请求。 */
export function nativeContextTrendSegments(
  observations: readonly NativeContextObservation[],
  maintenance: readonly NativeContextObservation[],
  operations: readonly NativeContextOperationSummary[],
): NativeContextTrendSegment[] {
  const segments = new Map<string, NativeContextTrendSegment>();
  for (const fact of [...maintenance, ...operations].sort(
    (left, right) => left.createdAt - right.createdAt,
  )) {
    segments.set(fact.segmentId, {
      segmentId: fact.segmentId,
      generation: fact.generation,
      policyVersion: fact.policyVersion,
      model: null,
      createdAt: fact.createdAt,
    });
  }
  for (const main of [...observations]
    .filter((item) => item.purpose === "main")
    .sort(
      (left, right) => left.requestSeq - right.requestSeq || left.attemptIndex - right.attemptIndex,
    )) {
    segments.set(main.segmentId, {
      segmentId: main.segmentId,
      generation: main.generation,
      policyVersion: main.policyVersion,
      model: main.model,
      createdAt: Math.max(main.createdAt, segments.get(main.segmentId)?.createdAt ?? 0),
    });
  }
  return [...segments.values()].sort((left, right) => right.createdAt - left.createdAt);
}

export function nativeContextChartSegment(point: NativeContextChartPoint): string {
  const o = point.observation;
  // 原因：普通历史追加也会更新 historyVersion；它是查询围栏，不能令每次请求断线。
  return JSON.stringify([
    o.generation,
    o.segmentId,
    o.model.providerId,
    o.model.modelId,
    o.contextWindow,
    o.inputBudget,
    o.estimatorVersion,
    o.origin,
  ]);
}

/** 大范围只减少绘制点；保留首尾、极值、未知缺口、分段、事件与原始选中点。 */
export function buildNativeContextChartRows(
  points: readonly NativeContextChartPoint[],
  selectedId: string | null,
): NativeContextChartRow[] {
  const keys = [...new Set(points.flatMap((point) => Object.keys(point.values)))];
  const indices = new Set<number>();
  if (points.length <= 600) {
    for (let index = 0; index < points.length; index += 1) indices.add(index);
  } else {
    const buckets = Math.max(1, Math.floor(500 / (keys.length * 2 + 2)));
    const bucketSize = Math.ceil(points.length / buckets);
    for (let start = 0; start < points.length; start += bucketSize) {
      const end = Math.min(points.length, start + bucketSize);
      indices.add(start);
      indices.add(end - 1);
      for (const key of keys) {
        let min = -1;
        let max = -1;
        for (let index = start; index < end; index += 1) {
          const value = points[index]?.values[key];
          if (value == null) continue;
          if (min < 0 || value < (points[min]?.values[key] ?? Infinity)) min = index;
          if (max < 0 || value > (points[max]?.values[key] ?? -Infinity)) max = index;
        }
        if (min >= 0) indices.add(min);
        if (max >= 0) indices.add(max);
      }
    }
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      const previous = points[index - 1];
      if (!point) continue;
      if (point.observation.id === selectedId || point.observation.operationIds.length > 0)
        indices.add(index);
      if (
        previous &&
        (nativeContextChartSegment(previous) !== nativeContextChartSegment(point) ||
          keys.some((key) => (previous.values[key] == null) !== (point.values[key] == null)))
      ) {
        indices.add(index - 1);
        indices.add(index);
      }
    }
  }
  const rows: NativeContextChartRow[] = [];
  let previous: NativeContextChartPoint | null = null;
  let previousIndex = 0;
  for (const index of [...indices].sort((left, right) => left - right)) {
    const point = points[index];
    if (!point) continue;
    if (previous && nativeContextChartSegment(previous) !== nativeContextChartSegment(point)) {
      rows.push({
        index: (index + previousIndex) / 2,
        observation: null,
        values: {},
      });
    }
    rows.push({ index, observation: point.observation, values: point.values });
    previous = point;
    previousIndex = index;
  }
  return rows;
}
