import { describe, expect, it } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import {
  createWorkspaceTerminalState,
  retainOpenTerminalWorkspaceStates,
  resolveTerminalWorkspaceScopeKey,
  type TerminalPanelState,
} from "./terminalPanelState.js";

const OWNER_KEY = "/Users/me/.zcodium/workspace/default";
const WORKSPACE_PATH = OWNER_KEY;
const SESSION_A_PATH = `${OWNER_KEY}/2026-10-11/aaaaaaaa`;
const SESSION_B_PATH = `${OWNER_KEY}/2026-10-11/bbbbbbbb`;
const services = {} as IServiceAccessor;

describe("terminal workspace scope", () => {
  it("does not select or create a task terminal before its snapshot confirms the cwd", () => {
    expect(
      resolveTerminalWorkspaceScopeKey({
        workspaceOwnerKey: OWNER_KEY,
        workspacePath: WORKSPACE_PATH,
        sessionId: "task-a",
        sessionWorkspacePath: null,
        sessionWorkspacePathReady: false,
        isLocalWorkspace: true,
      }),
    ).toBeNull();
  });

  it("gives each confirmed local execution directory its own group", () => {
    const firstKey = resolveTerminalWorkspaceScopeKey({
      workspaceOwnerKey: OWNER_KEY,
      workspacePath: WORKSPACE_PATH,
      sessionId: "task-a",
      sessionWorkspacePath: SESSION_A_PATH,
      sessionWorkspacePathReady: true,
      isLocalWorkspace: true,
    });
    const secondKey = resolveTerminalWorkspaceScopeKey({
      workspaceOwnerKey: OWNER_KEY,
      workspacePath: WORKSPACE_PATH,
      sessionId: "task-b",
      sessionWorkspacePath: SESSION_B_PATH,
      sessionWorkspacePathReady: true,
      isLocalWorkspace: true,
    });

    expect(firstKey).not.toBe(secondKey);
    expect(firstKey).toBe(JSON.stringify([OWNER_KEY, "task-a"]));
  });

  it("keeps project and remote workspaces on the identity root group", () => {
    expect(
      resolveTerminalWorkspaceScopeKey({
        workspaceOwnerKey: "workspace-identity",
        workspacePath: WORKSPACE_PATH,
        sessionId: "remote-task",
        sessionWorkspacePath: SESSION_A_PATH,
        sessionWorkspacePathReady: true,
        isLocalWorkspace: false,
      }),
    ).toBe("workspace-identity");

    expect(
      resolveTerminalWorkspaceScopeKey({
        workspaceOwnerKey: OWNER_KEY,
        workspacePath: WORKSPACE_PATH,
        sessionId: "project-task",
        sessionWorkspacePath: WORKSPACE_PATH,
        sessionWorkspacePathReady: true,
        isLocalWorkspace: true,
      }),
    ).toBe(OWNER_KEY);
  });
});

describe("retainOpenTerminalWorkspaceStates", () => {
  function stateWithTwoTaskGroups(): TerminalPanelState {
    const first = createWorkspaceTerminalState({
      workspaceKey: JSON.stringify([OWNER_KEY, "task-a"]),
      ownerWorkspaceKey: OWNER_KEY,
      services,
      cwd: SESSION_A_PATH,
    });
    const second = createWorkspaceTerminalState({
      workspaceKey: JSON.stringify([OWNER_KEY, "task-b"]),
      ownerWorkspaceKey: OWNER_KEY,
      services,
      cwd: SESSION_B_PATH,
    });

    return {
      sessions: {
        [first.session.id]: first.session,
        [second.session.id]: second.session,
      },
      workspaces: {
        [first.session.workspaceKey]: first.workspace,
        [second.session.workspaceKey]: second.workspace,
      },
    };
  }

  it("retains hidden task PTYs while their workspace stays open, then reclaims both on close", () => {
    const original = stateWithTwoTaskGroups();
    const retained = retainOpenTerminalWorkspaceStates(original, [OWNER_KEY], OWNER_KEY);

    expect(Object.keys(retained.workspaces)).toHaveLength(2);
    expect(
      Object.values(retained.sessions)
        .map((session) => session.cwd)
        .sort(),
    ).toEqual([SESSION_A_PATH, SESSION_B_PATH].sort());
    expect(
      Object.values(retained.sessions).every((session) => session.ownerWorkspaceKey === OWNER_KEY),
    ).toBe(true);

    const closed = retainOpenTerminalWorkspaceStates(retained, [], "/another/workspace");
    expect(closed.workspaces).toEqual({});
    expect(closed.sessions).toEqual({});
  });
});
