import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readPluginName } from "./plugin-name.mjs";
import { verifyAppBridge } from "./app-bridge-fixture.mjs";
import { startOfficeFixture } from "./gui-fixture.mjs";

/** Temporary compiled MCP/AppBridge fixture. GUI serving is opt-in; this script never launches a browser. */
const runtime = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plugins = ["documents", "spreadsheets", "presentations", "pdf"];
const argv = process.argv.slice(2);
const serving = argv.includes("--serve");
const selected = argv.find((arg) => !arg.startsWith("--"));
const names = selected ? [selected] : plugins;
if (names.some((name) => !plugins.includes(name)) || (serving && names.length !== 1))
  throw new Error("Usage: e2e.mjs [documents|spreadsheets|presentations|pdf] [--serve]");
const temp = await mkdtemp(join(tmpdir(), "zcodium-office-compiled-fixture-"));
const execute = (script, args, cwd) =>
  new Promise((done, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? done() : reject(new Error("Office fixture command failed.")),
    );
  });
let gui;
try {
  const workspace = join(temp, "workspace");
  await cp(join(runtime, "fixtures"), join(workspace, "docs"), {
    recursive: true,
    filter: (path) => !path.endsWith(".py"),
  });
  for (const name of names) {
    const plugin = resolve(runtime, "..", `${name}-plugin`);
    const dist = join(temp, name, "dist");
    await execute(join(runtime, "scripts/build.mjs"), ["--out-dir", dist], plugin);
    await execute(join(runtime, "scripts/smoke.mjs"), [plugin, dist], plugin);
    // The bundle must expose main for the existing plugin-host and importing it must not claim stdio.
    const module = await import(pathToFileURL(join(dist, "server.mjs")).href);
    assert.equal(typeof module.main, "function");
    const client = new Client({ name: "office-built-fixture", version: "1" });
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [join(dist, "server.mjs")],
          cwd: workspace,
          env: { PATH: process.env.PATH ?? "", ZCODE_WORKSPACE_ROOT: workspace },
          stderr: "pipe",
        }),
      );
      const kind = JSON.parse(await readFile(join(plugin, "package.json"), "utf8")).office.kinds[0];
      const samples = {
        docx: ["docs/report.docx", "p:4"],
        xlsx: ["docs/budget.xlsx", "Revenue!B2"],
        pptx: ["docs/launch.pptx", "slide:2"],
        pdf: ["docs/paper.pdf", "page:1"],
      };
      const [sample, at] = samples[kind];
      await verifyAppBridge(client, await readPluginName(plugin), sample, `${sample}#${at}`);
      process.stdout.write(
        `${name} actual built MCP/AppBridge fixture: ok (no browser rendering claimed)\n`,
      );
    } finally {
      await client.close();
    }
    if (serving) {
      gui = await startOfficeFixture(plugin, dist, workspace);
      process.stdout.write(`Office GUI fixture (${name}): ${gui.url}\n`);
      await new Promise((done) => {
        process.once("SIGINT", done);
        process.once("SIGTERM", done);
      });
    }
  }
} finally {
  await gui?.close();
  await rm(temp, { recursive: true, force: true });
}
