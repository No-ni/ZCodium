import { describe, expect, it } from "vitest";
import type { WebRemoteControlBootstrapResult } from "@zcode/shared";
import { mergeMobileWindowDirectory } from "./windowDirectoryPresentation.js";

const bootstrap = {
  windowControlSessionId: "fixture",
  desktopAppVersion: "3.15.1",
  tasks: [],
  workspaces: [
    {
      workspaceKey: "remote:server:a:/app",
      workspacePath: "/app",
      workspaceIdentity: "remote:server:a:/app",
      remoteSessionId: "remote-a",
      kind: "remote",
    },
  ],
} satisfies WebRemoteControlBootstrapResult;
describe("mobile Window directory presentation", () => {
  it("enriches only the already-authorized exact attachment identity", () => {
    const merged = mergeMobileWindowDirectory(bootstrap, {
      version: 1,
      generation: 1,
      workspaces: [
        { ...bootstrap.workspaces[0]!, label: "Window route", connectionState: "disconnected" },
        { workspaceKey: "/another", workspacePath: "/another", kind: "local" },
      ],
    });
    expect(merged.workspaces).toHaveLength(1);
    expect(merged.workspaces[0]).toMatchObject({
      label: "Window route",
      connectionState: "disconnected",
    });
    expect(bootstrap.workspaces[0]).not.toHaveProperty("label");
  });
  it("does not rebind a stale or same-path different Source directory entry", () => {
    for (const changed of [
      { remoteSessionId: "remote-b" },
      { workspaceIdentity: "remote:server:b:/app" },
      { workspacePath: "/other" },
    ]) {
      const merged = mergeMobileWindowDirectory(bootstrap, {
        version: 1,
        generation: 2,
        workspaces: [{ ...bootstrap.workspaces[0]!, ...changed, label: "Unrelated" }],
      });
      expect(merged.workspaces[0]).toBe(bootstrap.workspaces[0]);
    }
  });
});
