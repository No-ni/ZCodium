import { useEffect, useState } from "react";
import type { ConversationTurnWorkStatus } from "@/v4/conversationTurnWorkSegments.js";

export function useConversationWorkDuration(
  status: ConversationTurnWorkStatus | undefined,
): number | undefined {
  const startedAt = status?.state === "running" ? status.liveStartedAt : undefined;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (startedAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  // 秒级时钟只订阅文案叶子，避免整条 Timeline 为显示耗时重新分组全部历史。
  return startedAt === undefined ? status?.durationMs : Math.max(0, now - startedAt);
}
