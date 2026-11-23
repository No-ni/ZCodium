import { afterEach, describe, expect, it, vi } from "vitest";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { EventEmitter } from "node:events";

const terminateMcpStdioProcessTree = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../src/mcp/process-tree.js", () => ({
  terminateMcpStdioProcessTree,
}));

import { ProcessTreeStdioClientTransport } from "../src/mcp/stdio-transport.js";

describe("ProcessTreeStdioClientTransport Windows fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the existing taskkill tree cleanup when Job Object attach fails", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    try {
      vi.spyOn(StdioClientTransport.prototype, "start").mockResolvedValue();
      vi.spyOn(StdioClientTransport.prototype, "pid", "get").mockReturnValue(4321);
      const windowsJobObjectFactory = vi.fn(async () => undefined);
      const transport = new ProcessTreeStdioClientTransport(
        { command: process.execPath },
        { windowsJobObjectFactory },
      );
      const child = Object.assign(new EventEmitter(), {
          exitCode: null,
          pid: 4321,
          signalCode: null,
      });
      Object.assign(transport as unknown as { _process: object }, { _process: child });
      // 真实 close flight 等待 pipe 回收；fake 进程必须在树终止后给出同一个 close 边界。
      terminateMcpStdioProcessTree.mockImplementationOnce(async () => {
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });

      await transport.start();
      delete (transport as unknown as { _process?: object })._process;
      const dispose = Object.getOwnPropertyDescriptor(
        ProcessTreeStdioClientTransport.prototype,
        "_dispose",
      )?.value as ((this: ProcessTreeStdioClientTransport) => Promise<void>) | undefined;

      await dispose?.call(transport);

      expect(windowsJobObjectFactory).toHaveBeenCalledWith(4321);
      expect(terminateMcpStdioProcessTree).toHaveBeenCalledWith(4321);
    } finally {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: originalPlatform,
      });
    }
  });
});
