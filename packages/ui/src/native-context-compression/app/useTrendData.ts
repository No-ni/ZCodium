import { useCallback, useEffect, useRef, useState } from "react";
import type { NativeContextTrendSelection } from "@/store/nativeContextCompressionDraftStore.js";
import type {
  NativeContextObservation,
  NativeContextOperationSummary,
  NativeContextReadController,
} from "../contract.js";
import { nativeContextVersionKey } from "../domain/format.js";

export interface NativeContextTrendData {
  scopeKey: string;
  version: string;
  queryKey: string;
  observations: NativeContextObservation[];
  maintenance: NativeContextObservation[];
  operations: NativeContextOperationSummary[];
  currentSegmentId: string | null;
  nextCursor: number | null;
  maintenanceCursor: number | null;
  decisionCursor: number | null;
  recordsIncomplete: boolean;
  loading: boolean;
  loadingMaintenance: boolean;
  failed: boolean;
  maintenanceFailed: boolean;
  recordsFailed: boolean;
  capturedAt: number | null;
}

function emptyData(scopeKey: string, version: string): NativeContextTrendData {
  return {
    scopeKey,
    version,
    queryKey: "",
    observations: [],
    maintenance: [],
    operations: [],
    currentSegmentId: null,
    nextCursor: null,
    maintenanceCursor: null,
    decisionCursor: null,
    recordsIncomplete: false,
    loading: false,
    loadingMaintenance: false,
    failed: false,
    maintenanceFailed: false,
    recordsFailed: false,
    capturedAt: null,
  };
}

function mergeObservations(
  current: readonly NativeContextObservation[],
  incoming: readonly NativeContextObservation[],
): NativeContextObservation[] {
  return [...new Map([...current, ...incoming].map((item) => [item.id, item])).values()];
}

export function useNativeContextTrendData(
  read: NativeContextReadController,
  selection: NativeContextTrendSelection,
) {
  const { scopeKey, status } = read;
  const version = status ? nativeContextVersionKey(status) : "";
  const currentSegmentId = status?.currentSegmentId ?? null;
  const queryKey = JSON.stringify([
    version,
    currentSegmentId,
    selection.range,
    selection.segmentScope,
    selection.segmentId,
  ]);
  const [data, setData] = useState(() => emptyData(scopeKey, version));
  const [retry, setRetry] = useState(0);
  const requestRef = useRef(0);
  const maintenanceRef = useRef(0);
  const owned =
    data.scopeKey === scopeKey && (data.version === version || read.unavailable) ? data : null;
  const activeSegmentId =
    selection.segmentScope === "current"
      ? (owned?.currentSegmentId ?? currentSegmentId)
      : selection.segmentScope === "chosen"
        ? selection.segmentId
        : null;

  useEffect(() => {
    if (!version || !currentSegmentId || read.unavailable) return;
    const request = ++requestRef.current;
    maintenanceRef.current += 1;
    setData((current) => ({
      ...(current.scopeKey === scopeKey && current.version === version
        ? current
        : emptyData(scopeKey, version)),
      queryKey,
      currentSegmentId,
      loading: true,
      failed: false,
      maintenanceFailed: false,
      recordsFailed: false,
    }));
    void (async () => {
      const [catalog, records] = await Promise.allSettled([
        read.observations({ purpose: "main", limit: 200 }),
        read.records({ limit: 200 }),
      ]);
      if (request !== requestRef.current) return;
      if (catalog.status === "rejected") {
        // 主请求读取失败不应遮住同一批已成功取得的维护事件。
        setData((current) => ({
          ...current,
          loading: false,
          failed: true,
          operations: records.status === "fulfilled" ? records.value.items : current.operations,
          recordsIncomplete:
            records.status === "fulfilled"
              ? records.value.nextCursor !== null
              : current.recordsIncomplete,
          recordsFailed: records.status === "rejected",
          capturedAt: records.status === "fulfilled" ? Date.now() : current.capturedAt,
        }));
        return;
      }
      // 原因：compact 可以先于下一主请求提交，主请求短尾不能决定维护查询的当前段。
      const segmentId =
        selection.segmentScope === "current"
          ? currentSegmentId
          : selection.segmentScope === "chosen"
            ? selection.segmentId
            : null;
      const segment = segmentId ? { segmentId } : {};
      const [main, maintenance, decision] = await Promise.allSettled([
        read.observations({
          purpose: "main",
          limit: selection.range === "50" ? 50 : 200,
          ...segment,
        }),
        read.observations({ purpose: "maintenance", limit: 200, ...segment }),
        read.observations({ purpose: "decision", limit: 200, ...segment }),
      ]);
      if (request !== requestRef.current) return;
      setData((current) => ({
        ...current,
        currentSegmentId,
        observations: mergeObservations(current.observations, [
          ...catalog.value.items,
          ...(main.status === "fulfilled" ? main.value.items : []),
        ]),
        maintenance: mergeObservations(current.maintenance, [
          ...(maintenance.status === "fulfilled" ? maintenance.value.items : []),
          ...(decision.status === "fulfilled" ? decision.value.items : []),
        ]),
        operations: records.status === "fulfilled" ? records.value.items : current.operations,
        recordsIncomplete:
          records.status === "fulfilled"
            ? records.value.nextCursor !== null
            : current.recordsIncomplete,
        nextCursor: main.status === "fulfilled" ? main.value.nextCursor : null,
        maintenanceCursor: maintenance.status === "fulfilled" ? maintenance.value.nextCursor : null,
        decisionCursor: decision.status === "fulfilled" ? decision.value.nextCursor : null,
        loading: false,
        failed: main.status === "rejected",
        maintenanceFailed: maintenance.status === "rejected" || decision.status === "rejected",
        recordsFailed: records.status === "rejected",
        capturedAt: Date.now(),
      }));
    })().catch(() => {
      if (request === requestRef.current)
        setData((current) => ({ ...current, loading: false, failed: true }));
    });
    return () => {
      requestRef.current += 1;
      maintenanceRef.current += 1;
    };
  }, [
    scopeKey,
    version,
    currentSegmentId,
    queryKey,
    read.observations,
    read.records,
    read.unavailable,
    retry,
  ]);

  const loadMore = async () => {
    if (
      !owned ||
      owned.queryKey !== queryKey ||
      owned.nextCursor === null ||
      owned.loading ||
      read.unavailable
    )
      return;
    const request = ++requestRef.current;
    setData((current) => ({ ...current, loading: true, failed: false }));
    try {
      const page = await read.observations({
        cursor: owned.nextCursor,
        limit: 200,
        purpose: "main",
        ...(activeSegmentId ? { segmentId: activeSegmentId } : {}),
      });
      if (request !== requestRef.current) return;
      setData((current) => ({
        ...current,
        observations: mergeObservations(current.observations, page.items),
        nextCursor: page.nextCursor,
        loading: false,
        capturedAt: Date.now(),
      }));
    } catch {
      if (request === requestRef.current)
        setData((current) => ({ ...current, loading: false, failed: true }));
    }
  };

  const loadMaintenance = async () => {
    if (
      !owned ||
      owned.queryKey !== queryKey ||
      owned.loading ||
      owned.loadingMaintenance ||
      read.unavailable
    )
      return;
    const request = ++maintenanceRef.current;
    setData((current) => ({
      ...current,
      loadingMaintenance: true,
      maintenanceFailed: false,
    }));
    const segment = activeSegmentId ? { segmentId: activeSegmentId } : {};
    const [maintenance, decision] = await Promise.allSettled([
      owned.maintenanceCursor === null
        ? Promise.resolve(null)
        : read.observations({
            cursor: owned.maintenanceCursor,
            purpose: "maintenance",
            limit: 200,
            ...segment,
          }),
      owned.decisionCursor === null
        ? Promise.resolve(null)
        : read.observations({
            cursor: owned.decisionCursor,
            purpose: "decision",
            limit: 200,
            ...segment,
          }),
    ]);
    if (request !== maintenanceRef.current) return;
    setData((current) => ({
      ...current,
      maintenance: mergeObservations(current.maintenance, [
        ...(maintenance.status === "fulfilled" ? (maintenance.value?.items ?? []) : []),
        ...(decision.status === "fulfilled" ? (decision.value?.items ?? []) : []),
      ]),
      maintenanceCursor:
        maintenance.status === "fulfilled"
          ? (maintenance.value?.nextCursor ?? null)
          : current.maintenanceCursor,
      decisionCursor:
        decision.status === "fulfilled"
          ? (decision.value?.nextCursor ?? null)
          : current.decisionCursor,
      loadingMaintenance: false,
      maintenanceFailed: maintenance.status === "rejected" || decision.status === "rejected",
      capturedAt: Date.now(),
    }));
  };

  const refresh = useCallback(() => setRetry((value) => value + 1), []);
  return {
    data: owned,
    activeSegmentId,
    queryKey,
    loadMore,
    loadMaintenance,
    refresh,
  };
}
