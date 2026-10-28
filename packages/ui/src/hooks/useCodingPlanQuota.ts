import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CodingPlanQuotaContext,
  CodingPlanQuotaSnapshot,
  IUsageStatsService,
} from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

interface QuotaState {
  readonly service: IUsageStatsService;
  readonly context: CodingPlanQuotaContext | null;
  readonly snapshot: CodingPlanQuotaSnapshot | null;
  readonly loading: boolean;
  readonly error: boolean;
}

/** 额度仅属于当前挂载页面，凭据与连接选择留在目标 Host。 */
export function useCodingPlanQuota() {
  const { usageStatsService: service } = useServices();
  const [state, setState] = useState<QuotaState>({
    service,
    context: null,
    snapshot: null,
    loading: true,
    error: false,
  });
  const stateRef = useRef(state);
  const serviceRef = useRef(service);
  serviceRef.current = service;
  const refreshRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    let alive = true;
    let requestVersion = 0;
    let contextEventVersion = 0;
    const commit = (next: QuotaState): void => {
      stateRef.current = next;
      setState(next);
    };
    commit({ service, context: null, snapshot: null, loading: true, error: false });
    const isCurrent = (): boolean => alive && serviceRef.current === service;
    const request = async (): Promise<void> => {
      if (!isCurrent()) return;
      const context = stateRef.current.context;
      if (context?.status !== "available") return;
      const version = ++requestVersion;
      const contextId = context.contextId;
      commit({ ...stateRef.current, loading: true, error: false });
      const canCommit = (): boolean =>
        isCurrent() &&
        version === requestVersion &&
        stateRef.current.context?.status === "available" &&
        stateRef.current.context.contextId === contextId;
      try {
        const snapshot = await service.getCodingPlanQuota({ contextId });
        if (!canCommit()) return;
        commit({ ...stateRef.current, snapshot, loading: false, error: false });
      } catch {
        if (!canCommit()) return;
        // 异常可能包含厂商回显的 Key；只记录固定事件，保留同一上下文的成功快照。
        logger.warn("[useCodingPlanQuota] 读取个人 Coding Plan 额度失败");
        commit({ ...stateRef.current, loading: false, error: true });
      }
    };
    const applyContext = (context: CodingPlanQuotaContext): void => {
      if (!isCurrent()) return;
      const previous = stateRef.current.context;
      const same =
        previous?.status === "available" &&
        context.status === "available" &&
        previous.contextId === context.contextId;
      if (same) {
        commit({ ...stateRef.current, context });
        return;
      }
      // 先清空再请求；仅靠响应序号不能阻止换 Key 时旧快照被当作新连接事实展示。
      requestVersion += 1;
      commit({ service, context, snapshot: null, loading: false, error: false });
      if (context.status === "available") void request();
    };
    let subscription: { dispose(): void } | undefined;
    const readContext = async (): Promise<void> => {
      const eventVersion = contextEventVersion;
      try {
        const context = await service.getCodingPlanQuotaContext();
        if (!isCurrent() || eventVersion !== contextEventVersion) return;
        applyContext(context);
      } catch {
        if (!isCurrent() || eventVersion !== contextEventVersion) return;
        commit({ service, context: null, snapshot: null, loading: false, error: true });
      }
    };
    refreshRef.current = async () => {
      if (!isCurrent()) return;
      if (stateRef.current.context?.status === "available") await request();
      else await readContext();
    };
    try {
      subscription = service.onDidChangeCodingPlanQuotaContext((context) => {
        contextEventVersion += 1;
        applyContext(context);
      });
      void readContext();
    } catch {
      commit({ service, context: null, snapshot: null, loading: false, error: true });
    }
    return () => {
      // 页面退出与 Host 换代都是取消边界，旧成功/失败都不能继续提交。
      alive = false;
      requestVersion += 1;
      refreshRef.current = null;
      subscription?.dispose();
    };
  }, [service]);

  const refresh = useCallback(async () => {
    await refreshRef.current?.();
  }, []);
  // ServiceProvider 刚切换、effect 尚未执行的首帧也不能露出旧 Host 的额度。
  const visible =
    state.service === service
      ? state
      : { context: null, snapshot: null, loading: true, error: false };
  return {
    context: visible.context,
    snapshot: visible.snapshot,
    loading: visible.loading,
    error: visible.error,
    refresh,
  };
}
