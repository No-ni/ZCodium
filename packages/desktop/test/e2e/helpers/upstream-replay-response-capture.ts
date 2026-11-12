import type {
  E2ENetworkCaptureRecord,
  E2ENetworkCaptureResponseEvent,
} from "./network-capture-proxy.js";
import {
  redactE2ENetworkCaptureJsonText,
  sanitizeE2ENetworkCaptureHeaders,
} from "./e2e-network-capture-redaction.js";

/** 捕获沿请求的同一 owner 累积；仅成功 write callback 才能证明某帧已发送。 */
export function createReplayResponseCapture(
  record: E2ENetworkCaptureRecord,
  head: { statusCode: number; statusMessage: string; headers: Record<string, string> },
) {
  const accepted: Buffer[] = [];
  record.statusCode = head.statusCode;
  record.statusMessage = head.statusMessage;
  record.responseHeaders = sanitizeE2ENetworkCaptureHeaders(head.headers);
  const append = (body: string | Buffer) => {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf-8");
    accepted.push(bytes);
    record.responseBodyBytes += bytes.length;
    return bytes;
  };
  return {
    body: append,
    chunk(body: Buffer, offsetMs: number) {
      const bytes = append(body);
      (record.responseChunkTimeline ??= []).push({
        base64: bytes.toString("base64"),
        byteLength: bytes.length,
        offsetMs,
      });
    },
    event(event: E2ENetworkCaptureResponseEvent) {
      const bytes = append(event.text);
      const events = (record.responseEvents ??= []);
      events.push({ ...event, byteLength: bytes.length, sequence: events.length });
    },
    finish(status: "complete" | "error", error?: string) {
      record.responseTextPreview = redactE2ENetworkCaptureJsonText(
        Buffer.concat(accepted).toString("utf-8"),
      );
      finishReplayCapture(record, status, error);
    },
  };
}

/** gate/响应写入异常曾跳过末尾事实；失败也必须结算，不能把已建立的 200 清成未知。 */
export function failPendingReplayCapture(record: E2ENetworkCaptureRecord): void {
  if (record.status === "pending")
    finishReplayCapture(record, "error", "Replay response stream interrupted");
}

function finishReplayCapture(
  record: E2ENetworkCaptureRecord,
  status: "complete" | "error",
  error?: string,
): void {
  record.status = status;
  record.completedAt = new Date().toISOString();
  record.durationMs = Math.max(0, Date.parse(record.completedAt) - Date.parse(record.startedAt));
  if (error) record.error = error;
}
