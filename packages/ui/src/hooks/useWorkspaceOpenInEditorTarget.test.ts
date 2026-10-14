import { describe, expect, it } from "vitest";
import { resolveWorkspaceOpenInEditorTarget } from "./useWorkspaceOpenInEditorTarget.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

const local = {
  id: "local",
  kind: "workspace",
  label: "local",
  workspacePath: "/repo",
} as WorkspaceTabState;
const remote = {
  ...local,
  id: "remote",
  remoteSessionId: "host-B",
  workspaceIdentity: "remote-B:/repo",
  remoteTarget: { kind: "wsl", distro: "Ubuntu" },
} as WorkspaceTabState;

describe("file editor targets use the frozen source identity", () => {
  it("keeps local editor actions local beside an identical remote path", () => {
    for (const tabs of [[local, remote], [remote]]) {
      expect(resolveWorkspaceOpenInEditorTarget(tabs, { workspacePath: "/repo" })).toEqual({
        isRemoteWorkspace: false,
        remoteTarget: undefined,
      });
    }
  });
  it("keeps target-only remote tabs out of local exact matches and preserves ambient legacy previews", () => {
    const targetOnly = { ...remote, workspaceIdentity: undefined, remoteSessionId: undefined };
    expect(resolveWorkspaceOpenInEditorTarget([targetOnly], { workspacePath: "/repo" })).toEqual({
      isRemoteWorkspace: false,
      remoteTarget: undefined,
    });
    expect(
      resolveWorkspaceOpenInEditorTarget([targetOnly], {
        workspacePath: "/repo",
        scopeResolution: "ambient",
      }).remoteTarget,
    ).toEqual({ kind: "wsl", distro: "Ubuntu" });
    expect(
      resolveWorkspaceOpenInEditorTarget([remote], {
        workspacePath: "/repo",
        scopeResolution: "ambient",
      }).remoteTarget,
    ).toEqual({ kind: "wsl", distro: "Ubuntu" });
  });
  it("resolves the exact remote target and supports old session-only tabs", () => {
    expect(
      resolveWorkspaceOpenInEditorTarget([local, remote], {
        workspacePath: "/repo",
        workspaceIdentity: remote.workspaceIdentity,
        workspaceRemoteSessionId: "host-B",
      }).remoteTarget,
    ).toEqual({ kind: "wsl", distro: "Ubuntu" });
    expect(
      resolveWorkspaceOpenInEditorTarget([{ ...remote, workspaceIdentity: undefined }], {
        workspacePath: "/repo",
        workspaceRemoteSessionId: "host-B",
      }).remoteTarget,
    ).toEqual({ kind: "wsl", distro: "Ubuntu" });
  });
  it("missing or mismatched remote targets remain remote and cannot fall back locally", () => {
    for (const tabs of [
      [],
      [local],
      [{ ...remote, remoteTarget: undefined }],
      [{ ...remote, remoteSessionId: "host-A" }],
    ]) {
      expect(
        resolveWorkspaceOpenInEditorTarget(tabs, {
          workspacePath: "/repo",
          workspaceIdentity: remote.workspaceIdentity,
          workspaceRemoteSessionId: "host-B",
        }),
      ).toEqual({ isRemoteWorkspace: true, remoteTarget: undefined });
    }
  });
});
