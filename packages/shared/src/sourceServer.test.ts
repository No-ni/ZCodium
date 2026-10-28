import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildServerRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
} from "./remote-workspace-identity.js";
import {
  sourceServerDirectorySchema,
  evaluateSourceServerCompatibility,
} from "./source-server/index.js";

test("stable Source identity is independent of route and isolates identical paths", () => {
  const first = buildServerRemoteWorkspaceIdentity({
    serverId: "source-a",
    workspacePath: "/workspace/app",
  });
  assert.equal(first, "remote:server:source-a:/workspace/app");
  assert.notEqual(
    first,
    buildServerRemoteWorkspaceIdentity({ serverId: "source-b", workspacePath: "/workspace/app" }),
  );
  assert.deepEqual(parseRemoteWorkspaceIdentity(first), {
    kind: "server",
    serverId: "source-a",
    workspacePath: "/workspace/app",
  });
  assert.throws(() =>
    buildServerRemoteWorkspaceIdentity({ serverId: "invalid:id", workspacePath: "/app" }),
  );
});

test("Source profiles persist credential references, never credentials", () => {
  const profile = {
    profileId: "profile-a",
    generation: 1,
    displayName: "Route A",
    target: {
      kind: "ssh",
      host: "example.invalid",
      username: "fixture",
      passwordCredentialKey: "connection-profile:profile-a:password",
    },
    configurationMode: "target",
    createdAt: 1,
  };
  const directory = { schemaVersion: 1, generation: 1, profiles: [profile], servers: [] };
  assert.equal(
    sourceServerDirectorySchema.parse(directory).profiles[0]?.configurationMode,
    "target",
  );
  assert.equal(
    sourceServerDirectorySchema.safeParse({
      ...directory,
      profiles: [{ ...profile, target: { ...profile.target, password: "fixture-secret" } }],
    }).success,
    false,
  );
});

test("Source compatibility fails closed outside the mutual supported range", () => {
  const controller = {
    schemaVersion: 1 as const,
    productVersion: "3.16.2",
    minCompatibleVersion: "3.15.1",
  };
  const compatible = {
    schemaVersion: 1 as const,
    productVersion: "3.15.1",
    minCompatibleVersion: "3.15.1",
  };
  assert.equal(evaluateSourceServerCompatibility(controller, compatible).compatible, true);
  assert.equal(
    evaluateSourceServerCompatibility(controller, { ...compatible, minCompatibleVersion: "3.17.0" })
      .compatible,
    false,
  );
});
