import type { IServiceAccessor } from "@zcode/services";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTaskExecutionWorkspaceServices } from "@/lib/taskExecutionWorkspaceServices.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";

describe("file links from a remote pane beside a local primary", () => {
  afterEach(() => {
    useRemoteWorkspaceSessionStore.setState({
      sessionsById: {},
      sessionIdByWorkspaceIdentity: {},
      sessionIdByWorkspacePath: {},
    });
  });

  it("stats the frozen remote target using the real connection registry", async () => {
    const localStat = vi.fn();
    const remoteStat = vi.fn().mockResolvedValue({ type: "file" });
    const baseServices = { fileService: { stat: localStat } } as unknown as IServiceAccessor;
    const remoteServices = { fileService: { stat: remoteStat } } as unknown as IServiceAccessor;
    const target = {
      path: "/workspace/2026-10-14/session/report.md",
      workspaceIdentity: "remote-B:/workspace",
      workspaceRemoteSessionId: "remote-B",
    };
    const registry = useRemoteWorkspaceSessionStore.getState();
    registry.registerSession({ sessionId: "remote-B", services: remoteServices });
    registry.bindWorkspaceIdentity(target.workspaceIdentity, "remote-B");

    const services = resolveTaskExecutionWorkspaceServices({
      baseServices,
      workspaceIdentity: target.workspaceIdentity,
      remoteSessionId: target.workspaceRemoteSessionId,
    });
    await services?.fileService.stat({ path: target.path });
    expect(remoteStat).toHaveBeenCalledWith({ path: target.path });
    expect(localStat).not.toHaveBeenCalled();

    registry.unregisterSession("remote-B");
    expect(
      resolveTaskExecutionWorkspaceServices({
        baseServices,
        workspaceIdentity: target.workspaceIdentity,
        remoteSessionId: target.workspaceRemoteSessionId,
      }),
    ).toBeNull();
    expect(localStat).not.toHaveBeenCalled();
  });
});
