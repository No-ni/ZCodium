import assert from "node:assert/strict";
import test from "node:test";
import { ServiceCollection } from "../../packages/services/src/collection.ts";
import { createCoreHttpServer } from "../../packages/zcode-server-cli/src/server-core/http.ts";

test("Core has one ingress gate and exposes only safe anonymous discovery", async (t) => {
  const server = await createCoreHttpServer(new ServiceCollection(), {
    ingressToken: "a".repeat(64),
    serverId: "fixture-source",
  });
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.port}`;
  const anonymous = await fetch(origin + "/api/server-info");
  assert.equal(anonymous.status, 200);
  const discovery = await anonymous.json();
  assert.equal(discovery.authRequired, true);
  for (const field of ["serverId", "identity", "workspaces", "migration", "capabilities"])
    assert.equal(field in discovery, false, field);
  assert.equal((await fetch(origin + "/api/rpc-host-capability", { method: "POST" })).status, 401);
  assert.equal(
    (
      await fetch(origin + "/api/rpc-host-capability", {
        method: "POST",
        headers: { authorization: "Bearer " + "b".repeat(64) },
      })
    ).status,
    401,
  );
  const authenticated = await fetch(origin + "/api/server-info", {
    headers: { authorization: "Bearer " + "a".repeat(64) },
  });
  assert.equal((await authenticated.json()).serverId, "fixture-source");
  const issued = await fetch(origin + "/api/rpc-host-capability", {
    method: "POST",
    headers: { authorization: "Bearer " + "a".repeat(64) },
  });
  assert.equal(issued.status, 200);
  const result = await issued.json();
  assert.equal(typeof result.capability, "string");
});
