import type { SourceServerOperationLog } from "@zcode/shared";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";

const PHASES = [
  ["channel", "remote.phase.channel"],
  ["identify", "remote.phase.identify"],
  ["handshake", "remote.phase.handshake"],
  ["workspace", "remote.phase.workspace"],
] as const;
export type RemoteConnectionPhaseStatus = "pending" | "active" | "complete" | "failed";
function phaseKey(raw: string) {
  if (raw === "probe") return "channel";
  if (raw === "directory-record") return "identify";
  if (["daemon", "protocol-handshake", "restart", "publish-online"].includes(raw))
    return "handshake";
  return PHASES.some(([key]) => key === raw) ? raw : null;
}
function phaseList(includeWorkspace: boolean) {
  return PHASES.filter(([key]) => includeWorkspace || key !== "workspace");
}

/** 只投影现有预部署连接日志；部署阶段不在本仓向导的产品流程中。 */
export function resolveRemoteConnectionPhases(
  logs: ReadonlyArray<Pick<RemoteConnectionLogEntry, "message" | "level">>,
  options: { connectionReady?: boolean; includeWorkspace?: boolean } = {},
) {
  const phases = phaseList(options.includeWorkspace === true);
  let active = -1,
    failed = -1;
  for (const log of logs) {
    const match = /^\[source-server:([^\]]+)\]/u.exec(log.message);
    if (!match) continue;
    const key = phaseKey(match[1]!);
    const index = phases.findIndex(
      ([candidate]) =>
        candidate === (key === "workspace" && !options.includeWorkspace ? "handshake" : key),
    );
    if (index < 0) continue;
    active = Math.max(active, index);
    if (log.level === "error") failed = index;
  }
  // 握手日志不是可靠终态；有目录交接时仅 session ready 能结束全部阶段。
  const ready =
    failed < 0 &&
    (options.connectionReady === true ||
      (!options.includeWorkspace &&
        logs.some((log) => log.message.startsWith("[source-server:publish-online]"))));
  return phases.map(([key, titleId], index) => ({
    key,
    titleId,
    status: (failed === index
      ? "failed"
      : ready || index < active
        ? "complete"
        : index === active
          ? "active"
          : "pending") as RemoteConnectionPhaseStatus,
  }));
}

export interface RemoteOperationProgress {
  index: number;
  total: number;
  titleId: string;
  percent?: number;
  startedAt?: number;
}
export function resolveRemoteOperationProgress(
  allLogs: ReadonlyArray<
    Pick<SourceServerOperationLog, "phase" | "progress" | "timestamp" | "level">
  >,
): RemoteOperationProgress {
  const tail = allLogs.at(-1);
  // Host 保留最近一次日志；已结束操作不能被展示为仍在持续连接。
  const logs = tail && (tail.phase === "ready" || tail.level === "error") ? [] : allLogs;
  const phases = phaseList(false);
  let index = 0;
  for (const log of logs)
    index = Math.max(
      index,
      phases.findIndex(([key]) => key === phaseKey(log.phase)),
    );
  return {
    index,
    total: phases.length,
    titleId: phases[index]![1],
    ...(logs[0] ? { startedAt: logs[0].timestamp } : {}),
  };
}
