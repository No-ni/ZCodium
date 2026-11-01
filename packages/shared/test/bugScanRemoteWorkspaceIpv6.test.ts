import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRemoteWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  isRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
} from "../src/remote-workspace-identity.js";
import type { RemoteTarget } from "../src/remoteTarget.js";

for (const host of ["::1", "2001:db8::5", "[2001:db8::5]", "fe80::1%eth0"]) {
  test(`SSH IPv6 identity restores its path for ${host}`, () => {
    const identity = buildRemoteWorkspaceIdentity("/workspace/a:b/c:d", {
      kind: "ssh",
      host,
      port: 2222,
      username: "fixture-user",
    });
    assert.deepEqual(parseRemoteWorkspaceIdentity(identity), {
      kind: "ssh",
      workspacePath: "/workspace/a:b/c:d",
    });
    assert.equal(isRemoteWorkspaceIdentity(identity), true);
  });
}

test("SSH IPv6 root and default port retain the stored identity format", () => {
  const identity = buildRemoteWorkspaceIdentity("/", {
    kind: "ssh",
    host: "::1",
    username: "fixture-user",
  });
  assert.equal(identity, "remote:ssh:::1:22:fixture-user:/");
  assert.deepEqual(parseRemoteWorkspaceIdentity(identity), { kind: "ssh", workspacePath: "/" });
});

test("SSH unspecified IPv6 address round-trips without losing its colon-only host", () => {
  const identity = buildRemoteWorkspaceIdentity("/workspace/a:b/c:d", {
    kind: "ssh",
    host: "::",
    port: 2222,
    username: "fixture-user",
  });
  assert.equal(identity, "remote:ssh::::2222:fixture-user:/workspace/a:b/c:d");
  assert.deepEqual(parseRemoteWorkspaceIdentity(identity), {
    kind: "ssh",
    workspacePath: "/workspace/a:b/c:d",
  });
  assert.equal(isRemoteWorkspaceIdentity(identity), true);
});

for (const [kind, target] of [
  ["ssh", { kind: "ssh", host: "EXAMPLE.TEST", username: "fixture-user" }],
  ["ssh", { kind: "ssh", host: "192.0.2.5", port: 2222, username: "fixture-user" }],
  ["wsl", { kind: "wsl", distro: "Fixture" }],
  ["wsl", { kind: "wsl", distro: "Fixture", user: "fixture-user" }],
  ["docker", { kind: "docker", container: "fixture-container" }],
] as const satisfies readonly (readonly [string, RemoteTarget])[]) {
  test(`${kind} existing identity format retains path colons: ${JSON.stringify(target)}`, () => {
    const identity = buildRemoteWorkspaceIdentity("/workspace/a:b/c:d", target);
    assert.deepEqual(parseRemoteWorkspaceIdentity(identity), {
      kind,
      workspacePath: "/workspace/a:b/c:d",
    });
  });
}

test("Source Server identity preserves its authenticated source and complete path", () => {
  const identity = buildServerRemoteWorkspaceIdentity({
    serverId: "fixture-source",
    workspacePath: "/workspace/a:b/c:d",
  });
  assert.deepEqual(parseRemoteWorkspaceIdentity(identity), {
    kind: "server",
    serverId: "fixture-source",
    workspacePath: "/workspace/a:b/c:d",
  });
});

for (const identity of [
  "remote:ssh::22:user:/workspace",
  "remote:ssh:example.test::user:/workspace",
  "remote:ssh:example.test:22::/workspace",
  "remote:ssh:example.test:22:user:workspace",
  "remote:ssh:example.test:22:/workspace",
  "remote:ssh:example.test:/workspace",
  "remote:unknown:target:/workspace",
  "remote:server:invalid.source:/workspace",
  "/workspace",
]) {
  test(`incomplete identity remains rejected: ${identity}`, () => {
    assert.equal(parseRemoteWorkspaceIdentity(identity), null);
  });
}
