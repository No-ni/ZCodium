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
  it("rejects an identity-mismatched projection without cancelling the workspace manifest", () => {
    const postMessage = vi.fn();
    const sync = vi.fn();
    registerWebRemoteControlIpcHandlers({
      getManager: () => ({ syncWorkspaces: sync }) as never,
      logger: { info() {}, warn() {}, error() {} },
      resolveWindowId: () => 1,
      resolveWindow: () => undefined,
      resolveHostProcess: () => ({ postMessage }),
    });
    // 新契约：workspaceKey 与身份不符只否掉可选投影；必选的清单写入不能被它连带回滚，
    // 也不允许把失败抛回渲染端（抛出去只会变成一条 warn，手机侧表现为清单永久过期）。
    expect(() =>
      handlers.get(PlatformChannels.SyncWebRemoteControlWorkspaces)!(
        { sender: { id: 7 } },
        {
          workspacePath: "/workspace",
          workspaces: [{ workspaceKey: "wrong", workspacePath: "/workspace", kind: "local" }],
        },
      ),
    ).not.toThrow();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("still writes the workspace manifest when the window has no Host process yet", () => {
    const sync = vi.fn();
    registerWebRemoteControlIpcHandlers({
      getManager: () => ({ syncWorkspaces: sync }) as never,
      logger: { info() {}, warn() {}, error() {} },
      resolveWindowId: () => 1,
      resolveWindow: () => undefined,
      // Host 尚未拉起（窗口刚创建/Host 正在重建）：投影无处可投，但清单写入与它无关。
      resolveHostProcess: () => undefined,
    });
    handlers.get(PlatformChannels.SyncWebRemoteControlWorkspaces)!(
      { sender: { id: 7 } },
      {
        workspacePath: "/workspace",
        workspaces: [{ workspaceKey: "/workspace", workspacePath: "/workspace", kind: "local" }],
      },
    );
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("keeps the mandatory workspace manifest when the optional directory projection is rejected", () => {
    const postMessage = vi.fn();
    const sync = vi.fn();
    const warnings: Array<unknown[]> = [];
    registerWebRemoteControlIpcHandlers({
      getManager: () => ({ syncWorkspaces: sync }) as never,
      logger: { info() {}, warn: (...args: unknown[]) => warnings.push(args), error() {} },
      resolveWindowId: () => 1,
      resolveWindow: () => undefined,
      resolveHostProcess: () => ({ postMessage }),
    });
    const handler = handlers.get(PlatformChannels.SyncWebRemoteControlWorkspaces)!;
    // 旧持久化标签页只带 remoteSessionId、没有 workspaceIdentity（tabStore 的 RestorableWorkspaceTab
    // 形态，见 taskNavigationWorkspace.test.ts 的 legacy-remote 夹具）。这类条目会被窗口目录的严格
    // 校验拒绝，但它是可选能力：必选清单必须先落，不能反过来被投影挡死。
    handler(
      { sender: { id: 7 } },
      {
        workspacePath: "/workspace",
        workspaces: [
          {
            workspaceKey: "/workspace",
            workspacePath: "/workspace",
            remoteSessionId: "legacy-remote",
            kind: "remote",
          },
        ],
      },
    );
    expect(sync).toHaveBeenCalledTimes(1);
    expect(postMessage).not.toHaveBeenCalled();
    // 必选链路的入参本身也要锁住：清单必须原样带上 legacy 的 remoteSessionId，
    // 否则「保留 legacy 身份」只写在注释里、没有任何回归能证明它没被 zod strip 掉。
    const synced = sync.mock.calls[0]?.[1] as Array<Record<string, unknown>>;
    expect(synced).toHaveLength(1);
    expect(synced[0]).toEqual({
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      remoteSessionId: "legacy-remote",
      kind: "remote",
    });
    expect(synced[0]?.remoteSessionId).toBe("legacy-remote");
    expect(synced[0]?.workspaceIdentity).toBeUndefined();
    expect(warnings).toHaveLength(1);
    const detail = (warnings[0] as unknown[])[1] as Record<string, unknown>;
    expect(detail.windowId).toBe(1);
    expect(detail.generation).toBe(1);
    expect(detail.candidates).toBe(1);
    expect(detail.codes).toContain("custom");
    // 诊断只允许原因码/字段名/数字，不得回显路径、identity 或 zod 原文。
    expect(JSON.stringify(detail)).not.toContain("legacy-remote");
    // 被拒绝的那一次不占用代际：随后合法投影仍从同一 Host 的起点单调投递。
    handler(
      { sender: { id: 7 } },
      {
        workspacePath: "/workspace",
        workspaces: [
          {
            workspaceKey: "/workspace",
            workspacePath: "/workspace",
            kind: "local",
            lastConnectionError: "raw fixture error",
          },
        ],
      },
    );
    expect(sync).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0]?.[0]).toEqual({
      type: HostMessageTypes.WindowProjectDirectoryProjection,
      projection: {
        version: 1,
        generation: 1,
        workspaces: [{ workspaceKey: "/workspace", workspacePath: "/workspace", kind: "local" }],
      },
    });
    // 只有可选投影剥掉 lastConnectionError；必选清单必须仍然拿到它，手机侧才看得见失败原因。
    const posted = postMessage.mock.calls[0]?.[0] as {
      projection: { workspaces: Array<Record<string, unknown>> };
    };
    const firstPostedWorkspace = posted.projection.workspaces[0] ?? {};
    expect(Object.hasOwn(firstPostedWorkspace, "lastConnectionError")).toBe(false);
    const syncedAgain = sync.mock.calls[1]?.[1] as Array<Record<string, unknown>>;
    expect(syncedAgain[0]?.lastConnectionError).toBe("raw fixture error");
  });
});
