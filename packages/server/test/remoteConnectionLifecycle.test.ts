import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { Emitter, type IDisposable } from "@zcode/rpc";
import type { IRemoteBackend, RemoteDisconnectEvent } from "../src/remote/backend.js";
import { connectRemote } from "../src/remote/connect.js";

vi.mock("../src/remote/handshake.js", () => ({
  performHandshake: async () => ({ hello: { version: "fixture" }, remaining: null }),
}));

describe("remote adapter owns terminal RPC cleanup", () => {
  it("explicit graceful disposal still awaits backend cleanup after stream EOF", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const close = new Emitter<number>();
    let finishBackend!: () => void;
    const backendClosed = new Promise<void>((resolve) => {
      finishBackend = resolve;
    });
    const dispose = vi.fn();
    const disposeAndWait = vi.fn(() => backendClosed);
    const backend: IRemoteBackend = {
      async detect() {
        return { platform: "darwin", arch: "arm64" };
      },
      async exec() {
        return { stdin, stdout, stderr, onClose: close.event };
      },
      async upload() {},
      async exists() {
        return true;
      },
      async readFile() {
        return "";
      },
      dispose,
      disposeAndWait,
    };
    const connection = await connectRemote(backend, { skipDeploy: true });
    let settled = false;
    const disposing = connection.disposeAndWait().then(() => {
      settled = true;
    });
    try {
      close.fire(0);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(disposeAndWait).toHaveBeenCalledTimes(1);
      expect(dispose).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      finishBackend();
      await disposing;
      expect(settled).toBe(true);
    } finally {
      finishBackend();
      await disposing;
      connection.dispose();
      stdout.destroy();
      stderr.destroy();
      stdin.destroy();
      close.dispose();
    }
  });

  it.each(["stream", "backend"])(
    "%s close releases requests before optional host notification",
    async (source) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      const close = new Emitter<number>();
      const disconnect = new Emitter<RemoteDisconnectEvent>();
      const dispose = vi.fn();
      const backend: IRemoteBackend = {
        onDidDisconnect: disconnect.event,
        async detect() {
          return { platform: "darwin", arch: "arm64" };
        },
        async exec() {
          return { stdin, stdout, stderr, onClose: close.event };
        },
        async upload() {},
        async exists() {
          return true;
        },
        async readFile() {
          return "";
        },
        dispose,
      };
      const notifications: number[] = [];
      const connection = await connectRemote(backend, {
        skipDeploy: true,
        onDidRemoteClose() {
          notifications.push(
            (connection.client as unknown as { requests: Map<number, unknown> }).requests.size,
          );
        },
      });
      const result = connection.services.systemService.info().then(
        () => "resolved",
        (error: unknown) => error,
      );
      const event: IDisposable = connection.services.broadcastService.onMessage(() => {});
      try {
        if (source === "stream") close.fire(0);
        else disconnect.fire({ reason: "close" });
        expect(notifications).toEqual([0]);
        expect(await result).toMatchObject({ name: "ConnectionClosed" });
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(stdin.writableEnded).toBe(true);
        close.fire(0);
        disconnect.fire({ reason: "end" });
        connection.dispose();
        await connection.disposeAndWait();
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(notifications).toEqual([0]);
      } finally {
        event.dispose();
        connection.dispose();
        stdout.destroy();
        stderr.destroy();
        stdin.destroy();
        close.dispose();
        disconnect.dispose();
      }
    },
  );
});
