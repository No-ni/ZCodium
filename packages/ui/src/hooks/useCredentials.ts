/**
 * useCredentials —— 凭据服务 hooks
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

export function useCredentialStoreRecovery(enabled: boolean) {
  const { credentialService } = useServices();
  const [state, setState] = useState<
    | null
    | { status: "corrupt"; fingerprint: string }
    | { status: "recovered"; backupPath: string }
    | { status: "changed" }
  >(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const running = useRef(false);
  useEffect(() => {
    const current = ++generation.current;
    if (!enabled) {
      setState(null);
      return;
    }
    void credentialService
      .inspectStore()
      .then((result) => {
        if (generation.current === current && result?.status === "corrupt") setState(result);
      })
      .catch(() => {
        // 权限、网络和旧 Host 不支持此能力均不是容器损坏，不能提供清空入口。
        if (generation.current === current) logger.warn("[credential-recovery] inspect failed");
      });
    return () => {
      generation.current += 1;
    };
  }, [credentialService, enabled]);
  const recover = useCallback(async () => {
    if (!enabled || state?.status !== "corrupt" || running.current) return;
    const current = generation.current;
    running.current = true;
    setBusy(true);
    setFailed(false);
    try {
      const result = await credentialService.recoverStore(state.fingerprint);
      if (generation.current === current) setState(result);
    } catch {
      if (generation.current === current) {
        logger.error("[credential-recovery] recovery failed");
        setFailed(true);
      }
    } finally {
      running.current = false;
      if (generation.current === current) setBusy(false);
    }
  }, [credentialService, enabled, state]);
  return { state, busy, failed, recover };
}

/** 凭据管理的基础 hook */
export function useCredentials() {
  const { credentialService } = useServices();

  const load = useCallback((key: string) => credentialService.load(key), [credentialService]);
  const save = useCallback(
    (key: string, value: string) => credentialService.save(key, value),
    [credentialService],
  );
  const del = useCallback((key: string) => credentialService.delete(key), [credentialService]);

  return { load, save, delete: del };
}
