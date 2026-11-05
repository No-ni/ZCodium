import { type StdioTrafficFrame, type StdioTrafficKind } from "@/data/protocolDocs.js";
import {
  type StdioTrafficTapRecord,
  type StdioTrafficApiRecordEnvelope,
  type RealTrafficState,
} from "../contract.js";

export function trafficTimestampToMs(timestamp: string) {
  const [timePart = "00:00:00", millisecondPart = "0"] = timestamp.split(".");
  const [hours = 0, minutes = 0, seconds = 0] = timePart
    .split(":")
    .map((part) => Number.parseInt(part, 10));
  const milliseconds = Number.parseInt(millisecondPart.padEnd(3, "0").slice(0, 3), 10) || 0;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
}

export function sortTrafficFramesByNewest(frames: StdioTrafficFrame[]) {
  return [...frames].sort(
    (first, second) =>
      trafficTimestampToMs(second.timestamp) - trafficTimestampToMs(first.timestamp),
  );
}

export function formatTrafficTimestamp(date: Date) {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
  return `${hours}:${minutes}:${seconds}.${milliseconds}`;
}

export function formatIsoTrafficTimestamp(value: string | undefined) {
  if (!value) {
    return "--:--:--.---";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return formatTrafficTimestamp(date);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

export function readMessageId(value: unknown) {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return undefined;
}

export function getMessagePayload(message: unknown) {
  if (!isRecord(message) || !isRecord(message.params)) {
    return undefined;
  }
  return isRecord(message.params.payload) ? message.params.payload : undefined;
}

export function getTrafficRecordKind(record: StdioTrafficTapRecord): StdioTrafficKind {
  if (record.direction === "agent-stderr") {
    return "stderr";
  }

  if (record.method) {
    return typeof record.id === "undefined" ? "notification" : "request";
  }

  if (typeof record.id !== "undefined") {
    return "response";
  }

  return "notification";
}

export function getTrafficRecordSummary(record: StdioTrafficTapRecord, kind: StdioTrafficKind) {
  if (kind === "stderr") {
    return (record.raw ?? "stderr").slice(0, 160);
  }

  if (record.parseError) {
    return `parse error: ${record.parseError}`;
  }

  const payload = getMessagePayload(record.message);
  const payloadType = readString(payload?.type);
  if (payloadType) {
    return payloadType;
  }

  if (kind === "response") {
    if (isRecord(record.message) && isRecord(record.message.error)) {
      return readString(record.message.error.message) ?? "response error";
    }
    return "response result";
  }

  return readString(record.method) ?? (record.raw ?? "traffic record").slice(0, 160);
}

export function formatRawLine(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return raw;
  }

  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return raw;
  }
}

export function mapTapRecordToFrame(
  envelope: StdioTrafficApiRecordEnvelope,
  workspaceHash: string | undefined,
): StdioTrafficFrame | null {
  const record = envelope.record;
  if (!record.direction) {
    return null;
  }

  const kind = getTrafficRecordKind(record);
  return {
    id: `real-${workspaceHash ?? "workspace"}-${envelope.index}-${record.ts ?? ""}`,
    timestamp: formatIsoTrafficTimestamp(record.ts),
    direction: record.direction,
    kind,
    method: readString(record.method),
    messageId: readMessageId(record.id),
    sessionId: readString(record.sessionId),
    inputId: readString(record.inputId),
    summary: getTrafficRecordSummary(record, kind),
    bytes: typeof record.bytes === "number" ? record.bytes : (record.raw ?? "").length,
    raw: record.raw ?? JSON.stringify(record.message ?? record),
  };
}

export function linkTrafficFrames(frames: StdioTrafficFrame[]) {
  const requestByMessageId = new Map<string, StdioTrafficFrame>();
  const responseByMessageId = new Map<string, StdioTrafficFrame>();

  for (const frame of frames) {
    if (!frame.messageId) {
      continue;
    }
    if (frame.kind === "request") {
      requestByMessageId.set(frame.messageId, frame);
    } else if (frame.kind === "response") {
      responseByMessageId.set(frame.messageId, frame);
    }
  }

  return frames.map((frame) => {
    if (!frame.messageId) {
      return frame;
    }
    const linkedFrame =
      frame.kind === "request"
        ? responseByMessageId.get(frame.messageId)
        : frame.kind === "response"
          ? requestByMessageId.get(frame.messageId)
          : undefined;
    return linkedFrame ? { ...frame, linkedId: linkedFrame.id } : frame;
  });
}

export function mapRealTrafficFrames(realTraffic: RealTrafficState) {
  return linkTrafficFrames(
    realTraffic.records
      .map((envelope) => mapTapRecordToFrame(envelope, realTraffic.workspaceHash))
      .filter((frame): frame is StdioTrafficFrame => frame !== null),
  );
}
