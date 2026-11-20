import { InternalChannels, type RemoteTarget } from "@zcode/shared";

export interface RemoteWorkspaceServicePortRegistration {
  attachmentId: string;
  port: MessagePort;
  sessionId: string;
  target: RemoteTarget;
  sourceServerId?: string;
}

export function parseRemoteWorkspaceServicePortMessage(
  event: MessageEvent,
): RemoteWorkspaceServicePortRegistration | null {
  if (
    typeof event.data !== "object" ||
    event.data === null ||
    !("type" in event.data) ||
    event.data.type !== InternalChannels.ScopedServicePort
  ) {
    return null;
  }
  const port = event.ports[0];
  const attachmentId = typeof event.data.attachmentId === "string" ? event.data.attachmentId : null;
  const sessionId = typeof event.data.sessionId === "string" ? event.data.sessionId : null;
  const target = "target" in event.data ? (event.data.target as RemoteTarget | null) : null;
  if (!port || !attachmentId || !sessionId || !target) return null;
  const sourceServerId =
    typeof event.data.sourceServerId === "string" ? event.data.sourceServerId : undefined;
  return { attachmentId, port, sessionId, target, ...(sourceServerId ? { sourceServerId } : {}) };
}

export function parseRemoteWorkspaceServicePortReleasedMessage(
  event: MessageEvent,
): Pick<RemoteWorkspaceServicePortRegistration, "attachmentId" | "sessionId"> | null {
  if (event.source !== window) return null;
  const data = event.data as {
    type?: unknown;
    attachmentId?: unknown;
    sessionId?: unknown;
  } | null;
  if (
    data?.type !== InternalChannels.ScopedServicePortReleased ||
    typeof data.attachmentId !== "string" ||
    typeof data.sessionId !== "string"
  ) {
    return null;
  }
  return { attachmentId: data.attachmentId, sessionId: data.sessionId };
}

export function notifyRemoteWorkspaceServicePortReady(
  payload: Pick<RemoteWorkspaceServicePortRegistration, "attachmentId" | "sessionId">,
  postMessage: (message: unknown, targetOrigin: string) => void = window.postMessage.bind(window),
): void {
  postMessage(
    {
      type: InternalChannels.ScopedServicePortReady,
      attachmentId: payload.attachmentId,
      sessionId: payload.sessionId,
    },
    "*",
  );
}
