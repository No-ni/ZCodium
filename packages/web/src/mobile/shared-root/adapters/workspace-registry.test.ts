import { connectViaProtocol, RemoteServiceAccess } from "@zcode/client";
import {
  getRegisteredBaseWorkspaceServices,
  getRemoteWorkspaceSession,
  getRemoteWorkspaceServicesForIdentity,
  registerBaseWorkspaceServices,
  unregisterRemoteWorkspaceSession,
} from "@zcode/ui/remote-workspace-session-store";
import { afterEach, describe, expect, it } from "vitest";
import type { MobileRootWorkspaceAccess } from "../contract.js";
import { registerMobileRootWorkspace } from "./workspace-registry.js";

const remoteSessionId = "mobile-registry-source-owner";
const lifetimes: AbortController[] = [];
function access(generation: number): MobileRootWorkspaceAccess {
  // 使用公开 factory 内的真实 ChannelClient/RemoteServiceAccess；不伪造 generic getChannel。
  const lifetime = new AbortController();
  lifetimes.push(lifetime);
  const services = connectViaProtocol(
    {
      send: () => {
        throw new Error("unexpected-registry-rpc");
      },
      onMessage: () => ({ dispose() {} }),
    },
    { signal: lifetime.signal },
  );
  if (!(services instanceof RemoteServiceAccess)) throw new Error("unexpected-accessor-type");
  return {
    services,
    descriptor: {
      bridgeSessionId: `mobile-registry-${generation}`,
      bridgeGeneration: generation,
      workspaceKey: "remote:mobile-registry",
      workspaceIdentity: "remote:mobile-registry",
      workspacePath: "/project-fixture",
      remoteSessionId,
      kind: "remote",
      entryKind: "task",
    },
    generation,
    isCurrent: () => true,
  };
}

afterEach(() => {
  unregisterRemoteWorkspaceSession(remoteSessionId);
  registerBaseWorkspaceServices(null);
  for (const lifetime of lifetimes.splice(0)) lifetime.abort();
});

describe("mobile shared Root registry ownership", () => {
  it("registers the exact ready accessor before consumers render and releases only its own instance", () => {
    const first = access(1);
    const releaseFirst = registerMobileRootWorkspace(first);
    expect(getRegisteredBaseWorkspaceServices()).toBe(first.services);
    expect(getRemoteWorkspaceServicesForIdentity(first.descriptor.workspaceIdentity!)).toBe(
      first.services,
    );
    expect(getRemoteWorkspaceSession(remoteSessionId)?.dispose).toBeUndefined();
    const second = access(2);
    const releaseSecond = registerMobileRootWorkspace(second);
    releaseFirst();
    releaseFirst();
    expect(getRegisteredBaseWorkspaceServices()).toBe(second.services);
    expect(getRemoteWorkspaceServicesForIdentity(second.descriptor.workspaceIdentity!)).toBe(
      second.services,
    );
    releaseSecond();
    expect(getRegisteredBaseWorkspaceServices()).toBeNull();
    expect(getRemoteWorkspaceServicesForIdentity(second.descriptor.workspaceIdentity!)).toBeNull();
  });

  it("does not register stale or incomplete remote scopes", () => {
    const ready = access(1);
    const release = registerMobileRootWorkspace(ready);
    expect(() => registerMobileRootWorkspace({ ...access(2), isCurrent: () => false })).toThrow();
    expect(() =>
      registerMobileRootWorkspace({
        ...access(3),
        descriptor: { ...ready.descriptor, workspaceIdentity: undefined },
      }),
    ).toThrow();
    expect(getRegisteredBaseWorkspaceServices()).toBe(ready.services);
    expect(getRemoteWorkspaceSession(remoteSessionId)?.services).toBe(ready.services);
    release();
  });
});
