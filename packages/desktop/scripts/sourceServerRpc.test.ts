import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ISystemService, ServiceCollection } from "@zcode/services";
import { createCoreHttpServer } from "../../zcode-server-cli/src/server-core/http.js";
import { ensureIngressToken } from "../../zcode-server-cli/src/runtime/ingressToken.js";
import { connectSourceServerRpc } from "../src/host/sourceServerRpc.js";
import type { SourceServerTransport } from "@zcode/server/source-server";

test("one tunnel completes Source HTTP/WS handoff and disconnect does not stop daemon", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcodium-source-rpc-"));
  let http: Awaited<ReturnType<typeof createCoreHttpServer>> | undefined;
  try {
    const token = await ensureIngressToken(root);
    let entered!: () => void;
    const accepted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const services = new ServiceCollection().register(ISystemService, {
      info: () => {
        entered();
        return new Promise(() => {});
      },
      listIntegratedTerminalShells: async () => [],
      probeIntranet: async () => {
        throw new Error("Unused fixture probe");
      },
    });
    http = await createCoreHttpServer(services, {
      serverId: "fixture-source",
      ingressToken: token,
    });
    let opened = 0;
    const transport = {
      ingressToken: token,
      openChannel: async () => {
        opened += 1;
        return createConnection({ host: "127.0.0.1", port: http!.port });
      },
      dispose: async () => undefined,
    } as SourceServerTransport;
    const connection = await connectSourceServerRpc(transport);
    assert.equal(connection.serverInfo.serverId, "fixture-source");
    assert.equal(opened, 1);
    const pending = connection.services.systemService.info();
    const rejected = assert.rejects(pending, /disposed|closed/i);
    await accepted;
    connection.dispose();
    await rejected;
    assert.equal(connection.isClosed, true);
    const info = await fetch(`http://127.0.0.1:${http.port}/api/server-info`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(info.status, 200);
  } finally {
    await http?.close();
    await rm(root, { recursive: true, force: true });
  }
});
