import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { ServiceCollection, IBotsService } from "../../packages/services/src/index.ts";
import { createHttpServer } from "../../packages/server/src/http.ts";

test("HTTP webhook dispatches one callback and preserves retryable failure", async (t) => {
  const calls = [];
  const services = new ServiceCollection().register(IBotsService, {
    async handleProviderCallbackResponse(provider, body) {
      calls.push({ provider, body });
      return { ok: false, replies: [], status: 503, responseBody: { error: "fixture-retry" } };
    },
  });
  const server = createHttpServer(services, 0, { host: "127.0.0.1", serverId: "fixture" });
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  if (!server.listening) await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(origin + "/api/bots/webhook/fixture-bot", {
    method: "POST",
    headers: { "content-type": "application/json", "x-zcode-bot-secret": "fixture-secret" },
    body: JSON.stringify({ message: "fixture-message" }),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "fixture-retry" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, "webhook");
  assert.equal(calls[0].body.botId, "fixture-bot");
  assert.equal(calls[0].body.message, "fixture-message");
  assert.equal(calls[0].body.webhookSecret, "fixture-secret");
  const rejected = await fetch(origin + "/api/bots/feishu", { method: "POST", body: "{}" });
  assert.equal(rejected.status, 400);
  assert.equal(calls.length, 1);
  const invalid = await fetch(origin + "/api/connect-remote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "docker" }),
  });
  assert.equal(invalid.status, 400);
});
