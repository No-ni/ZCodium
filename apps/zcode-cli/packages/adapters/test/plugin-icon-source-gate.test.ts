// QA-BUG-004 source 回归：插件图标来源默认本地化。
// 未显式配置自建来源时 enrichment 必须严格 0 次 HTTP；显式自建来源才允许一次请求，
// 且失败 fail-closed 回退本地缓存，不回退官方地址。

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createProjectTestFixture } from "../../../../../scripts/ci/project-test-sandbox.mjs";
import { NodeHttpClientAdapter } from "../src/http/index.js";
import {
  enrichCachedClaudeMarketplaceIcons,
  writeBundledOfficialMarketplacePartitionSync,
} from "../src/plugins/index.js";

const OFFICIAL_MARKETPLACE = "zcode-plugins-official";
const CLAUDE_MARKETPLACE = "claude-plugins-official";
const OFFICIAL_ICON_SOURCES_URL =
  "https://cdn-zcode.z.ai/zcode/official-plugin/assets/icon-sources.json";
const SELF_HOSTED_ICON_SOURCES_URL = "https://icons.example.invalid/mirror/icon-sources.json";
const ICON_SOURCES_BODY = JSON.stringify([
  { name: "figma", icon: "figma/icon.png", mimeType: "image/png" },
]);

interface StrictIconPort {
  requests: string[];
  refusedRealNetwork: () => number;
}

/** 严格 fake HTTP adapter：只记录端口调用；真实 fetch/http 一律拒绝并计数。 */
function installStrictIconPort(
  t: TestContext,
  handler: (url: string) => Record<string, unknown>,
): StrictIconPort {
  const requests: string[] = [];
  let refused = 0;
  const refuseRealNetwork = (): never => {
    refused += 1;
    throw new Error("QA-BUG-004 actual network is unavailable");
  };
  t.mock.method(globalThis, "fetch", async () => refuseRealNetwork());
  for (const owner of [http, https]) {
    for (const key of ["request", "get"] as const) {
      t.mock.method(owner, key, refuseRealNetwork);
    }
  }
  syncBuiltinESMExports();
  t.mock.method(
    NodeHttpClientAdapter.prototype,
    "request",
    async (request: { url: string }) => {
      requests.push(request.url);
      return handler(request.url);
    },
  );
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return { requests, refusedRealNetwork: () => refused };
}

function jsonPortResponse(url: string, body: string): Record<string, unknown> {
  const bytes = new TextEncoder().encode(body);
  return {
    url,
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    body: bytes,
    bytes: bytes.byteLength,
    durationMs: 0,
    egress: { proxied: false, customCa: false },
  };
}

interface Fixture {
  storageRoot: string;
  bundledPath: string;
  knownPath: string;
  legacyManifestPath: string;
  bundledBefore: string;
  knownBefore: string;
}

async function fixture(t: TestContext, options: { cache?: boolean } = {}): Promise<Fixture> {
  const root = await createProjectTestFixture("plugin-icon-source-gate");
  const storageRoot = join(root, ".zcodium", "cli", "plugins");
  await mkdir(storageRoot, { recursive: true });
  // 合法当前 bundled manifest：官方 ID 的权威目录来自随包 seed（缺陷复现前置）。
  writeBundledOfficialMarketplacePartitionSync({
    storageRoot,
    manifest: {
      name: OFFICIAL_MARKETPLACE,
      plugins: [{ name: "figma", source: "./figma" }],
    },
  });
  const knownPath = join(storageRoot, "known_marketplaces.json");
  const knownBody = JSON.stringify({
    version: 1,
    marketplaces: [
      {
        id: "self-managed-market",
        source: { source: "directory", path: join(root, "self-managed-market") },
        name: "self-managed-market",
        addedAt: "2026-01-01T00:00:00.000Z",
        pluginCount: 0,
      },
    ],
  });
  await writeFile(knownPath, knownBody);
  if (options.cache === true) {
    await writeFile(
      join(storageRoot, "icon-sources.json"),
      JSON.stringify([{ name: "figma", icon: "figma/icon.png", mimeType: "image/png" }]),
    );
  }
  const bundledPath = join(
    storageRoot,
    "marketplaces",
    OFFICIAL_MARKETPLACE,
    "bundled-marketplace.json",
  );
  return {
    storageRoot,
    bundledPath,
    knownPath,
    legacyManifestPath: join(storageRoot, "marketplaces", CLAUDE_MARKETPLACE, "marketplace.json"),
    bundledBefore: await readFile(bundledPath, "utf8"),
    knownBefore: knownBody,
  };
}

async function assertLocalAuthorityUnchanged(f: Fixture): Promise<void> {
  assert.equal(await readFile(f.bundledPath, "utf8"), f.bundledBefore);
  assert.equal(await readFile(f.knownPath, "utf8"), f.knownBefore);
}

test("ICR04: bundled manifest 且未配置自建来源时 enrichment 严格 0 次请求", async (t) => {
  const f = await fixture(t);
  const port = installStrictIconPort(t, (url) => jsonPortResponse(url, ICON_SOURCES_BODY));

  await enrichCachedClaudeMarketplaceIcons(f.storageRoot);

  assert.deepEqual(port.requests, [], "未 opt-in 分支不得发起任何 HTTP 请求");
  assert.equal(port.refusedRealNetwork(), 0);
  assert.equal(existsSync(f.legacyManifestPath), false, "未变化时不得产生写入");
  await assertLocalAuthorityUnchanged(f);
});

test("ICR05: 未配置自建来源时仍走本地缓存路径且 0 次请求", async (t) => {
  const f = await fixture(t, { cache: true });
  const port = installStrictIconPort(t, (url) => jsonPortResponse(url, ICON_SOURCES_BODY));

  await enrichCachedClaudeMarketplaceIcons(f.storageRoot);

  assert.deepEqual(port.requests, []);
  const legacy = JSON.parse(await readFile(f.legacyManifestPath, "utf8")) as {
    plugins: Array<{ name: string; icon?: string }>;
  };
  // 本地图标来源仍可用：历史缓存映射按原语义应用，只是不再联网。
  assert.equal(legacy.plugins[0]?.name, "figma");
  assert.match(legacy.plugins[0]?.icon ?? "", /\/assets\/figma\/icon\.png$/u);
  await assertLocalAuthorityUnchanged(f);
});

test("ICR06: 显式自建来源时只请求该来源并按自建基址应用图标", async (t) => {
  const f = await fixture(t);
  const port = installStrictIconPort(t, (url) => jsonPortResponse(url, ICON_SOURCES_BODY));

  await enrichCachedClaudeMarketplaceIcons(f.storageRoot, undefined, {
    selfHostedIconSourcesUrl: SELF_HOSTED_ICON_SOURCES_URL,
  });

  assert.deepEqual(port.requests, [SELF_HOSTED_ICON_SOURCES_URL]);
  const legacy = JSON.parse(await readFile(f.legacyManifestPath, "utf8")) as {
    plugins: Array<{ icon?: string }>;
  };
  assert.equal(
    legacy.plugins[0]?.icon,
    "https://icons.example.invalid/mirror/figma/icon.png",
    "自建来源的相对图标必须落在自建基址，而不是官方 CDN",
  );
  await assertLocalAuthorityUnchanged(f);
});

test("ICR07: 自建来源失败时 fail-closed 回退本地缓存且不回退官方地址", async (t) => {
  const f = await fixture(t, { cache: true });
  const port = installStrictIconPort(t, () => {
    throw new Error("self-hosted icon source is unreachable");
  });

  await enrichCachedClaudeMarketplaceIcons(f.storageRoot, undefined, {
    selfHostedIconSourcesUrl: SELF_HOSTED_ICON_SOURCES_URL,
  });

  assert.deepEqual(port.requests, [SELF_HOSTED_ICON_SOURCES_URL]);
  assert.equal(port.refusedRealNetwork(), 0);
  const legacy = JSON.parse(await readFile(f.legacyManifestPath, "utf8")) as {
    plugins: Array<{ icon?: string }>;
  };
  assert.match(legacy.plugins[0]?.icon ?? "", /\/assets\/figma\/icon\.png$/u);
  await assertLocalAuthorityUnchanged(f);
});

test("ICR08: 官方图标地址不能当自建来源，按未配置处理", async (t) => {
  const f = await fixture(t, { cache: true });
  const port = installStrictIconPort(t, (url) => jsonPortResponse(url, ICON_SOURCES_BODY));

  await enrichCachedClaudeMarketplaceIcons(f.storageRoot, undefined, {
    selfHostedIconSourcesUrl: OFFICIAL_ICON_SOURCES_URL,
  });

  assert.deepEqual(port.requests, [], "官方地址不是自建来源，不得被请求");
  const legacy = JSON.parse(await readFile(f.legacyManifestPath, "utf8")) as {
    plugins: Array<{ icon?: string }>;
  };
  assert.match(legacy.plugins[0]?.icon ?? "", /\/assets\/figma\/icon\.png$/u);
  await assertLocalAuthorityUnchanged(f);
});

test("ICR09: 自建来源请求期间不持写锁，拿到响应后才进入写入", async (t) => {
  const f = await fixture(t);
  const requests: string[] = [];
  let resolveResponse!: (value: Record<string, unknown>) => void;
  let markRequested!: () => void;
  const requestObserved = new Promise<void>((resolve) => {
    markRequested = resolve;
  });
  const pending = new Promise<Record<string, unknown>>((resolve) => {
    resolveResponse = resolve;
  });
  t.mock.method(NodeHttpClientAdapter.prototype, "request", async (request: { url: string }) => {
    requests.push(request.url);
    markRequested();
    return pending;
  });
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("QA-BUG-004 actual network is unavailable");
  });
  try {
    const lockNetworkStates: number[] = [];
    const migration = enrichCachedClaudeMarketplaceIcons(
      f.storageRoot,
      async (write) => {
        lockNetworkStates.push(requests.length);
        await write();
      },
      { selfHostedIconSourcesUrl: SELF_HOSTED_ICON_SOURCES_URL },
    );

    await requestObserved;
    // 网络尚未返回：不得持有 plugin storage 锁（并发 marketplace 更新不能被图标补齐阻塞）。
    assert.deepEqual(lockNetworkStates, []);
    resolveResponse(jsonPortResponse(SELF_HOSTED_ICON_SOURCES_URL, ICON_SOURCES_BODY));
    await migration;
    assert.deepEqual(lockNetworkStates, [1]);
    assert.deepEqual(requests, [SELF_HOSTED_ICON_SOURCES_URL]);
  } finally {
    t.mock.restoreAll();
  }
});
