import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { ServiceCollection } from "@zcode/services";
import { ProtocolMessageType, SocketProtocol, VSBuffer } from "@zcode/rpc";
import { createHttpServer } from "@zcode/server";

it("real HTTP WebSocket close releases an unfinished protocol frame", async () => {
  const original = SocketProtocol.prototype.dispose;
  let released!: (sizes: number[]) => void;
  const disposed = new Promise<number[]>((resolve) => {
    released = resolve;
  });
  const spy = vi.spyOn(SocketProtocol.prototype, "dispose").mockImplementation(function () {
    const stream = (this as unknown as { chunkStream: { byteLength: number } }).chunkStream;
    const before = stream.byteLength;
    original.call(this);
    released([before, stream.byteLength]);
  });
  const server = createHttpServer(new ServiceCollection(), 0, { host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("missing test port");
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("fixture connect failed")), {
        once: true,
      });
    });
    const frame = VSBuffer.alloc(29);
    frame.writeUInt8(ProtocolMessageType.Regular, 0);
    frame.writeUInt32BE(1024, 9);
    ws.send(frame.buffer);
    ws.close();
    expect(await disposed).toEqual([29, 0]);
    expect(spy).toHaveBeenCalledTimes(1);
  } finally {
    ws.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    spy.mockRestore();
  }
});
