import type { IServiceAccessor } from "@zcode/services";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getRemoteWorkspaceServicesForIdentity,
  getRemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
import { resolveTaskExecutionWorkspaceServices } from "@/lib/taskExecutionWorkspaceServices.js";

vi.mock("@/store/remoteWorkspaceSessionStore.js", () => ({
  getRemoteWorkspaceServicesForIdentity: vi.fn(),
  getRemoteWorkspaceSession: vi.fn(),
}));

const baseServices = {} as IServiceAccessor;
const activeRemoteServices = {} as IServiceAccessor;
const targetRemoteServices = {} as IServiceAccessor;

const getRemoteServicesForIdentity = vi.mocked(getRemoteWorkspaceServicesForIdentity);
const getRemoteSession = vi.mocked(getRemoteWorkspaceSession);

describe("resolveTaskExecutionWorkspaceServices", () => {
  afterEach(() => vi.resetAllMocks());

  it("uses base services for a local target while another remote host is active", () => {
    const resolved = resolveTaskExecutionWorkspaceServices({ baseServices });

    expect(activeRemoteServices).not.toBe(baseServices);
    expect(resolved).toBe(baseServices);
    expect(resolved).not.toBe(activeRemoteServices);
    expect(getRemoteSession).not.toHaveBeenCalled();
    expect(getRemoteServicesForIdentity).not.toHaveBeenCalled();
  });

  it("uses the target remote session instead of the active remote host", () => {
    getRemoteSession.mockReturnValue({
      sessionId: "remote-B",
      services: targetRemoteServices,
    });

    const resolved = resolveTaskExecutionWorkspaceServices({
      baseServices,
      workspaceIdentity: "host-B:/workspace",
      remoteSessionId: "remote-B",
    });

    expect(resolved).toBe(targetRemoteServices);
    expect(resolved).not.toBe(activeRemoteServices);
    expect(getRemoteSession).toHaveBeenCalledWith("remote-B");
    expect(getRemoteServicesForIdentity).not.toHaveBeenCalled();
  });

  it("resolves a remote identity when the target has no session id", () => {
    getRemoteServicesForIdentity.mockReturnValue(targetRemoteServices);

    expect(
      resolveTaskExecutionWorkspaceServices({
        baseServices,
        workspaceIdentity: " host-B:/workspace ",
      }),
    ).toBe(targetRemoteServices);
    expect(getRemoteServicesForIdentity).toHaveBeenCalledWith("host-B:/workspace");
  });

  it("fails closed when the target remote session is disconnected", () => {
    getRemoteSession.mockReturnValue(null);

    expect(
      resolveTaskExecutionWorkspaceServices({
        baseServices,
        workspaceIdentity: "host-B:/workspace",
        remoteSessionId: "remote-B",
      }),
    ).toBeNull();
    expect(getRemoteServicesForIdentity).not.toHaveBeenCalled();
  });
});
