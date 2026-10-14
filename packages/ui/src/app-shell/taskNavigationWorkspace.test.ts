import { describe, expect, it } from "vitest";
import { createTabStore } from "@/store/tabStore.js";
import {
  ensureTaskNavigationWorkspace,
  findTaskNavigationWorkspaceTab,
} from "./taskNavigationWorkspace.js";

describe("ensureTaskNavigationWorkspace with the real tab store", () => {
  const workspacePath = "/workspace";
  const remoteOptions = {
    workspaceIdentity: "remote-host:/workspace",
    remoteSessionId: "remote-session",
  };

  function navigate(store: ReturnType<typeof createTabStore>, workspaceIdentity?: string) {
    return ensureTaskNavigationWorkspace({
      workspacePath,
      workspaceIdentity,
      activateTabByPath: store.getState().activateTabByPath,
      addLocalWorkspaceTab: (path) => store.getState().addTab(path),
    });
  }

  it("opens a local tab when only a same-path remote tab exists", () => {
    const store = createTabStore(null);
    const remoteId = store.getState().addTab(workspacePath, remoteOptions);
    expect(navigate(store)).toEqual({ accepted: true, openedLocalTab: true });
    expect(store.getState().tabs).toHaveLength(2);
    expect(store.getState().activeTabId).not.toBe(remoteId);
    expect(store.getState().activeWorkspaceIdentity).toBeNull();
    const localId = store.getState().activeTabId;
    expect(store.getState().addTab(workspacePath)).toBe(localId);
    expect(store.getState().tabs).toHaveLength(2);
  });

  it("activates the local tab even when the same-path remote tab comes first", () => {
    const store = createTabStore(null);
    const localId = store.getState().addTab(workspacePath);
    store.getState().addTab(workspacePath, remoteOptions);
    expect(navigate(store)).toEqual({ accepted: true, openedLocalTab: false });
    expect(store.getState().activeTabId).toBe(localId);
    expect(store.getState().activeWorkspaceIdentity).toBeNull();
  });

  it("activates a trimmed remote identity and refuses a missing attachment", () => {
    const store = createTabStore(null);
    const remoteId = store.getState().addTab(workspacePath, remoteOptions);
    store.getState().addTab(workspacePath);
    expect(navigate(store, ` ${remoteOptions.workspaceIdentity} `).accepted).toBe(true);
    expect(store.getState().activeTabId).toBe(remoteId);
    expect(navigate(store, "other-host:/workspace")).toEqual({
      accepted: false,
      reason: "remote_attachment_missing",
    });
    expect(store.getState().activeTabId).toBe(remoteId);
    expect(store.getState().tabs).toHaveLength(2);
  });

  it("keeps old session-only remote tabs addressable by their exact tab id", () => {
    const store = createTabStore(null);
    store.getState().restoreTabs([{ workspacePath, remoteSessionId: "legacy-remote" }], 0);
    const remoteId = store.getState().activeTabId!;
    const localId = store.getState().addTab(workspacePath);
    expect(store.getState().activateTabByPath(workspacePath)).toBe(true);
    expect(store.getState().activeTabId).toBe(localId);
    store.getState().activateTab(remoteId);
    expect(store.getState().activeTabId).toBe(remoteId);
    expect(store.getState().tabs).toHaveLength(2);
  });

  it("refuses missing explicit remote attachments instead of adding a local tab", () => {
    const store = createTabStore(null);
    const localId = store.getState().addTab(workspacePath);
    expect(
      ensureTaskNavigationWorkspace({
        workspacePath,
        remoteSessionId: "missing-remote",
        activateTabByPath: (_path, options) => {
          expect(options).toEqual({
            workspaceIdentity: undefined,
            remoteSessionId: "missing-remote",
          });
          return false;
        },
        addLocalWorkspaceTab: (path) => store.getState().addTab(path),
      }),
    ).toEqual({ accepted: false, reason: "remote_attachment_missing" });
    expect(store.getState().tabs).toHaveLength(1);
    expect(store.getState().activeTabId).toBe(localId);
  });

  it("activates an explicit legacy attachment without creating a local workspace", () => {
    const store = createTabStore(null);
    store.getState().restoreTabs([{ workspacePath, remoteSessionId: "legacy-remote" }], 0);
    const remoteId = store.getState().activeTabId!;
    const localId = store.getState().addTab(workspacePath);
    expect(store.getState().activeTabId).toBe(localId);
    expect(
      ensureTaskNavigationWorkspace({
        workspacePath,
        remoteSessionId: "legacy-remote",
        activateTabByPath: (path, options) => {
          const targetTab = findTaskNavigationWorkspaceTab(
            store.getState().tabs.filter((tab) => tab.kind === "workspace"),
            { workspacePath: path, ...options },
          );
          if (!targetTab) return false;
          store.getState().activateTab(targetTab.id);
          return true;
        },
        addLocalWorkspaceTab: (path) => store.getState().addTab(path),
      }),
    ).toEqual({ accepted: true, openedLocalTab: false });
    expect(store.getState().activeTabId).toBe(remoteId);
    expect(store.getState().tabs).toHaveLength(2);
  });
});

describe("findTaskNavigationWorkspaceTab", () => {
  const remote = {
    workspacePath: "/workspace",
    workspaceIdentity: "remote-host:/workspace",
    remoteSessionId: "remote-session",
  };
  const local = { workspacePath: "/workspace" };

  it("does not borrow the remote attachment for a same-path local conversation", () => {
    expect(findTaskNavigationWorkspaceTab([remote, local], local)).toBe(local);
    expect(findTaskNavigationWorkspaceTab([remote], local)).toBeUndefined();
  });

  it("resolves a remote target only by its exact identity", () => {
    expect(findTaskNavigationWorkspaceTab([local, remote], remote)).toBe(remote);
    expect(
      findTaskNavigationWorkspaceTab([remote], {
        workspacePath: "/workspace",
        workspaceIdentity: "another-host:/workspace",
      }),
    ).toBeUndefined();
  });

  it("uses the shared identity trim and local path fallback rules", () => {
    expect(
      findTaskNavigationWorkspaceTab([remote], {
        workspacePath: "/workspace",
        workspaceIdentity: ` ${remote.workspaceIdentity} `,
      }),
    ).toBe(remote);
    expect(
      findTaskNavigationWorkspaceTab([remote, local], {
        workspacePath: "/workspace",
        workspaceIdentity: " ",
      }),
    ).toBe(local);
  });

  it("rejects legacy attachment-only and target-only remote tabs for local requests", () => {
    const legacyRemote = { workspacePath: local.workspacePath, remoteSessionId: "legacy-remote" };
    const targetOnlyRemote = { workspacePath: local.workspacePath, remoteTarget: { kind: "ssh" } };
    expect(findTaskNavigationWorkspaceTab([legacyRemote, targetOnlyRemote, local], local)).toBe(
      local,
    );
    expect(findTaskNavigationWorkspaceTab([legacyRemote, targetOnlyRemote], local)).toBeUndefined();
  });

  it("keeps a legacy remote tab addressable by its explicit attachment", () => {
    const legacyRemote = { workspacePath: local.workspacePath, remoteSessionId: "legacy-remote" };
    expect(findTaskNavigationWorkspaceTab([local, legacyRemote], legacyRemote)).toBe(legacyRemote);
    expect(
      findTaskNavigationWorkspaceTab([local, legacyRemote], {
        workspacePath: local.workspacePath,
        remoteSessionId: "missing-remote",
      }),
    ).toBeUndefined();
  });

  it("rejects a stale attachment even when its workspace identity matches", () => {
    expect(
      findTaskNavigationWorkspaceTab([remote], {
        ...remote,
        remoteSessionId: "previous-connection",
      }),
    ).toBeUndefined();
    expect(findTaskNavigationWorkspaceTab([remote], remote)).toBe(remote);
  });

  it("uses stable remote identity across canonical path spellings", () => {
    expect(
      findTaskNavigationWorkspaceTab([local, remote], {
        workspacePath: "/alias-to-workspace",
        workspaceIdentity: ` ${remote.workspaceIdentity} `,
      }),
    ).toBe(remote);
  });
});
