import { createServer } from "node:http";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  webRemoteControlEndpointToClientFrameSchema,
  type WebRemoteControlAppPayload,
} from "@zcode/shared";
import { createRelayDeviceTransport } from "./relayTransport.js";

describe("relay inbound frame validation", () => {
  it("has identical second-parse fields and payload references for every endpoint frame", () => {
    const payload = Object.freeze({ zcode_type: "bootstrap-request", requestId: "synthetic" });
    for (const frame of [
      { type: "device_register_ack", device_sid: "  synthetic-sid  " },
      { type: "auth_challenge", nonce: "  synthetic-nonce  " },
      { type: "auth_ack", pair_status: "waiting" },
      { type: "auth_ack", pair_status: "matched" },
      { type: "pair_status_ack", pair_status: "waiting" },
      { type: "pair_status_ack", pair_status: "matched" },
      { type: "data", payload },
      ...["KICKED", "AUTH_FAILED", "INTERNAL", "WRONG_PARAM"].map((code) => ({
        type: "error",
        code,
        message: "测试",
      })),
    ]) {
      const first = webRemoteControlEndpointToClientFrameSchema.parse(frame);
      const second = webRemoteControlEndpointToClientFrameSchema.parse(first);
      expect(second).toEqual(first);
      if (first.type === "data" && second.type === "data") {
        expect(first.payload).toBe(payload);
        expect(second.payload).toBe(payload);
      }
    }
  });

  it("validates each real WebSocket frame once while retaining auth and app payload checks", async () => {
    const http = createServer();
    const relay = new WebSocketServer({ server: http });
    const serverSockets: WebSocket[] = [];
    const received: Array<Record<string, unknown>> = [];
    const trace: unknown[] = [];
    const payloads: WebRemoteControlAppPayload[] = [];
    const warnings: string[] = [];
    const errors: Error[] = [];
    let sentFrames = 0;
    let settleFinal!: () => void;
    const finalPayload = new Promise<void>((resolve) => {
      settleFinal = resolve;
    });
    const send = (socket: WebSocket, frame: unknown) => {
      sentFrames++;
      socket.send(typeof frame === "string" ? frame : JSON.stringify(frame));
    };
    relay.on("connection", (socket) => {
      serverSockets.push(socket);
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        received.push(frame);
        if (frame.type === "device_register_init")
          send(socket, { type: "device_register_ack", device_sid: "  synthetic-sid  " });
        else if (frame.type === "auth_init")
          send(socket, { type: "auth_challenge", nonce: "  synthetic-nonce  " });
        else if (frame.type === "auth_response")
          send(socket, { type: "auth_ack", pair_status: "waiting" });
      });
    });
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const port = (http.address() as { port: number }).port;
    const outer = vi.spyOn(webRemoteControlEndpointToClientFrameSchema, "safeParse");
    const transport = createRelayDeviceTransport({
      logger: {
        info() {},
        warn(message) {
          warnings.push(String(message));
        },
        error() {},
      },
      relayWsUrl: `ws://127.0.0.1:${port}/ws`,
      deviceMid: "synthetic-mid",
      deviceName: "synthetic",
      appVersion: "test",
      maxPhysicalFrameBytes: 100_000,
      auth: { mode: "register", passHash: "synthetic-hash" },
      events: {
        onStateChange(state) {
          trace.push(["state", state]);
        },
        onPayload(payload) {
          payloads.push(payload);
          trace.push(["payload", payload]);
          if (payload.zcode_type === "bootstrap-request" && payload.requestId === "final")
            settleFinal();
        },
        onRegisteredAuth(auth) {
          trace.push(["registered", auth]);
        },
        onError(error) {
          errors.push(error);
        },
        async onInvalidPersistedAuth() {
          throw new Error("Valid synthetic credentials must not be cleared");
        },
      },
    });
    let validationCalls = 0;
    let expectedCalls = 0;
    try {
      await transport.start();
      expect(transport.sendPayload({ zcode_type: "bootstrap-request", requestId: "waiting" })).toBe(
        false,
      );
      const socket = serverSockets[0]!;
      send(socket, {
        type: "data",
        payload: { zcode_type: "bootstrap-request", requestId: "dropped-while-waiting" },
      });
      send(socket, { type: "pair_status_ack", pair_status: "matched" });
      for (let index = 0; index < 20; index++)
        send(socket, { type: "pair_status_ack", pair_status: "matched" });
      send(socket, {
        type: "data",
        payload: { zcode_type: "bootstrap-request", requestId: "first" },
      });
      send(socket, { type: "data", payload: { zcode_type: "not-a-payload" } });
      send(socket, { type: "auth_ack", pair_status: "invalid" });
      send(socket, "invalid-json");
      send(socket, {
        type: "data",
        payload: { zcode_type: "bootstrap-request", requestId: "final" },
      });
      await finalPayload;
      validationCalls = outer.mock.calls.length;
      expectedCalls = sentFrames - 1;
      expect(payloads).toEqual([
        { zcode_type: "bootstrap-request", requestId: "first" },
        { zcode_type: "bootstrap-request", requestId: "final" },
      ]);
      expect(trace).toEqual([
        ["state", "connecting"],
        ["state", "registering"],
        ["registered", { deviceSid: "synthetic-sid", passHash: "synthetic-hash" }],
        ["state", "authenticating"],
        ["state", "waiting_terminal"],
        ["state", "paired"],
        ...payloads.map((payload) => ["payload", payload]),
      ]);
      expect(received.find((frame) => frame.type === "auth_response")).toMatchObject({
        device_sid: "synthetic-sid",
        proof: createHmac("sha256", "synthetic-hash")
          .update("synthetic-nonce|device|synthetic-sid")
          .digest("base64url"),
      });
      expect(warnings).toEqual([
        "[web-remote-control] invalid relay app payload dropped",
        "[web-remote-control] invalid relay frame",
        "[web-remote-control] invalid relay message",
      ]);
      expect(errors).toEqual([]);
      expect(transport.sendPayload({ zcode_type: "bootstrap-request", requestId: "paired" })).toBe(
        true,
      );
    } finally {
      outer.mockRestore();
      transport.dispose();
      for (const socket of serverSockets) socket.terminate();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
    process.stdout.write(
      `RELAY_INBOUND_WORK ${JSON.stringify({ validationCalls, expectedCalls })}\n`,
    );
    expect(validationCalls).toBe(expectedCalls);
  });
});
