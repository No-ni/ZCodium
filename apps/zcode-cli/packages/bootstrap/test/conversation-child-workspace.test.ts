import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { ConversationV4Gateway, type V4GatewayHost } from "../src/zcode-protocol-v4/v4-gateway.js";

function createEvent(
  sessionId: string,
  type: SessionEvent["type"],
  payload: unknown,
): SessionEvent {
  const nextSequence = (sequenceBySession.get(sessionId) ?? 0) + 1;
  sequenceBySession.set(sessionId, nextSequence);
  return {
    id: randomUUID(),
    sessionId,
    turnId: `turn-${sessionId}`,
    type,
    payload,
    timestamp: new Date(),
    sequenceNumber: nextSequence,
  } as SessionEvent;
}

const sequenceBySession = new Map<string, number>();

function turnStarted(sessionId: string): SessionEvent {
  return createEvent(sessionId, SessionEventType.TurnStarted, { inputId: `input-${sessionId}` });
}

function subagentSpawned(
  parentSessionId: string,
  childSessionId: string,
  childExecutionWorkspacePath: string,
): SessionEvent {
  return createEvent(parentSessionId, SessionEventType.SubagentSpawned, {
    childSessionId,
    childExecutionWorkspacePath,
  });
}

function snapshotWorkspacePath(
  dispatch: Awaited<ReturnType<ConversationV4Gateway["subscribe"]>>,
): string | undefined {
  const frame = dispatch.initialFrame;
  assert.ok(frame, "subscribe should return an initial frame");
  if (frame.payload.kind !== "snapshot") {
    assert.fail(`expected initial snapshot, received ${frame.payload.kind}`);
  }
  return frame.payload.snapshot.workspacePath;
}

async function subscribe(gateway: ConversationV4Gateway, sessionId: string, connectionId: string) {
  return gateway.subscribe({
    topic: `conversation/${sessionId}`,
    connectionId,
    clientMode: "desktop-continuous",
  });
}

test("detached child snapshots use spawn cwd, late paths, and persisted child cwd", async () => {
  const parentSessionId = "parent-conversation";
  const firstChildId = "child-spawn-before-subscribe";
  const subscribedChildId = "child-subscribe-before-spawn";
  const coldChildId = "child-cold-record";
  const projectParentId = "project-parent";
  const projectChildId = "project-child";
  const parentWorkspacePath = resolve("workspace", "2026-10-13", "parent01");
  const firstChildWorkspacePath = resolve(parentWorkspacePath, "nested");
  const subscribedChildWorkspacePath = resolve(parentWorkspacePath, "nested-late");
  const coldCapturedPath = resolve(parentWorkspacePath, "nested-cold");
  const coldPersistedPath = resolve(parentWorkspacePath, "nested-cold", "deeper");
  const workspacePaths = new Map([[parentSessionId, parentWorkspacePath]]);
  const activeSessions = new Set([parentSessionId]);

  const host = {
    sessionExists: (sessionId: string) => activeSessions.has(sessionId),
    emitWireFrame: () => {},
    getSessionWorkspacePath: (sessionId: string) => workspacePaths.get(sessionId) ?? null,
    resumePersistedSession: async (sessionId: string) => {
      if (sessionId !== coldChildId) return { status: "notFound" as const };
      workspacePaths.set(sessionId, coldPersistedPath);
      activeSessions.add(sessionId);
      return { status: "resumed" as const };
    },
  } as V4GatewayHost;
  const gateway = new ConversationV4Gateway(host);

  try {
    const actorId = "workflow-actor-without-spawn";
    gateway.ingestDetachedLiveSession(
      actorId,
      turnStarted(actorId),
      parentSessionId,
      firstChildWorkspacePath,
    );
    assert.equal(
      snapshotWorkspacePath(await subscribe(gateway, actorId, "actor-first")),
      firstChildWorkspacePath,
    );
    gateway.ingestDetachedLiveSession(
      actorId,
      turnStarted(actorId),
      parentSessionId,
      coldPersistedPath,
    );
    assert.equal(
      snapshotWorkspacePath(await subscribe(gateway, actorId, "actor-cd")),
      firstChildWorkspacePath,
    );
    gateway.ingestDetachedLiveSession(
      actorId,
      createEvent(actorId, SessionEventType.SessionResumed, {
        directory: coldPersistedPath,
        interruptedToolCount: 0,
        messageCount: 0,
        partCount: 0,
      }),
      parentSessionId,
      coldPersistedPath,
    );
    assert.equal(
      snapshotWorkspacePath(await subscribe(gateway, actorId, "actor-resume")),
      coldPersistedPath,
    );
    const projectActorId = "project-actor-without-spawn";
    gateway.ingestDetachedLiveSession(
      projectActorId,
      turnStarted(projectActorId),
      projectParentId,
      firstChildWorkspacePath,
    );
    assert.equal(
      snapshotWorkspacePath(await subscribe(gateway, projectActorId, "project-actor")),
      undefined,
    );

    gateway.ingest(
      parentSessionId,
      subagentSpawned(parentSessionId, firstChildId, firstChildWorkspacePath),
    );
    gateway.ingestDetachedLiveSession(firstChildId, turnStarted(firstChildId));
    assert.equal(
      snapshotWorkspacePath(await subscribe(gateway, firstChildId, "first-child")),
      firstChildWorkspacePath,
      "the first child snapshot uses its deeper spawn cwd rather than the parent leaf",
    );

    gateway.ingestDetachedLiveSession(firstChildId, turnStarted(firstChildId), parentSessionId);
    assert.equal(
      snapshotWorkspacePath(await subscribe(gateway, firstChildId, "first-child-late-parent")),
      firstChildWorkspacePath,
      "a later parent mapping must not replace the captured child cwd",
    );

    gateway.ingestDetachedLiveSession(
      subscribedChildId,
      turnStarted(subscribedChildId),
      parentSessionId,
    );
    assert.equal(
      snapshotWorkspacePath(await subscribe(gateway, subscribedChildId, "early-child")),
      parentWorkspacePath,
    );
    gateway.ingest(
      parentSessionId,
      subagentSpawned(parentSessionId, subscribedChildId, subscribedChildWorkspacePath),
    );
    assert.equal(
      snapshotWorkspacePath(await subscribe(gateway, subscribedChildId, "late-child-path")),
      subscribedChildWorkspacePath,
      "a child subscribed before its parent spawn is reseeded when the spawn arrives",
    );

    gateway.ingest(
      parentSessionId,
      subagentSpawned(parentSessionId, coldChildId, coldCapturedPath),
    );
    assert.equal(
      snapshotWorkspacePath(await subscribe(gateway, coldChildId, "cold-child")),
      coldPersistedPath,
      "a cold child record's own persisted cwd outranks the spawn-time fallback",
    );

    gateway.disposeSession(parentSessionId);
    gateway.ingestDetachedLiveSession(subscribedChildId, turnStarted(subscribedChildId));
    assert.equal(
      snapshotWorkspacePath(await subscribe(gateway, subscribedChildId, "after-parent-cleanup")),
      undefined,
      "a fresh child publisher after parent cleanup does not retain the captured cwd",
    );
  } finally {
    gateway.dispose();
    sequenceBySession.clear();
  }

  const projectGateway = new ConversationV4Gateway({
    sessionExists: (sessionId: string) => sessionId === projectParentId,
    emitWireFrame: () => {},
    getSessionWorkspacePath: () => null,
  } as V4GatewayHost);
  try {
    projectGateway.ingest(
      projectParentId,
      subagentSpawned(projectParentId, projectChildId, resolve("project", "nested")),
    );
    projectGateway.ingestDetachedLiveSession(projectChildId, turnStarted(projectChildId));
    assert.equal(
      snapshotWorkspacePath(await subscribe(projectGateway, projectChildId, "project-child")),
      undefined,
      "project parents without an independent cwd keep the legacy absent snapshot field",
    );
  } finally {
    projectGateway.dispose();
    sequenceBySession.clear();
  }
});
