import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ServiceCollection } from "@zcode/services";
import { createCoreHttpServer } from "../src/server-core/http.js";
import { ensureIngressToken } from "../src/runtime/ingressToken.js";

test("Source ingress token is stable, private and required for all HTTP control", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcodium-ingress-test-"));
  let http: Awaited<ReturnType<typeof createCoreHttpServer>> | undefined;
  try {
    const token = await ensureIngressToken(root);
    assert.equal(await ensureIngressToken(root), token);
    if (process.platform !== "win32")
      assert.equal((await stat(join(root, "ingress-token"))).mode & 0o777, 0o600);
    http = await createCoreHttpServer(new ServiceCollection(), {
      serverId: "fixture-source",
      ingressToken: token,
    });
    const url = `http://127.0.0.1:${http.port}`;
    assert.equal((await fetch(`${url}/api/server-info`)).status, 401);
    assert.equal((await fetch(`${url}/api/rpc-host-capability`, { method: "POST" })).status, 401);
    const headers = { authorization: `Bearer ${token}` };
    const info = await (await fetch(`${url}/api/server-info`, { headers })).json();
    assert.equal(info.serverId, "fixture-source");
    assert.equal(info.capabilities.sourceServer, true);
    const response = await fetch(`${url}/api/rpc-host-capability`, { method: "POST", headers });
    assert.equal(response.status, 200);
  } finally {
    await http?.close();
    await rm(root, { recursive: true, force: true });
  }
});
