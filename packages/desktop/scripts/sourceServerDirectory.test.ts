import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppSettings } from "@zcode/shared";
import { SourceServerDirectory } from "../src/host/sourceServerDirectory.js";

function fixture() {
  let settings = { recentProjects: [], locale: "en-US" } as AppSettings;
  const secrets = new Map<string, string>();
  const directory = new SourceServerDirectory({
    settingService: {
      get: async () => structuredClone(settings),
      update: async (patch) => {
        settings = { ...settings, ...structuredClone(patch) };
      },
    },
    credentialService: {
      load: async (key) => secrets.get(key) ?? null,
      save: async (key, value) => {
        secrets.set(key, value);
      },
      delete: async (key) => {
        secrets.delete(key);
      },
    },
    createId: () => "profile-a",
    now: () => 1,
  });
  return { directory, secrets };
}

test("Source identity changes and stale profile generations cannot silently rebind", async () => {
  const { directory } = fixture();
  const profile = await directory.ensureProfile({
    kind: "ssh",
    host: "example.invalid",
    username: "fixture",
  });
  await directory.recordHandshake(profile, { serverId: "source-a", version: "3.15.1" });
  const bound = (await directory.snapshot()).profiles[0]!;
  await assert.rejects(
    directory.recordHandshake(bound, { serverId: "source-b", version: "3.15.1" }),
    /identity/,
  );
  assert.equal((await directory.snapshot()).profiles[0]?.sourceServerId, "source-a");
  await directory.removeProfile(bound.profileId, bound.generation);
  await assert.rejects(
    directory.recordHandshake(bound, { serverId: "source-a", version: "3.15.1" }),
    /stale/,
  );
  assert.equal((await directory.snapshot()).profiles.length, 0);
});

test("confirmed Source identity advances the profile generation and clears the former route", async () => {
  const { directory } = fixture();
  const profile = await directory.ensureProfile({
    kind: "ssh",
    host: "example.invalid",
    username: "fixture",
  });
  const bound = await directory.recordHandshake(profile, {
    serverId: "source-a",
    version: "3.15.1",
  });
  await assert.rejects(
    directory.recordHandshake(
      bound,
      { serverId: "source-c", version: "3.15.1" },
      { expectedSourceServerId: "source-b" },
    ),
    /identity/,
  );
  const changed = await directory.recordHandshake(
    bound,
    { serverId: "source-b", version: "3.15.1" },
    { expectedSourceServerId: "source-b" },
  );
  assert.equal(changed.generation, bound.generation + 1);
  assert.equal(changed.sourceServerId, "source-b");
  assert.equal(
    (await directory.snapshot()).servers.find((server) => server.sourceServerId === "source-a")
      ?.preferredProfileId,
    undefined,
  );
  await assert.rejects(directory.assertCurrent(bound), /stale/);
});

test("removing a Source profile clears owned credentials and does not choose another route", async () => {
  const { directory, secrets } = fixture();
  const target = {
    kind: "ssh" as const,
    host: "example.invalid",
    username: "fixture",
    password: "fixture-secret",
  };
  const profile = await directory.ensureProfile(target);
  const bound = await directory.recordHandshake(
    profile,
    { serverId: "source-a", version: "3.15.1" },
    { authenticatedTarget: target },
  );
  await directory.removeProfile(bound.profileId, bound.generation);
  assert.equal(secrets.size, 0);
  assert.equal((await directory.snapshot()).servers[0]?.preferredProfileId, undefined);
});

test("changing a route never forwards its old password or accepts an injected credential reference", async () => {
  const { directory, secrets } = fixture();
  const target = {
    kind: "ssh" as const,
    host: "example.invalid",
    username: "fixture",
    password: "fixture-secret",
  };
  const initial = await directory.ensureProfile(target);
  const bound = await directory.recordHandshake(
    initial,
    { serverId: "source-a", version: "3.15.1" },
    { authenticatedTarget: target },
  );
  assert.equal(bound.target.kind, "ssh");
  if (bound.target.kind !== "ssh") throw new Error("Expected fixture SSH profile");
  await assert.rejects(
    directory.saveProfile({
      ...bound,
      target: { ...bound.target, passwordCredentialKey: "foreign-key" },
    }),
    /credential/,
  );
  const changed = await directory.saveProfile({
    ...bound,
    target: { ...bound.target, host: "other.example.invalid" },
  });
  const resolved = await directory.resolveTarget(changed);
  assert.equal(resolved.kind === "ssh" ? resolved.password : undefined, undefined);
  assert.equal(secrets.size, 0);
});

test("Directory change events carry the exact committed generation", async () => {
  const { directory } = fixture();
  const observed: unknown[] = [];
  const subscription = directory.onDidChange((snapshot) => observed.push(snapshot));
  await directory.ensureProfile({ kind: "docker", container: "fixture" });
  assert.deepEqual(observed, [await directory.snapshot()]);
  subscription.dispose();
});

test("Directory restores owned credentials when a settings commit fails", async () => {
  let settings = {} as AppSettings;
  let fail = false;
  const secrets = new Map<string, string>();
  const directory = new SourceServerDirectory({
    settingService: {
      get: async () => structuredClone(settings),
      update: async (patch) => {
        if (fail) throw new Error("Fixture settings failure");
        settings = { ...settings, ...structuredClone(patch) };
      },
    },
    credentialService: {
      load: async (key) => secrets.get(key) ?? null,
      save: async (key, value) => {
        secrets.set(key, value);
      },
      delete: async (key) => {
        secrets.delete(key);
      },
    },
    createId: () => "profile-a",
  });
  const target = {
    kind: "ssh" as const,
    host: "example.invalid",
    username: "fixture",
    password: "fixture-secret",
  };
  const initial = await directory.ensureProfile(target);
  const bound = await directory.recordHandshake(
    initial,
    { serverId: "source-a", version: "3.15.1" },
    { authenticatedTarget: target },
  );
  fail = true;
  await assert.rejects(directory.removeProfile(bound.profileId, bound.generation));
  assert.equal(secrets.size, 1);
  assert.equal((await directory.snapshot()).profiles.length, 1);
  await assert.rejects(
    directory.recordHandshake(
      bound,
      { serverId: "source-a", version: "3.15.1" },
      { authenticatedTarget: { ...target, password: "replacement-fixture-secret" } },
    ),
  );
  assert.deepEqual([...secrets.values()], ["fixture-secret"]);
  directory.dispose();
});

test("Source passwords enter credential store only after authenticated commit", async () => {
  const { directory, secrets } = fixture();
  const target = {
    kind: "ssh" as const,
    host: "example.invalid",
    username: "fixture",
    password: "fixture-secret",
  };
  const profile = await directory.ensureProfile(target);
  assert.equal(secrets.size, 0);
  await directory.recordHandshake(
    profile,
    { serverId: "source-a", version: "3.15.1" },
    { authenticatedTarget: target },
  );
  const snapshot = await directory.snapshot();
  assert.equal(JSON.stringify(snapshot).includes("fixture-secret"), false);
  assert.equal(secrets.size, 1);
});
