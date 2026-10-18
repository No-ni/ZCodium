import { MessageChannelMain } from "electron";
import { HostMessageTypes } from "@zcode/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachWorkspaceHostPort } from "./hostBridge.js";
import type { WebRemoteControlLogger } from "./logger.js";

vi.mock("electron", () => ({ MessageChannelMain: vi.fn() }));

const logger: WebRemoteControlLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("attachWorkspaceHostPort", () => {
  beforeEach(() => {
    vi.mocked(MessageChannelMain).mockReset();
  });

  it("preserves the remote scope and replayable mode, then detaches the same attachment", () => {
    const port1 = { close: vi.fn() };
    const port2 = {};
    vi.mocked(MessageChannelMain).mockImplementation(function () {
      return { port1, port2 } as never;
    });

    const posted: Array<{ message: Record<string, unknown>; transfer?: unknown[] }> = [];
    const hostProcess = {
      postMessage(message: unknown, transfer?: unknown[]) {
        posted.push({ message: message as Record<string, unknown>, transfer });
      },
    };
    const attachment = attachWorkspaceHostPort({
      windowId: 17,
      webContentsId: 42,
      workspacePath: "C:/workspace/remote-project",
      workspaceIdentity: "identity-remote-project",
      remoteSessionId: "remote-session-1",
      resolveHostProcess: () => hostProcess,
      logger,
    });

    expect(posted).toHaveLength(1);
    const attachMessage = posted[0]!.message;
    expect(attachMessage).toMatchObject({
      type: HostMessageTypes.AttachServicePort,
      attachmentId: attachment.attachmentId,
      clientMode: "web-remote-replayable",
      scope: {
        kind: "remote",
        remoteSessionId: "remote-session-1",
        workspacePath: "C:/workspace/remote-project",
        workspaceIdentity: "identity-remote-project",
      },
    });
    expect(posted[0]!.transfer).toEqual([port2]);
    expect(port1.close).not.toHaveBeenCalled();

    attachment.dispose();

    expect(posted[1]).toEqual({
      message: {
        type: HostMessageTypes.DetachServicePort,
        attachmentId: attachment.attachmentId,
      },
      transfer: undefined,
    });
    expect(port1.close).toHaveBeenCalledTimes(1);
  });

  it("rejects a remote scope without identity before creating or sending an attachment", () => {
    const hostProcess = { postMessage: vi.fn() };

    expect(() =>
      attachWorkspaceHostPort({
        windowId: 17,
        webContentsId: 42,
        workspacePath: "C:/workspace/remote-project",
        remoteSessionId: "remote-session-1",
        resolveHostProcess: () => hostProcess,
        logger,
      }),
    ).toThrow("Remote web remote control attachment requires workspaceIdentity");

    expect(MessageChannelMain).not.toHaveBeenCalled();
    expect(hostProcess.postMessage).not.toHaveBeenCalled();
  });
});
