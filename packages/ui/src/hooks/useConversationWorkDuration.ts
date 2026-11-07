import { useEffect, useState } from "react";
import type { ConversationTurnWorkStatus } from "@/v4/conversationTurnWorkSegments.js";

export function useConversationWorkDuration(
  status: ConversationTurnWorkStatus | undefined,
  refreshIntervalMs = 1000,
): number | undefined {
  const startedAt = status?.state === "running" ? status.liveStartedAt : undefined;
  const [, refresh] = useState(0);
  useEffect(() => {
    if (startedAt === undefined) return;
    const tick = () => refresh((revision) => revision + 1);
    const onVisibilityChange = () => {
      if (!document.hidden) tick();
    };
    const timer = setInterval(tick, refreshIntervalMs);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [startedAt, refreshIntervalMs]);
  // 秒级时钟只订阅文案叶子，避免整条 Timeline 为显示耗时重新分组全部历史。
  // Bugfix：props 切换时旧 now 会短暂串用另一会话；直接读当前时钟，挂载和唤醒均沿用 CLI 起点。
  return startedAt === undefined ? status?.durationMs : Math.max(0, Date.now() - startedAt);
}
