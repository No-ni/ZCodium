import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { ZCODE_PLUGIN_ID_ENV_KEY } from "@zcode/shared";
import { writeOfficialPluginRuntimeManifest } from "../src/app/official-plugin-runtime.js";

const roots: string[] = [];
const entrypoint = process.argv[1];
afterEach(async () => {
  process.argv[1] = entrypoint;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(manifest: unknown) {
  const root = await mkdtemp(join(tmpdir(), "zcodium-office-entry-"));
  roots.push(root);
  const path = join(root, ".zcodium-plugin", "plugin.json");
  await mkdir(join(root, ".zcodium-plugin"));
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  process.argv[1] = join(root, "zcode.cjs");
  return { root, path };
}

function rewrite(root: string, sourceManifest: unknown) {
  // 源 manifest 必须参与两条 seed 路径，不能从被旧客户端改坏的缓存猜入口。
  const input = {
    pluginName: "pdf",
    rootPath: root,
    sourceManifestContents: JSON.stringify(sourceManifest),
  };
  writeOfficialPluginRuntimeManifest(input);
}

test("rebuilds Office dist/server.mjs from the source manifest and preserves args/env", async () => {
  const { root, path } = await fixture({
    name: "pdf",
    mcpServers: { pdf: { command: "old-node", args: ["wrong.js"] } },
  });
  const source = {
    name: "pdf",
    version: "0.2.1",
    skills: "skills",
    mcpServers: {
      pdf: {
        command: "node",
        args: ["${CLAUDE_PLUGIN_ROOT}/dist/server.mjs", "--fixture", "${CLAUDE_PLUGIN_ROOT}/data"],
        env: { FIXTURE: "yes", ELECTRON_RUN_AS_NODE: "0", [ZCODE_PLUGIN_ID_ENV_KEY]: "wrong" },
      },
    },
  };
  rewrite(root, source);
  const result = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(result.mcpServers.pdf.args.slice(-3), [
    join(root, "dist", "server.mjs"),
    "--fixture",
    `${root}/data`,
  ]);
  assert.equal(result.mcpServers.pdf.command, process.execPath);
  assert.equal(result.mcpServers.pdf.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(result.mcpServers.pdf.env.FIXTURE, "yes");
  assert.equal(result.mcpServers.pdf.env[ZCODE_PLUGIN_ID_ENV_KEY], "pdf@zcode-plugins-official");
  assert.equal(result.version, "0.2.1");
  const first = await stat(path);
  rewrite(root, source);
  assert.equal((await stat(path)).mtimeMs, first.mtimeMs, "unchanged bytes must not rewrite cache");
});

test("HTTP/SSE configs are not converted to stdio", async () => {
  const http = { type: "http", url: "https://example.invalid/mcp", headers: { fixture: "yes" } };
  const sse = { type: "sse", url: "https://example.invalid/events" };
  const source = { name: "pdf", mcpServers: { http, sse } };
  const { root, path } = await fixture(source);
  rewrite(root, source);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).mcpServers, { http, sse });
});

test("keeps legacy local entrypoints and does not duplicate plugin-host on repeated fallback", async () => {
  const { root, path } = await fixture({
    name: "fixture",
    mcpServers: { fixture: { command: "node", args: ["${ZCODE_PLUGIN_ROOT}/dist/mcp/server.js"] } },
  });
  const source = JSON.parse(await readFile(path, "utf8"));
  rewrite(root, source);
  const first = await readFile(path, "utf8");
  writeOfficialPluginRuntimeManifest({ pluginName: "pdf", rootPath: root });
  assert.equal(await readFile(path, "utf8"), first);
  assert.equal(JSON.parse(first).mcpServers.fixture.args.at(-1), join(root, "dist/mcp/server.js"));
});

test("rejects an out-of-plugin stdio entry instead of inventing a server path", async () => {
  const source = { name: "pdf", mcpServers: { pdf: { command: "node", args: ["../escape.mjs"] } } };
  const { root } = await fixture(source);
  assert.throws(() => rewrite(root, source), /invalid MCP server (?:args|entry)/);
});

test("skill-only and invalid manifest behavior remain explicit", async () => {
  const { root, path } = await fixture({ name: "fixture", skills: "skills" });
  const first = await readFile(path, "utf8");
  writeOfficialPluginRuntimeManifest({ pluginName: "fixture", rootPath: root });
  assert.equal(await readFile(path, "utf8"), first);
  assert.throws(() => rewrite(root, { name: "pdf", mcpServers: "invalid" }), /invalid mcpServers/);
});
