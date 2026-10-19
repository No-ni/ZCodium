import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { BufferWriter, serialize } from "@zcode/rpc";
import { createRemoteRuntimeServicesFromPort } from "../src/bots/botRemoteRuntimeServices.js";

it.each([false, true])(
  "releases queued/sent RPC calls and closes the owned port once (initialized=%s)",
  async (initialized) => {
    const port = Object.assign(new EventEmitter(), {
      postMessage: vi.fn(),
      start: vi.fn(),
      close: vi.fn(),
    });
    const services = createRemoteRuntimeServicesFromPort(port);
    if (initialized) {
      const writer = new BufferWriter();
      serialize(writer, [200]);
      serialize(writer, undefined);
      port.emit("message", { data: writer.buffer.buffer });
    }
    const result = services.modelSelectionService.getView().catch((error: unknown) => error);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(port.postMessage.mock.calls.length > 0).toBe(initialized);
    services.dispose();
    services.dispose();
    expect(await result).toMatchObject({ name: "ConnectionClosed" });
    expect(port.listenerCount("message")).toBe(0);
    expect(port.close).toHaveBeenCalledOnce();
    await expect(services.modelSelectionService.getView()).rejects.toBeInstanceOf(Error);
  },
);
