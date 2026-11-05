import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createProjectTestFixture } from "../../../../../scripts/ci/project-test-sandbox.mjs";
import { uploadSnapshot } from "../src/upload.js";
import type { EncryptionEnvelope } from "../src/types.js";
import {
  PARODY_FLAG,
  PARODY_ENV_KEY,
  isTruthyFlagValue,
  isLoopbackHost,
  resolveParodyGate,
  assertLoopbackTarget,
} from "../src/gate.js";

test("未传开关时默认关闭，且给出启用方式", () => {
  const gate = resolveParodyGate({ argv: [], env: {} });
  assert.equal(gate.enabled, false);
  assert.equal(gate.source, "none");
  assert.match(gate.reason ?? "", /--parody-snapshot/u);
  assert.match(gate.reason ?? "", /ZCODE_PARODY_SNAPSHOT=1/u);
});

test("CLI flag 启用", () => {
  const gate = resolveParodyGate({ argv: [PARODY_FLAG, "capture"], env: {} });
  assert.equal(gate.enabled, true);
  assert.equal(gate.source, "flag");
});

test("env 启用", () => {
  const gate = resolveParodyGate({ argv: [], env: { [PARODY_ENV_KEY]: "1" } });
  assert.equal(gate.enabled, true);
  assert.equal(gate.source, "env");
});

test("flag 优先于 env 记录来源", () => {
  const gate = resolveParodyGate({ argv: [PARODY_FLAG], env: { [PARODY_ENV_KEY]: "1" } });
  assert.equal(gate.source, "flag");
});

test("真值只认显式集合", () => {
  for (const value of ["1", "true", "TRUE", " yes ", "on", "ON"]) {
    assert.equal(isTruthyFlagValue(value), true, `应当启用：${value}`);
  }
  for (const value of ["0", "false", "no", "off", "", " ", "2", "y", "t", "enabled", undefined]) {
    assert.equal(isTruthyFlagValue(value), false, `应当不启用：${value}`);
  }
});

test("回环判定", () => {
  for (const host of ["127.0.0.1", "127.0.0.2", "::1", "[::1]", "localhost", "LocalHost"]) {
    assert.equal(isLoopbackHost(host), true, `应当视为回环：${host}`);
  }
  for (const host of ["8.8.8.8", "zcode.z.ai", "192.168.1.10", "", "0.0.0.0"]) {
    assert.equal(isLoopbackHost(host), false, `应当拒绝：${host}`);
  }
});

test("非回环目标被拒绝", () => {
  assert.throws(() => assertLoopbackTarget("http://8.8.8.8/snapshot"), /拒绝非回环/u);
  assert.throws(() => assertLoopbackTarget("not-a-url"), /合法 URL/u);
  const url = assertLoopbackTarget("http://127.0.0.1:8787/snapshot");
  assert.equal(url.port, "8787");
});

test("loopback upload never follows a 307 to another receiver", async (t) => {
  const directory = await createProjectTestFixture("parody-redirect");
  const artifact = join(directory, "fixture.enc");
  await writeFile(artifact, "synthetic artifact");
  let forwarded = 0;
  const receiver = createServer((_request, response) => {
    forwarded++;
    response.end("forwarded");
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => receiver.close(() => resolve())));
  const destination = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/snapshot`;
  const redirector = createServer((_request, response) => {
    response.writeHead(307, { Location: destination });
    response.end("redirect rejected");
  });
  await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => redirector.close(() => resolve())));
  const result = await uploadSnapshot({
    baseUrl: `http://127.0.0.1:${(redirector.address() as { port: number }).port}`,
    workspaceKeyHash: "fixture",
    groupId: "fixture",
    encryptedArtifactPath: artifact,
    envelope: {} as EncryptionEnvelope,
    manifest: { files: [] },
    artifactBytes: 18,
  });
  assert.equal(result.status, 307);
  assert.equal(result.ok, false);
  assert.equal(forwarded, 0);
});

test("CLI accepts the gate before/after manifest and rejects workspace without a value", async () => {
  const directory = await createProjectTestFixture("parody-manifest-cwd");
  const cli = fileURLToPath(new URL("../bin/parody.mjs", import.meta.url));
  const execute = promisify(execFile);
  for (const args of [
    [PARODY_FLAG, "manifest"],
    ["manifest", PARODY_FLAG],
  ]) {
    const result = await execute(process.execPath, [cli, ...args], {
      cwd: directory,
      env: process.env,
      windowsHide: true,
    });
    const manifest = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
    assert.equal(manifest.workspaceKey, directory);
    assert.equal(manifest.stats.includedFileCount, 0);
  }
  await assert.rejects(
    execute(process.execPath, [cli, "manifest", PARODY_FLAG, "--workspace"], {
      cwd: directory,
      env: process.env,
      windowsHide: true,
    }),
  );
});
