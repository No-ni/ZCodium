// local-ttft 渲染记录的有界出口写入（spec：docs/monitoring/ttft-stage-telemetry.md）。
// 从 LocalTtftObserver.logRecord 拆出：logged 去重集与 pending 仍由 Observer 拥有，这里只按传入的
// 同一份集合写日志；去重键、有界淘汰与写入条件逐字不变。
import type { LocalTtftPending as Pending } from "@/v4/diagnostics/local-ttft/localTtftRecord.js";
import { logger } from "@/logger.js";
import { LOCAL_TTFT_MAX_PENDING, type LocalTtftRecord } from "@zcode/shared";

export function logLocalTtftRecord(
  record: LocalTtftRecord,
  logged: Map<string, Set<string>>,
  pendingMap: Map<string, Pending>,
): void {
  let seen = logged.get(record.observationId);
  if (!seen) {
    if (logged.size >= LOCAL_TTFT_MAX_PENDING) logged.delete(logged.keys().next().value!);
    logged.set(record.observationId, (seen = new Set()));
  }
  const base = {
    observationId: record.observationId,
    commandId: record.commandId,
    sessionId: record.sessionId,
    turnId: record.turnId,
    productTurnId: record.productTurnId,
    queryId: record.queryId,
    requestId: record.requestId,
    cliInstanceId: record.cliInstanceId,
    localOnly: record.localOnly === true,
    source: "renderer",
  };
  const write = (key: string, fields: Record<string, unknown>) => {
    if (seen.has(key)) return;
    seen.add(key);
    logger.lifecycle.info("[ttft]", { ...base, ...fields });
  };
  if (record.kind !== "checkpoint")
    write(record.kind, {
      event: `ttft.${record.kind}`,
      at: record.end,
      durationMs: record.end - record.start,
      outcome: record.outcome,
      quality: record.quality,
      sendMode: record.sendMode,
      firstOutputKind: record.firstOutputKind,
      visibility: record.visibility,
      userWaitMs: record.userWaitMs,
      clockErrorMs: record.clockErrorMs,
      timingReliable: record.timingReliable,
      stages: Object.fromEntries(
        record.intervals.map((interval) => [interval.stage, interval.end - interval.start]),
      ),
      truncated: record.truncated,
    });
  const pending = pendingMap.get(record.observationId);
  if (pending?.dispatch !== undefined)
    write("dispatch", {
      event: "ttft.dispatch",
      at: pending.dispatch,
      durationMs: pending.dispatch - pending.start,
      commandId: pending.commandId,
      sessionId: pending.sessionId,
    });
  const facts = pending?.facts;
  for (const key of ["receivedAt", "admittedAt", "executionAt", "requestAt", "outputAt"] as const)
    if (facts?.[key] !== undefined)
      // 确认重发复用 observationId，但会换 commandId；不能吞掉新命令的接收/执行边界。
      write(`${record.commandId}:${key}`, {
        event: `ttft.cli.${key}`,
        at: facts[key],
        source: "cli",
        // CLI 时钟只用 CLI 自身收到命令的时间相减；跨进程耗时来自已校准的 intervals。
        durationMs: facts[key]! - facts.receivedAt,
      });
  for (const detail of record.details ?? []) {
    const detailKey = `${detail.source === "cli" ? record.commandId : "renderer"}:${detail.id}`;
    write(`${detailKey}:start`, {
      event: "ttft.phase",
      phase: detail.stage,
      phaseId: detail.id,
      source: detail.source,
      at: detail.start,
      status: "started",
      role: detail.role,
    });
    if (detail.end !== undefined)
      write(`${detailKey}:end`, {
        event: "ttft.phase",
        phase: detail.stage,
        phaseId: detail.id,
        source: detail.source,
        at: detail.end,
        status: detail.outcome ?? "completed",
        durationMs: detail.end - detail.start,
        role: detail.role,
      });
  }
}
