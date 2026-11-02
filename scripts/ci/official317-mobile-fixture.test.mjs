import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { prepareWebRemoteControlSessionEventsFixture } from "../../packages/desktop/test/e2e/helpers/web-remote-control-session-events-fixture.ts";
import { prepareWebRemoteControlSessionFixture } from "../../packages/desktop/test/e2e/helpers/web-remote-control-session-fixture.ts";
import { createProjectTestSandbox, projectRoot } from "./project-test-sandbox.mjs";

async function fixtureFiles() {
  const sandbox = await createProjectTestSandbox("mobile-relay-regression");
  const workspacePath = join(sandbox.root, "workspace");
  const credentialsFile = join(sandbox.root, "credentials.json");
  const settingsFile = join(sandbox.root, "settings.json");
  await mkdir(workspacePath);
  await writeFile(credentialsFile, "{}");
  await writeFile(
    settingsFile,
    JSON.stringify({
      theme: "dark",
      webRemoteControlExternalRelayDevice: { deviceSid: "retired" },
    }),
  );
  return { workspacePath, credentialsFile, settingsFile };
}

async function exchange(socket, frame, type) {
  const message = once(socket, "message", { signal: AbortSignal.timeout(5000) });
  socket.send(JSON.stringify(frame));
  const [data] = await message;
  const response = JSON.parse(data.toString());
  assert.equal(response.type, type);
  return response;
}

async function authenticate(socket, sid, role, passHash) {
  const { nonce } = await exchange(
    socket,
    { type: "auth_init", device_sid: sid, role, client_ts: Date.now() },
    "auth_challenge",
  );
  const proof = createHmac("sha256", passHash)
    .update(`${nonce}|${role}|${sid}`)
    .digest("base64url");
  return exchange(
    socket,
    { type: "auth_response", device_sid: sid, proof, client_ts: Date.now() },
    "auth_ack",
  );
}

test(
  "anonymous mobile fixture serves mobile.html and forwards real relay frames",
  { timeout: 90000 },
  async () => {
    const files = await fixtureFiles();
    const previous = process.env.ZCODIUM_E2E_MOBILE_URL;
    const stop = await prepareWebRemoteControlSessionFixture({
      ...files,
      specs: ["conversation-session-virtual-project-mobile.test.ts"],
    });
    const peers = [];
    const origin = process.env.ZCODIUM_E2E_MOBILE_URL;
    try {
      assert.equal(typeof stop, "function");
      const settings = JSON.parse(await readFile(files.settingsFile, "utf8"));
      assert.equal(settings.theme, "dark");
      assert.equal(settings.webRemoteControlEndpointMode, "custom");
      assert.equal(settings.webRemoteControlExternalRelayDevice, undefined);
      assert.equal(
        settings.webRemoteControlCustomEndpointUrl,
        `${origin.replace("http:", "ws:")}ws`,
      );
      assert.deepEqual(JSON.parse(await readFile(files.credentialsFile, "utf8")), {});
      const mobile = await fetch(origin);
      assert.equal(mobile.status, 200);
      assert.match(await mobile.text(), /id="mobile-root"/u);
      assert.equal((await fetch(`${origin}api/v1/oauth/cli/init`)).status, 404);
      assert.equal((await fetch(`${origin}healthz`)).status, 200);
      const connect = async () => {
        const peer = new WebSocket(settings.webRemoteControlCustomEndpointUrl);
        peers.push(peer);
        await once(peer, "open", { signal: AbortSignal.timeout(5000) });
        return peer;
      };
      const device = await connect();
      const passHash = "synthetic-pairing-proof";
      const { device_sid: sid } = await exchange(
        device,
        {
          type: "device_register_init",
          device_mid: "fixture-device",
          pass_hash: passHash,
          client_ts: Date.now(),
        },
        "device_register_ack",
      );
      assert.equal((await authenticate(device, sid, "device", passHash)).pair_status, "waiting");
      const mobilePeer = await connect();
      assert.equal(
        (await authenticate(mobilePeer, sid, "mobile", passHash)).pair_status,
        "matched",
      );
      const payload = { zcode_type: "fixture-admission", sequence: 1 };
      const received = once(mobilePeer, "message", { signal: AbortSignal.timeout(5000) });
      device.send(JSON.stringify({ type: "data", payload }));
      const [raw] = await received;
      assert.deepEqual(JSON.parse(raw.toString()), { type: "data", payload });
    } finally {
      await Promise.all(
        peers.map(async (peer) => {
          if (peer.readyState === WebSocket.CLOSED) return;
          const ended = once(peer, "close");
          peer.terminate();
          await ended;
        }),
      );
      await stop?.();
    }
    assert.equal(process.env.ZCODIUM_E2E_MOBILE_URL, previous);
    await assert.rejects(fetch(`${origin}healthz`));
  },
);

test("fixture ignores retired OAuth specs and rejects targets outside the worktree", async () => {
  const files = await fixtureFiles();
  assert.equal(
    await prepareWebRemoteControlSessionFixture({
      ...files,
      specs: ["web-remote-control-auth-gate.test.ts"],
    }),
    null,
  );
  await assert.rejects(
    prepareWebRemoteControlSessionEventsFixture({
      ...files,
      credentialsFile: resolve(projectRoot, "../outside/credentials.json"),
    }),
    /PROJECT_TEST_PATH_REJECTED/u,
  );
  await assert.rejects(
    prepareWebRemoteControlSessionEventsFixture({
      ...files,
      webUrl: "https://example.com/mobile.html",
    }),
    /MOBILE_FIXTURE_ENDPOINT_REJECTED/u,
  );
  assert.deepEqual(JSON.parse(await readFile(files.credentialsFile, "utf8")), {});
});
