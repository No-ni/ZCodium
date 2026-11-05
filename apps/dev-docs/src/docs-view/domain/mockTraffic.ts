import { type StdioTrafficFrame } from "@/data/protocolDocs.js";

export function createLiveStdioTrafficFrame(
  sequence: number,
  timestamp: string,
): StdioTrafficFrame {
  const inputId = `inp_live_${String(sequence % 100).padStart(2, "0")}`;
  const messageId = String(20 + sequence);
  const eventSeq = 20 + sequence;

  if (sequence % 7 === 4) {
    return {
      id: `live-stderr-${sequence}`,
      timestamp,
      direction: "agent-stderr",
      kind: "stderr",
      sessionId: "sess_6b6a",
      summary: "provider heartbeat",
      bytes: 96,
      raw: `[zcode-agent] provider heartbeat seq=${eventSeq} status=streaming`,
    };
  }

  if (sequence % 5 === 1) {
    return {
      id: `live-send-${sequence}`,
      timestamp,
      direction: "app-to-agent",
      kind: "request",
      method: "session/send",
      messageId,
      sessionId: "sess_6b6a",
      inputId,
      summary: "new user input",
      bytes: 586,
      raw: `{
  "id": ${messageId},
  "method": "session/send",
  "params": {
    "sessionId": "sess_6b6a",
    "inputId": "${inputId}",
    "content": "debug live stdio frame ${sequence}"
  }
}`,
    };
  }

  if (sequence % 5 === 2) {
    return {
      id: `live-ack-${sequence}`,
      timestamp,
      direction: "agent-to-app",
      kind: "response",
      messageId,
      sessionId: "sess_6b6a",
      inputId,
      summary: "session/send accepted",
      bytes: 104,
      latencyMs: 8,
      raw: `{
  "id": ${messageId},
  "result": {
    "accepted": true,
    "inputId": "${inputId}"
  }
}`,
    };
  }

  return {
    id: `live-event-${sequence}`,
    timestamp,
    direction: "agent-to-app",
    kind: "notification",
    method: "session/event",
    sessionId: "sess_6b6a",
    inputId,
    summary: sequence % 3 === 0 ? "message.part.delta" : "turn.progress",
    bytes: 520 + (sequence % 6) * 24,
    raw: `{
  "method": "session/event",
  "params": {
    "sessionId": "sess_6b6a",
    "seq": ${eventSeq},
    "payload": {
      "type": "${sequence % 3 === 0 ? "message.part.delta" : "turn.progress"}",
      "inputId": "${inputId}"
    }
  }
}`,
  };
}
