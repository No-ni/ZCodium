import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { format } from "node:util";
import { tsImport } from "tsx/esm/api";

function captureConsole(t) {
  const lines = [];
  for (const level of ["log", "debug", "warn", "error"]) {
    t.mock.method(console, level, (...args) => lines.push(format(...args)));
  }
  return lines;
}

function setEnv(t, key, value) {
  const previous = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

test("unwrapped settings service preserves preferences without logging private data", async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), "private-settings-fixture-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  setEnv(t, "ZCODE_DESKTOP_HOME_DIR", dir);
  setEnv(t, "ZCODE_RUNTIME_ENV", "development");
  const lines = captureConsole(t);
  const { createSettingService } = await tsImport(
    "../../packages/services/src/setting/settingService.ts",
    import.meta.url,
  );
  const service = createSettingService();
  const proxy = "http://private-proxy-user:private-proxy-secret@127.0.0.1:19000";
  await service.update({
    locale: "en-US",
    httpProxy: proxy,
    recentProjects: ["/private-project-fixture"],
  });
  assert.equal((await service.get()).httpProxy, proxy);
  const file = join(dir, ".zcodium", "v2", "setting.json");
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).httpProxy, proxy);
  await fs.writeFile(file, '{"locale":"private-schema-fixture"}');
  await service.get();
  await fs.writeFile(file, "private-corrupt-json-fixture");
  await service.get();
  assert.ok((await fs.readdir(dirname(file))).some((name) => name.includes(".corrupt-")));
  const output = lines.join("\n");
  for (const privateValue of [
    dir,
    proxy,
    "private-project-fixture",
    "private-schema-fixture",
    "private-corrupt-json-fixture",
  ]) {
    assert.ok(
      !output.includes(privateValue),
      `Private fixture escaped service logger: ${privateValue}`,
    );
  }
  assert.match(output, /settings write completed/);
  assert.match(output, /settings schema validation failed/);
  assert.match(output, /invalid settings json quarantined/);
});

test("MCP migration failure keeps safe diagnostics and the offline migration result", async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), "private-mcp-fixture-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  setEnv(t, "HOME", dir);
  const lines = captureConsole(t);
  const file = join(dir, ".zcodium", "cli", "config.json");
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({
      mcp: {
        servers: {
          "private-server-fixture": {
            type: "stdio",
            command: "private-command-fixture",
            enable: false,
          },
        },
      },
    }),
  );
  const originalRename = fs.rename;
  const mock = t.mock.method(fs, "rename", async (...args) => {
    if (args[1] === file)
      throw Object.assign(new Error("private-rename-error-fixture"), { code: "EACCES" });
    return originalRename(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });
  const { createMcpSyncService } = await tsImport(
    "../../packages/services/src/mcp-sync/mcpSyncService.ts",
    import.meta.url,
  );
  const result = await createMcpSyncService().listLocalUserMcpCandidates();
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].enabled, false);
  assert.equal(Object.hasOwn(result.candidates[0].config, "enable"), false);
  assert.equal(
    JSON.parse(await fs.readFile(file, "utf8")).mcp.servers["private-server-fixture"].enable,
    false,
  );
  const output = lines.join("\n");
  for (const privateValue of [
    dir,
    "private-server-fixture",
    "private-command-fixture",
    "private-rename-error-fixture",
  ]) {
    assert.ok(
      !output.includes(privateValue),
      `Private fixture escaped MCP logger: ${privateValue}`,
    );
  }
  assert.match(output, /legacy enable migration failed/);
  assert.match(output, /EACCES/);
});
