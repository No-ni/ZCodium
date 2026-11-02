import assert from "node:assert/strict";
import test from "node:test";
import { getRemoteIdentityConfirmation } from "../../packages/ui/src/remote-connection-flow/identityConfirmation.ts";
import {
  resolveRemoteConnectionPhases,
  resolveRemoteOperationProgress,
} from "../../packages/ui/src/remote-connection-flow/connectionPhases.ts";

function fixture() {
  const profile = {
    profileId: "profile",
    generation: 2,
    displayName: "Fixture",
    target: { kind: "docker", container: "fixture" },
    configurationMode: "target",
    createdAt: 1,
  };
  const state = {
    profileId: "profile",
    generation: 2,
    state: "identity-change-pending",
    pendingSourceServerId: "new-source",
    updatedAt: 2,
  };
  return {
    directory: { schemaVersion: 1, generation: 4, profiles: [profile], servers: [] },
    states: [state],
  };
}

test("identity approval binds current profile generation and pending source ID", () => {
  assert.deepEqual(
    getRemoteIdentityConfirmation(fixture(), { kind: "docker", container: "fixture" }, "profile"),
    { profileId: "profile", generation: 2, expectedSourceServerId: "new-source" },
  );
});

test("edited routes and old connection state cannot receive identity approval", () => {
  const snapshot = fixture();
  assert.equal(
    getRemoteIdentityConfirmation(snapshot, { kind: "docker", container: "other" }, "profile"),
    null,
  );
  assert.equal(
    getRemoteIdentityConfirmation(
      snapshot,
      { kind: "docker", container: "fixture" },
      "other-profile",
    ),
    null,
  );
  snapshot.states[0].generation = 1;
  assert.equal(
    getRemoteIdentityConfirmation(snapshot, { kind: "docker", container: "fixture" }, "profile"),
    null,
  );
});

test("nonpending, missing identity and direct Server routes never authorize a source change", () => {
  const snapshot = fixture();
  assert.equal(
    getRemoteIdentityConfirmation(snapshot, { kind: "server", url: "http://127.0.0.1" }),
    null,
  );
  snapshot.states[0].pendingSourceServerId = undefined;
  assert.equal(
    getRemoteIdentityConfirmation(snapshot, { kind: "docker", container: "fixture" }),
    null,
  );
  snapshot.states[0].pendingSourceServerId = "new-source";
  snapshot.states[0].state = "online";
  assert.equal(
    getRemoteIdentityConfirmation(snapshot, { kind: "docker", container: "fixture" }),
    null,
  );
});

test("predeployed connection phases finish on session ready and keep directory handoff separate", () => {
  const logs = [{ message: "[source-server:publish-online] ready", level: "info" }];
  assert.deepEqual(
    resolveRemoteConnectionPhases(logs).map((phase) => phase.status),
    ["complete", "complete", "complete"],
  );
  const opening = resolveRemoteConnectionPhases(logs, { includeWorkspace: true });
  assert.equal(opening.at(-1).status, "pending");
  assert.equal(opening[2].status, "active");
  assert.equal(
    resolveRemoteConnectionPhases(logs, { includeWorkspace: true, connectionReady: true }).every(
      (phase) => phase.status === "complete",
    ),
    true,
  );
  const failed = resolveRemoteConnectionPhases(
    [...logs, { message: "[source-server:workspace] unavailable", level: "error" }],
    { includeWorkspace: true, connectionReady: true },
  );
  assert.equal(failed.at(-1).status, "failed");
  assert.equal(
    failed.some((phase) => phase.key === "deploy"),
    false,
  );
});

test("historical deploy logs cannot introduce deployment steps or revive completed progress", () => {
  assert.equal(
    resolveRemoteConnectionPhases([
      { message: "[source-server:download] archive", level: "info" },
    ]).every((phase) => phase.status === "pending"),
    true,
  );
  const logs = [{ phase: "protocol-handshake", level: "info", timestamp: 10 }];
  assert.deepEqual(resolveRemoteOperationProgress(logs), {
    index: 2,
    total: 3,
    titleId: "remote.phase.handshake",
    startedAt: 10,
  });
  assert.equal(
    resolveRemoteOperationProgress([...logs, { phase: "ready", level: "info", timestamp: 20 }])
      .startedAt,
    undefined,
  );
  assert.equal(
    resolveRemoteOperationProgress([
      ...logs,
      { phase: "protocol-handshake", level: "error", timestamp: 20 },
    ]).startedAt,
    undefined,
  );
});
