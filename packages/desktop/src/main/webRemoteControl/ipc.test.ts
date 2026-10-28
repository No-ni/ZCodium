import { beforeEach, describe, expect, it, vi } from "vitest";
import { HostMessageTypes, PlatformChannels } from "@zcode/shared";
import { registerWebRemoteControlIpcHandlers } from "./ipc.js";

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => unknown>());
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler),
  },
}));
beforeEach(() => handlers.clear());

describe("Window directory projection forwarding", () => {
  it("forwards one validated projection to the same window Host with monotonically increasing generations", () => {
    const messages: unknown[] = [];
    const host = { postMessage: (message: unknown) => messages.push(message) };
    const sync = vi.fn();
    registerWebRemoteControlIpcHandlers({
      getManager: () => ({ syncWorkspaces: sync }) as never,
      logger: { info() {}, warn() {}, error() {} },
      resolveWindowId: (sender) => (sender.id === 7 ? 1 : undefined),
      resolveWindow: () => undefined,
      resolveHostProcess: (id) => (id === 7 ? host : undefined),
    });
    const handler = handlers.get(PlatformChannels.SyncWebRemoteControlWorkspaces)!;
    const event = { sender: { id: 7 } };
    const payload = {
      workspacePath: "/workspace",
      workspaces: [
        {
          workspaceKey: "/workspace",
          workspacePath: "/workspace",
          kind: "local",
          lastConnectionError: "raw fixture error",
        },
      ],
    };
    handler(event, payload);
    handler(event, { ...payload, workspaces: [] });
    expect(messages).toEqual([
      {
        type: HostMessageTypes.WindowProjectDirectoryProjection,
        projection: {
          version: 1,
          generation: 1,
          workspaces: [{ workspaceKey: "/workspace", workspacePath: "/workspace", kind: "local" }],
        },
      },
      {
        type: HostMessageTypes.WindowProjectDirectoryProjection,
        projection: { version: 1, generation: 2, workspaces: [] },
      },
    ]);
    expect(sync).toHaveBeenCalledTimes(2);
    handler({ sender: { id: 99 } }, payload);
    expect(messages).toHaveLength(2);
  });
  it("invalid identity is rejected before any Host projection is sent", () => {
    const postMessage = vi.fn();
    registerWebRemoteControlIpcHandlers({
      getManager: () => ({ syncWorkspaces() {} }) as never,
      logger: { info() {}, warn() {}, error() {} },
      resolveWindowId: () => 1,
      resolveWindow: () => undefined,
      resolveHostProcess: () => ({ postMessage }),
    });
    expect(() =>
      handlers.get(PlatformChannels.SyncWebRemoteControlWorkspaces)!(
        { sender: { id: 7 } },
        {
          workspacePath: "/workspace",
          workspaces: [{ workspaceKey: "wrong", workspacePath: "/workspace", kind: "local" }],
        },
      ),
    ).toThrow();
    expect(postMessage).not.toHaveBeenCalled();
  });
});
