import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocket } from "ws";
import {
  webRemoteControlAppPayloadSchema,
  webRemoteControlClientToEndpointFrameSchema,
  type WebRemoteControlAppPayload,
  type WebRemoteControlEndpointToClientFrame,
} from "@zcode/shared";
import type { PairEntry } from "./lanEndpointTypes.js";
import type { WebRemoteControlLogger } from "./logger.js";

const NONCE_TTL_MS = 60_000;

/** 配对表由 endpoint 持有；每条 socket 单独拥有 challenge 与鉴权生命周期。 */
export function attachLanMobileSocket(
  ws: WebSocket,
  options: {
    pairs: Map<string, PairEntry>;
    logger: WebRemoteControlLogger;
    maxFrameBytes: number;
    handleMobilePayload(deviceSid: string, payload: WebRemoteControlAppPayload): void;
  },
): void {
  let entry: PairEntry | null = null;
  // challenge 属于 socket；共享到 PairEntry 会让并发扫码及失败 proof 相互覆盖。
  let challenge: { nonce: string; expiresAt: number } | null = null;
  let authenticated = false;
  const isCurrentBinding = (): boolean =>
    authenticated &&
    entry !== null &&
    options.pairs.get(entry.deviceSid) === entry &&
    entry.mobile === ws;
  const send = (frame: WebRemoteControlEndpointToClientFrame): void => {
    ws.send(JSON.stringify(frame));
  };
  const fail = (code: "AUTH_FAILED" | "WRONG_PARAM" | "INTERNAL", message?: string): void => {
    send({ type: "error", code, message });
    ws.close(4001, code);
  };

  ws.on("message", (raw) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const text = typeof raw === "string" ? raw : raw.toString();
    if (Buffer.byteLength(text) > options.maxFrameBytes) {
      options.logger.warn("[web-remote-control] oversize mobile frame dropped", {
        bytes: Buffer.byteLength(text),
        maxBytes: options.maxFrameBytes,
      });
      fail("WRONG_PARAM", "frame too large");
      return;
    }
    let parsed: ReturnType<typeof webRemoteControlClientToEndpointFrameSchema.safeParse>;
    try {
      parsed = webRemoteControlClientToEndpointFrameSchema.safeParse(JSON.parse(text));
    } catch {
      fail("WRONG_PARAM", "invalid json");
      return;
    }
    if (!parsed.success) {
      fail("WRONG_PARAM", "invalid frame");
      return;
    }
    const frame = parsed.data;
    switch (frame.type) {
      case "auth_init": {
        if (entry) {
          fail("WRONG_PARAM", "authentication already started");
          return;
        }
        if (frame.role !== "mobile") {
          fail("AUTH_FAILED");
          return;
        }
        const candidate = options.pairs.get(frame.device_sid);
        if (!candidate) {
          fail("AUTH_FAILED");
          return;
        }
        entry = candidate;
        challenge = {
          nonce: randomBytes(16).toString("base64url"),
          expiresAt: Date.now() + NONCE_TTL_MS,
        };
        send({ type: "auth_challenge", nonce: challenge.nonce });
        return;
      }
      case "auth_response": {
        const pending = challenge;
        challenge = null;
        if (
          !entry ||
          !pending ||
          authenticated ||
          pending.expiresAt <= Date.now() ||
          frame.device_sid !== entry.deviceSid ||
          options.pairs.get(entry.deviceSid) !== entry
        ) {
          fail("AUTH_FAILED");
          return;
        }
        const expected = calculateProof(entry.passHash, pending.nonce, "mobile", entry.deviceSid);
        if (!safeEqual(expected, frame.proof)) {
          fail("AUTH_FAILED");
          return;
        }
        if (entry.mobile && entry.mobile !== ws) {
          // 单页面互踢：先给旧连接发 error{KICKED}（桌面/移动端据此映射
          // session-conflict），再关闭；只关不发会让旧页面静默掉线。
          const stale = entry.mobile;
          if (stale.readyState === WebSocket.OPEN) {
            stale.send(JSON.stringify({ type: "error", code: "KICKED", message: "kicked" }));
            stale.close(4002, "kicked");
          }
          // 旧 socket 的 close 会被新绑定隔离；这里先通知 Main 释放旧页面的 attachment。
          entry.device?.handlers.onMobileDisconnected();
        }
        entry.mobile = ws;
        authenticated = true;
        entry.pairStatus = entry.device ? "matched" : "waiting";
        entry.lastSeenAt = Date.now();
        entry.device?.handlers.onStateChange("paired");
        send({ type: "auth_ack", pair_status: entry.pairStatus });
        return;
      }
      case "pair_status_query": {
        if (!entry || !isCurrentBinding() || frame.device_sid !== entry.deviceSid) {
          fail("AUTH_FAILED");
          return;
        }
        entry.lastSeenAt = Date.now();
        send({ type: "pair_status_ack", pair_status: entry.pairStatus });
        return;
      }
      case "data": {
        if (!entry || !isCurrentBinding()) {
          fail("AUTH_FAILED");
          return;
        }
        entry.lastSeenAt = Date.now();
        if (!entry.device || entry.pairStatus !== "matched") return;
        const payload = webRemoteControlAppPayloadSchema.safeParse(frame.payload);
        if (!payload.success) {
          options.logger.warn("[web-remote-control] invalid app payload dropped");
          return;
        }
        options.handleMobilePayload(entry.deviceSid, payload.data);
        return;
      }
      default:
        fail("WRONG_PARAM");
    }
  });

  ws.on("close", () => {
    if (!entry || entry.mobile !== ws) return;
    entry.mobile = undefined;
    entry.pairStatus = "waiting";
    entry.device?.handlers.onMobileDisconnected();
  });
  ws.on("error", (error) => {
    options.logger.warn("[web-remote-control] mobile socket error", {
      message: error.message,
    });
  });
}

function calculateProof(passHash: string, nonce: string, role: string, deviceSid: string): string {
  return createHmac("sha256", passHash).update(`${nonce}|${role}|${deviceSid}`).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
