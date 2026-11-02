import { useCallback, useEffect, useRef, useState } from "react";
import {
  sourceServerManagementSnapshotSchema,
  type SourceServerManagementSnapshot,
} from "@zcode/shared";
import type { ISourceServerManagementService } from "@zcode/services";

export function useSourceServerManagementSnapshot(
  management: ISourceServerManagementService | undefined,
  options: { enabled?: boolean; onError?: (error: unknown) => void } = {},
): {
  snapshot: SourceServerManagementSnapshot | null;
  ready: boolean;
  applySnapshot: (snapshot: SourceServerManagementSnapshot) => void;
  refresh: () => void;
} {
  const enabled = options.enabled ?? true;
  const sourceRef = useRef(management);
  sourceRef.current = management;
  const onErrorRef = useRef(options.onError);
  onErrorRef.current = options.onError;
  const [owned, setOwned] = useState<{
    management: typeof management;
    snapshot: SourceServerManagementSnapshot | null;
    ready: boolean;
  }>({ management, snapshot: null, ready: false });
  const refreshRef = useRef<() => void>(() => undefined);
  // 操作回包没有查询代际；只作为刷新提示，迟到回包不能直接覆盖当前 Host 的状态。
  const applySnapshot = useCallback(
    (_next: SourceServerManagementSnapshot) => refreshRef.current(),
    [],
  );
  const refresh = useCallback(() => refreshRef.current(), []);
  useEffect(() => {
    setOwned({ management, snapshot: null, ready: false });
    refreshRef.current = () => undefined;
    if (!management || !enabled) return;
    let disposed = false,
      pending = false,
      queued = false;
    let observedGeneration = -1;
    const active = () => !disposed && sourceRef.current === management;
    const read = (): void => {
      if (!active()) return;
      if (pending) {
        queued = true;
        return;
      }
      pending = true;
      void management
        .getSnapshot()
        .then((raw) => {
          if (!active()) return;
          const next = sourceServerManagementSnapshotSchema.parse(raw);
          if (next.directory.generation < observedGeneration) return;
          observedGeneration = next.directory.generation;
          setOwned({ management, snapshot: next, ready: true });
        })
        .catch((error) => {
          if (!active()) return;
          setOwned((previous) => ({
            management,
            snapshot: previous.management === management ? previous.snapshot : null,
            ready: false,
          }));
          onErrorRef.current?.(error);
        })
        .finally(() => {
          pending = false;
          if (active() && queued) {
            queued = false;
            read();
          }
        });
    };
    // 先订阅再读取；初始化期间的变更排在当前查询后，不丢同目录版本下的状态变化。
    const subscription = management.onDidChange(read);
    refreshRef.current = read;
    read();
    return () => {
      disposed = true;
      refreshRef.current = () => undefined;
      subscription.dispose();
    };
  }, [enabled, management]);
  return {
    snapshot: enabled && owned.management === management ? owned.snapshot : null,
    ready: enabled && owned.management === management && owned.ready,
    applySnapshot,
    refresh,
  };
}
