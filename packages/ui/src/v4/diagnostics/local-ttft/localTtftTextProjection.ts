// local-ttft 首正文投影与本地文本日志（spec：docs/monitoring/ttft-stage-telemetry.md）。
// 从 LocalTtftObserver 拆出：pending Map 与 textProjected/textCommitted 等标记仍由 Observer 拥有，
// 这里只按传入的同一份 Map、logLocally 与回调工作；判定顺序、写入条件与异常边界逐字不变。
import type { LocalTtftPending as Pending } from "@/v4/diagnostics/local-ttft/localTtftRecord.js";
import { logger } from "@/logger.js";
import type { ConversationTopicFrame } from "@zcode/shared/zcode-protocol-v4";

export function projectText(
  frame: ConversationTopicFrame,
  pendingMap: Map<string, Pending>,
  logLocally: boolean,
  logText: (pending: Pending, phase: string, visible?: boolean) => void,
): void {
  if (!logLocally) return;
  for (const facts of [frame.ttft, ...(frame.ttftRelated ?? [])]) {
    if (!facts) continue;
    const pending = pendingMap.get(facts.observationId);
    if (
      !pending ||
      pending.renderExcluded ||
      pending.textReceivedAt === undefined ||
      pending.textProjected ||
      pending.commandId !== facts.commandId ||
      frame.topic !== `conversation/${pending.facts?.sessionId}`
    )
      continue;
    pending.textProjected = true;
    logText(pending, "projected");
  }
}

export function renderTextPending(
  pendingMap: Map<string, Pending>,
  logLocally: boolean,
  workspace: string,
  sessionId: string,
  turnId: string,
  rowId: number,
): Pending | undefined {
  if (!logLocally) return;
  return [...pendingMap.values()].find(
    (pending) =>
      !pending.renderExcluded &&
      pending.workspace === workspace &&
      pending.facts?.sessionId === sessionId &&
      pending.facts.productTurnId === turnId &&
      pending.textRowId === rowId &&
      pending.textReceivedAt !== undefined,
  );
}

export function logTtftText(
  pending: Pending,
  phase: string,
  visible: boolean | undefined,
  readNow: () => number,
  readForeground: (() => boolean) | undefined,
  isForeground: boolean,
): void {
  const now = readNow();
  try {
    logger.lifecycle.info("[ttft]", {
      event: `ttft.text.${phase}`,
      observationId: pending.context.observationId,
      commandId: pending.commandId,
      sessionId: pending.facts?.sessionId,
      turnId: pending.facts?.turnId,
      productTurnId: pending.facts?.productTurnId,
      rowId: pending.textRowId,
      source: "renderer",
      at: now,
      durationMs: now - pending.start,
      sinceReceivedMs: now - pending.textReceivedAt!,
      visible,
      foreground: readForeground?.() ?? isForeground,
    });
  } catch {
    /* 本地诊断失败不能中断投影或 React 提交。 */
  }
}
