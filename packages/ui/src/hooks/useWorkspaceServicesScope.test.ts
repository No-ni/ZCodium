import type { IServiceAccessor } from "@zcode/services";
import { describe, expect, it, vi } from "vitest";
import { resolveRemoteWorkspaceSessionIdForTarget } from "./useResolvedRemoteWorkspaceSessionId.js";
import {
  resolveWorkspaceServiceIsRemoteTarget,
  resolveWorkspaceServicesForTarget,
} from "./useWorkspaceServices.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

const localStat = vi.fn();
const remoteStat = vi.fn();
const localServices = { fileService: { stat: localStat } } as unknown as IServiceAccessor;
const remoteServices = { fileService: { stat: remoteStat } } as unknown as IServiceAccessor;
const activeTab = {
  kind: "workspace",
  id: "remote",
  label: "remote",
  workspacePath: "/repo",
  workspaceIdentity: "remote-B:/repo",
  remoteSessionId: "B",
  remoteTarget: { kind: "wsl" },
} as WorkspaceTabState;
const state = {
  sessionsById: { B: { services: remoteServices } },
  sessionIdByWorkspaceIdentity: { "remote-B:/repo": "B" },
  sessionIdByWorkspacePath: { "/repo": "B" },
};

describe("frozen file sources do not inherit the active Host", () => {
  it("reads a frozen local source on the base Host beside the same remote path", async () => {
    const session = resolveRemoteWorkspaceSessionIdForTarget({
      workspacePath: "/repo",
      scopeResolution: "exact",
      activeTab,
      state,
    });
    expect(session).toBeNull();
    const services = resolveWorkspaceServicesForTarget({
      currentContextServices: remoteServices,
      resolvedRemoteSessionId: session,
      baseServices: localServices,
      sessionsById: state.sessionsById,
      isRemoteTarget: false,
    });
    await services.fileService.stat({ path: "/repo/report.md" });
    expect(localStat).toHaveBeenCalledWith({ path: "/repo/report.md" });
    expect(remoteStat).not.toHaveBeenCalled();
  });
  it("routes exact identity to its registry attachment and rejects disconnected remote sources", async () => {
    expect(
      resolveRemoteWorkspaceSessionIdForTarget({
        workspacePath: "/repo",
        workspaceIdentity: "remote-B:/repo",
        scopeResolution: "exact",
        activeTab,
        state,
      }),
    ).toBe("B");
    const session = resolveRemoteWorkspaceSessionIdForTarget({
      workspacePath: "/repo",
      workspaceIdentity: "remote-C:/repo",
      scopeResolution: "exact",
      activeTab,
      state,
    });
    expect(session).toBeNull();
    const services = resolveWorkspaceServicesForTarget({
      currentContextServices: localServices,
      resolvedRemoteSessionId: session,
      baseServices: localServices,
      sessionsById: state.sessionsById,
      isRemoteTarget: true,
    });
    await expect(services.fileService.stat({ path: "/repo/report.md" })).rejects.toThrow();
  });
  it("target-only exact remote sources remain disconnected instead of borrowing the base Host", async () => {
    const isRemoteTarget = resolveWorkspaceServiceIsRemoteTarget({
      workspacePath: "/repo",
      scopeResolution: "exact",
      remoteTarget: activeTab.remoteTarget,
    });
    expect(isRemoteTarget).toBe(true);
    const session = resolveRemoteWorkspaceSessionIdForTarget({
      workspacePath: "/repo",
      scopeResolution: "exact",
      remoteTarget: activeTab.remoteTarget,
      activeTab,
      state,
    });
    expect(session).toBeNull();
    const services = resolveWorkspaceServicesForTarget({
      currentContextServices: localServices,
      resolvedRemoteSessionId: session,
      baseServices: localServices,
      sessionsById: state.sessionsById,
      isRemoteTarget,
    });
    await expect(services.fileService.stat({ path: "/repo/report.md" })).rejects.toThrow();
  });
  it("keeps old path-only sources attached to their ambient remote Host", () => {
    expect(
      resolveRemoteWorkspaceSessionIdForTarget({ workspacePath: "/repo", activeTab, state }),
    ).toBe("B");
    expect(
      resolveRemoteWorkspaceSessionIdForTarget({
        workspacePath: "/repo",
        activeTab: { ...activeTab, workspaceIdentity: undefined, remoteSessionId: undefined },
        state,
      }),
    ).toBe("B");
  });
});
