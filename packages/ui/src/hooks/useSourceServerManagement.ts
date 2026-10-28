import { useCallback, useEffect, useRef, useState } from "react";
import {
  sourceServerManagementSnapshotSchema,
  type SourceServerManagementSnapshot,
} from "@zcode/shared";
import type { ISourceServerManagementService } from "@zcode/services";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

type ManagementState =
  | { status: "unavailable" }
  | { status: "loading" }
  | { status: "ready"; snapshot: SourceServerManagementSnapshot }
  | { status: "error" };

export function useSourceServerManagement() {
  const service = useOptionalBaseWorkspaceServices()?.sourceServerManagementService;
  const [owned, setOwned] = useState<{
    service: ISourceServerManagementService | undefined;
    state: ManagementState;
  }>({ service, state: service ? { status: "loading" } : { status: "unavailable" } });
  const generation = useRef(0);
  const requestSequence = useRef(0);
  const serviceRef = useRef(service);
  serviceRef.current = service;
  const refresh = useCallback(async () => {
    if (!service) return;
    const current = generation.current;
    const request = ++requestSequence.current;
    try {
      const capability = await service.getCapabilities();
      if (capability.version !== 1) throw new Error("Unsupported Source management capability");
      const snapshot = sourceServerManagementSnapshotSchema.parse(await service.getSnapshot());
      // 旧刷新成功或失败都不能覆盖较新的快照；同时校验 Host 与请求代际。
      if (
        current === generation.current &&
        serviceRef.current === service &&
        request === requestSequence.current
      )
        setOwned({ service, state: { status: "ready", snapshot } });
    } catch {
      if (
        current === generation.current &&
        serviceRef.current === service &&
        request === requestSequence.current
      )
        setOwned({ service, state: { status: "error" } });
    }
  }, [service]);
  useEffect(() => {
    generation.current += 1;
    setOwned({ service, state: service ? { status: "loading" } : { status: "unavailable" } });
    if (!service) return;
    let subscription: { dispose(): void } | undefined;
    let active = true;
    void service
      .getCapabilities()
      .then((capability) => {
        if (!active) return;
        if (capability.version !== 1) {
          setOwned({ service, state: { status: "error" } });
          return;
        }
        subscription = service.onDidChange(() => {
          void refresh();
        });
        void refresh();
      })
      .catch(() => {
        if (active) setOwned({ service, state: { status: "error" } });
      });
    return () => {
      active = false;
      generation.current += 1;
      subscription?.dispose();
    };
  }, [refresh, service]);
  const state: ManagementState =
    owned.service === service
      ? owned.state
      : service
        ? { status: "loading" }
        : { status: "unavailable" };
  return { service: state.status === "ready" ? service : undefined, state, refresh };
}
