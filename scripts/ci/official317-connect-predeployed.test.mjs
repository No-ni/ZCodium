import assert from "node:assert/strict";
import test from "node:test";
import { connectRemote } from "../../packages/server/src/remote/connect.ts";

for (const options of [undefined, { skipDeploy: false }]) {
  test(`remote connection ${options ? "with legacy flag" : "with default options"} never deploys runtime assets`, async () => {
    const calls = [];
    const backend = {
      async detect() {
        calls.push("detect");
        return { platform: "linux", arch: "x64" };
      },
      async exec(command) {
        calls.push("exec");
        assert.match(command, /~\/\.zcodium\/server\/node/);
        throw new Error("FIXTURE_LAUNCH_STOP");
      },
      async upload() {
        calls.push("upload");
        throw new Error("UNEXPECTED_DEPLOY");
      },
      dispose() {
        calls.push("dispose");
      },
    };
    await assert.rejects(connectRemote(backend, options), /FIXTURE_LAUNCH_STOP/);
    assert.deepEqual(calls, ["detect", "exec", "dispose"]);
  });
}
