import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { startRelayServer } from "../../../packages/relay/src/server.ts";
import {
  createProjectTestFixture,
  createProjectTestSymlink,
  projectRoot,
} from "../project-test-sandbox.mjs";

async function fixture(t) {
  const root = await createProjectTestFixture("relay-static");
  const mobileDir = join(root, "dist");
  const sibling = join(root, "dist-private");
  await mkdir(mobileDir);
  await mkdir(sibling);
  await writeFile(join(mobileDir, "mobile.html"), "mobile fixture");
  await writeFile(join(sibling, "sentinel.txt"), "private fixture");
  const logs = [];
  const relay = await startRelayServer({
    port: 0,
    host: "127.0.0.1",
    path: "/ws-private-config",
    mobileDir,
    maxPhysicalFrameBytes: 1024,
    pairTtlMs: 60_000,
    logger: {
      info: (message, fields) => logs.push({ message, ...fields }),
      warn: (message, fields) => logs.push({ message, ...fields }),
    },
    rateLimiter: { allowConnect: () => true, allowFrame: () => true },
  });
  t.after(() => relay.close());
  return { root, mobileDir, sibling, logs, base: `http://127.0.0.1:${relay.port}` };
}

test("encoded slash and backslash cannot reach a sibling with the same prefix", async (t) => {
  const { base } = await fixture(t);
  for (const path of ["/..%2Fdist-private%2Fsentinel.txt", "/..%5Cdist-private%5Csentinel.txt"]) {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 403);
    assert.doesNotMatch(await response.text(), /private fixture/);
  }
  assert.equal(await (await fetch(base + "/")).text(), "mobile fixture");
  assert.equal(await (await fetch(base + "/valid-spa-route")).text(), "mobile fixture");
});

test("file/directory links and SPA fallback cannot escape the actual static root", async (t) => {
  const { base, mobileDir, sibling, root } = await fixture(t);
  await createProjectTestSymlink(
    join(sibling, "sentinel.txt"),
    join(mobileDir, "linked.txt"),
    "file",
  );
  await createProjectTestSymlink(sibling, join(mobileDir, "linked-dir"), "dir");
  for (const path of ["/linked.txt", "/linked-dir/sentinel.txt"]) {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 403);
    assert.doesNotMatch(await response.text(), /private fixture/);
  }
  const linkedRoot = join(root, "fallback-root");
  await mkdir(linkedRoot);
  await createProjectTestSymlink(
    join(sibling, "sentinel.txt"),
    join(linkedRoot, "mobile.html"),
    "file",
  );
  const relay = await startRelayServer({
    port: 0,
    host: "127.0.0.1",
    path: "/ws",
    mobileDir: linkedRoot,
    maxPhysicalFrameBytes: 1024,
    pairTtlMs: 60_000,
    logger: { info() {}, warn() {} },
    rateLimiter: { allowConnect: () => true, allowFrame: () => true },
  });
  t.after(() => relay.close());
  assert.equal((await fetch(`http://127.0.0.1:${relay.port}/missing`)).status, 403);
});

test("relay logger receives static event and safe numbers without host/path config", async (t) => {
  const { logs } = await fixture(t);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].message, "relay: listening");
  assert.equal(typeof logs[0].port, "number");
  assert.doesNotMatch(JSON.stringify(logs), /127\.0\.0\.1|ws-private-config/);
});

test("CLI failed startup preserves event and emits neither raw exception nor directory", async () => {
  const root = await createProjectTestFixture("relay-cli");
  let output;
  try {
    await promisify(execFile)(process.execPath, ["--import", "tsx", "packages/relay/src/cli.ts"], {
      cwd: projectRoot,
      windowsHide: true,
      timeout: 10000,
      env: {
        ...process.env,
        ZCODE_RELAY_PORT: "-1",
        ZCODE_RELAY_MOBILE_DIR: join(root, "private-path-sentinel"),
      },
    });
    assert.fail("invalid port must fail startup");
  } catch (error) {
    assert.equal(error.code, 1);
    output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
  }
  assert.doesNotMatch(output, /private-path-sentinel|RangeError|options\.port/);
  assert.match(output, /"message":"relay: failed to start"/);
  assert.match(output, /"failure":"START_FAILED"/);
});
