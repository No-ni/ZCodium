import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  startE2ENetworkCaptureProxy,
  DEFAULT_E2E_NETWORK_CAPTURE_NO_PROXY,
} from "../../packages/desktop/test/e2e/helpers/network-capture-proxy.ts";
import { createProjectTestSandbox, projectRoot } from "./project-test-sandbox.mjs";

test(
  "explicit local capture preserves HTTP bytes while redacting credentials",
  { timeout: 30000 },
  async () => {
    const sandbox = await createProjectTestSandbox("capture-boundaries");
    const upstream = createServer((req, res) => {
      req.resume();
      req.once("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ result: "synthetic-result", access_token: "synthetic-response-token" }),
        );
      });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    let proxy;
    try {
      const artifactPath = join(sandbox.root, "capture.json");
      proxy = await startE2ENetworkCaptureProxy({ artifactPath, caDir: join(sandbox.root, "ca") });
      const proxyUrl = new URL(proxy.proxyUrl);
      const target = `http://127.0.0.1:${upstream.address().port}/provider`;
      const body = JSON.stringify({ api_key: "synthetic-request-key", prompt: "synthetic-input" });
      const data = await new Promise((resolveBody, reject) => {
        const req = request(
          {
            host: proxyUrl.hostname,
            port: proxyUrl.port,
            path: target,
            method: "POST",
            headers: {
              authorization: "Bearer synthetic-header-token",
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
            },
          },
          (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.once("end", () =>
              resolveBody({ status: res.statusCode, body: Buffer.concat(chunks).toString() }),
            );
          },
        );
        req.once("error", reject);
        req.end(body);
      });
      assert.equal(data.status, 200);
      assert.equal(JSON.parse(data.body).access_token, "synthetic-response-token");
      await proxy.stop();
      proxy = undefined;
      const capture = await readFile(artifactPath, "utf8");
      for (const credential of [
        "synthetic-header-token",
        "synthetic-request-key",
        "synthetic-response-token",
      ])
        assert.equal(capture.includes(credential), false);
      const { records } = JSON.parse(capture);
      assert.equal(records.length, 1);
      assert.equal(records[0].status, "complete");
      assert.equal(records[0].requestBodyBytes, Buffer.byteLength(body));
      assert.equal(records[0].requestHeaders.authorization, "[redacted]");
      assert.equal(records[0].requestJson.api_key, "[redacted]");
      assert.equal(records[0].responseChunkTimeline, undefined);
    } finally {
      await proxy?.stop();
      upstream.closeAllConnections();
      await new Promise((resolveClose) => upstream.close(resolveClose));
    }
  },
);

test("capture rejects external output roots and non-loopback listeners", async () => {
  const sandbox = await createProjectTestSandbox("capture-rejection");
  assert.equal(DEFAULT_E2E_NETWORK_CAPTURE_NO_PROXY, "localhost,127.0.0.1,::1");
  const options = {
    artifactPath: join(sandbox.root, "capture.json"),
    caDir: join(sandbox.root, "ca"),
  };
  await assert.rejects(
    startE2ENetworkCaptureProxy({
      ...options,
      artifactPath: resolve(projectRoot, "../outside/capture.json"),
    }),
    /PROJECT_TEST_PATH_REJECTED/u,
  );
  await assert.rejects(
    startE2ENetworkCaptureProxy({ ...options, host: "0.0.0.0" }),
    /E2E_CAPTURE_HOST_REJECTED/u,
  );
});
