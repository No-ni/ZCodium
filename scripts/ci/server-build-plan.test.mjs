import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { buildServer } from "../../packages/server/build.mjs";

function recordBuild(env, failAt) {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, env: options.env });
    if (calls.length === failAt) throw new Error("build failed");
  };
  return { calls, execute: () => buildServer({ env, run }) };
}

test("server build defaults to HTTP then remote, preserving standalone build outputs", () => {
  for (const flag of [undefined, "", "0", "true"]) {
    const env = { ZCODE_SKIP_REMOTE_ASSETS: flag };
    const build = recordBuild(env);
    build.execute();
    assert.deepEqual(
      build.calls.map(({ args }) => args),
      [
        ["exec", "tsup"],
        ["run", "build:remote"],
      ],
    );
    assert.ok(build.calls.every((call) => call.env === env));
  }
});

test("explicit remote asset opt-out builds HTTP without duplicating the artifact producer", () => {
  const build = recordBuild({ ZCODE_SKIP_REMOTE_ASSETS: "1" });
  build.execute();
  assert.deepEqual(
    build.calls.map(({ args }) => args),
    [["exec", "tsup"]],
  );
});

test("HTTP/remote failures propagate and failed HTTP never starts remote", () => {
  for (const failAt of [1, 2]) {
    const build = recordBuild({}, failAt);
    assert.throws(build.execute, /build failed/);
    assert.equal(build.calls.length, failAt);
  }
});

test("package build uses the tested owner and direct remote entry never honors opt-out", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../../packages/server/package.json", import.meta.url)),
  );
  assert.equal(pkg.scripts.build, "node build.mjs");
  assert.equal(pkg.scripts["build:remote"], "tsx build-remote.ts");
});
