import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { ServiceCollection } from "@zcode/services";
import { ProtocolMessageType, SocketProtocol, VSBuffer } from "@zcode/rpc";
import { createStdioServer } from "@zcode/server/stdio";

it("stdio stop releases protocol input synchronously before closing stdin", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const input = vi
    .spyOn(process, "stdin", "get")
    .mockReturnValue(stdin as unknown as typeof process.stdin);
  const output = vi
    .spyOn(process, "stdout", "get")
    .mockReturnValue(stdout as unknown as typeof process.stdout);
  const original = SocketProtocol.prototype.dispose;
  const sizes: number[] = [];
  const disposed = vi.spyOn(SocketProtocol.prototype, "dispose").mockImplementation(function () {
    const stream = (this as unknown as { chunkStream: { byteLength: number } }).chunkStream;
    sizes.push(stream.byteLength);
    original.call(this);
    sizes.push(stream.byteLength);
  });
  try {
    const server = createStdioServer(new ServiceCollection());
    const frame = VSBuffer.alloc(29);
    frame.writeUInt8(ProtocolMessageType.Regular, 0);
    frame.writeUInt32BE(1024, 9);
    stdin.write(frame.buffer);
    const stopping = server.stop();
    expect(sizes).toEqual([29, 0]);
    expect(stdin.destroyed).toBe(false);
    await stopping;
    expect(stdin.destroyed).toBe(true);
    await server.stop();
    expect(disposed).toHaveBeenCalledTimes(1);
  } finally {
    input.mockRestore();
    output.mockRestore();
    disposed.mockRestore();
    stdin.destroy();
    stdout.destroy();
  }
});
