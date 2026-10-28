import { useMemo } from "react";
import type { WindowUnreadSnapshot } from "@zcode/shared";
import { getAllUnreadTaskKeys } from "@/lib/unreadTaskCount.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

export function useWindowUnreadSnapshot(): WindowUnreadSnapshot {
  const serialized = useZCodeSessionStore((state) =>
    JSON.stringify(getAllUnreadTaskKeys(state.workspaces)),
  );
  return useMemo(() => {
    const taskKeys = JSON.parse(serialized) as string[];
    return { schemaVersion: 1, count: taskKeys.length, taskKeys };
  }, [serialized]);
}
