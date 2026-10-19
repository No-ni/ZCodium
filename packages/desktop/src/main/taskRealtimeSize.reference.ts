// 仅供测试：保留优化前的分片与重放核算，独立验证精确边界。
import type { TaskStreamMirrorBatchEvent, TaskStreamMirrorOp } from "@zcode/shared";

export function originalReplay(events: TaskStreamMirrorBatchEvent[]) {
  const replay: TaskStreamMirrorBatchEvent[] = [];
  for (const event of events) {
    replay.push(event);
    while (replay.length > 60) replay.shift();
    while (replay.reduce((size, item) => size + JSON.stringify(item).length, 0) > 512 * 1024)
      replay.shift();
  }
  return replay;
}

export function originalSplit(event: TaskStreamMirrorBatchEvent, nextBatchSeq: number) {
  const chunks: TaskStreamMirrorBatchEvent[] = [];
  let pendingOps: TaskStreamMirrorOp[] = [];
  const createChunk = (
    ops: TaskStreamMirrorOp[],
    batchSeq: number,
  ): TaskStreamMirrorBatchEvent => ({
    ...event,
    eventId: `stream-${event.workspaceKey}-${event.taskId}-${event.runId}-${batchSeq}`,
    batchSeq,
    fromSeq: ops[0]?.seq ?? event.fromSeq,
    toSeq: ops.at(-1)?.seq ?? event.toSeq,
    ops,
    terminal: ops.some(
      (op) => op.kind === "stream_event" && ["task_complete", "task_error"].includes(op.event.type),
    ),
  });
  const flush = () => {
    if (!pendingOps.length) return;
    chunks.push(createChunk(pendingOps, nextBatchSeq++));
    pendingOps = [];
  };
  for (const op of event.ops) {
    const candidate = [...pendingOps, op];
    const chunk = createChunk(candidate, nextBatchSeq);
    if (pendingOps.length && JSON.stringify(chunk).length > 512 * 1024) flush();
    pendingOps.push(op);
  }
  flush();
  return { chunks, nextBatchSeq };
}
