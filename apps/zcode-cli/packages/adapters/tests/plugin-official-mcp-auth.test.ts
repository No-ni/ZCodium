/* 历史官方 MCP 声明必须 fail closed；普通 headers/oauth MCP 仍按当前插件契约加载。 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodePluginAdapter } from "../src/plugins/index.js";

const PLUGIN_NAME = "official-mcp-plugin";
const MCP_KEY = "fake-official-search";
const RUNTIME_NAME = `plugin:${PLUGIN_NAME}:${MCP_KEY}`;

interface DiscoverOutcome {
  diagnostics: Array<{ code: string; message: string }>;
  mcpServers: Record<string, Record<string, unknown>>;
}

async function discoverWithMcpServer(server: Record<string, unknown>): Promise<{
  cleanup: () => Promise<void>;
  outcome: DiscoverOutcome;
}> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-official-mcp-plugin-"));
  const pluginRoot = join(dir, PLUGIN_NAME);
  await mkdir(join(pluginRoot, ".zcodium-plugin"), { recursive: true });
  await writeFile(
    join(pluginRoot, ".zcodium-plugin", "plugin.json"),
    JSON.stringify({ name: PLUGIN_NAME }),
  );
  await writeFile(
    join(pluginRoot, ".mcp.json"),
    JSON.stringify({ mcpServers: { [MCP_KEY]: server } }),
  );

  const outcome = (await createNodePluginAdapter({
    storageRoot: join(dir, "plugins"),
  }).discoverPlugins({
    config: { dirs: [pluginRoot], enabled: true, enabledPlugins: {}, options: {} },
    env: {},
    storageRoot: join(dir, "plugins"),
    workingDirectory: dir,
  })) as unknown as DiscoverOutcome;

  return { cleanup: () => rm(dir, { force: true, recursive: true }), outcome };
}

function expectDisabled(outcome: DiscoverOutcome): void {
  expect(outcome.mcpServers[RUNTIME_NAME]).toBeUndefined();
  expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
    "plugin_mcp_server_disabled",
  );
}

describe("plugin mcp retired official auth rejection", () => {
  it("OMCP-001: rejects a former official http declaration", async () => {
    const { cleanup, outcome } = await discoverWithMcpServer({
      auth: { provider: "jwt_token", type: "zcode_official" },
      timeoutMs: 30_000,
      type: "http",
      url: "https://mcp.zcode.example/mcp",
    });
    try {
      expectDisabled(outcome);
    } finally {
      await cleanup();
    }
  });

  it("OMCP-002: rejects a forged official field in .mcp.json", async () => {
    const { cleanup, outcome } = await discoverWithMcpServer({
      auth: { provider: "jwt_token", type: "zcode_official" },
      official: { mcpKey: "spoofed", pluginId: "zcode-tools@official", source: "plugin" },
      type: "http",
      url: "https://mcp.zcode.example/mcp",
    });
    try {
      expectDisabled(outcome);
    } finally {
      await cleanup();
    }
  });

  it("rejects alias and casing variants of the auth type", async () => {
    for (const type of ["zcode-official_auth", "zcode-official", "ZCODE_OFFICIAL", "Zcode_Official"]) {
      const { cleanup, outcome } = await discoverWithMcpServer({
        auth: { provider: "jwt_token", type },
        type: "http",
        url: "https://mcp.zcode.example/mcp",
      });
      try {
        expectDisabled(outcome);
      } finally {
        await cleanup();
      }
    }
  });

  it("rejects an unsupported auth provider", async () => {
    const { cleanup, outcome } = await discoverWithMcpServer({
      auth: { provider: "short_lived_token", type: "zcode_official" },
      type: "http",
      url: "https://mcp.zcode.example/mcp",
    });
    try {
      expectDisabled(outcome);
    } finally {
      await cleanup();
    }
  });

  it("OMCP-S07: rejects a former official stdio declaration", async () => {
    const { cleanup, outcome } = await discoverWithMcpServer({
      auth: { provider: "jwt_token", type: "zcode_official" },
      command: "python3",
      type: "stdio",
    });
    try {
      expectDisabled(outcome);
    } finally {
      await cleanup();
    }
  });

  it("OMCP-S08: rejects a forged official field in a stdio declaration", async () => {
    const { cleanup, outcome } = await discoverWithMcpServer({
      auth: { provider: "jwt_token", type: "zcode_official" },
      command: "python3",
      official: { mcpKey: "spoofed", pluginId: "zcode-tools@official", source: "plugin" },
      type: "stdio",
    });
    try {
      expectDisabled(outcome);
    } finally {
      await cleanup();
    }
  });

  it("OMCP-S09: rejects zcode_official combined with oauth on stdio", async () => {
    const { cleanup, outcome } = await discoverWithMcpServer({
      auth: { provider: "jwt_token", type: "zcode_official" },
      command: "python3",
      oauth: { type: "authorization_code" },
      type: "stdio",
    });
    try {
      expectDisabled(outcome);
    } finally {
      await cleanup();
    }
  });

  it("rejects zcode_official on the sse transport", async () => {
    const sse = await discoverWithMcpServer({
      auth: { provider: "jwt_token", type: "zcode_official" },
      type: "sse",
      url: "https://mcp.zcode.example/sse",
    });
    try {
      expectDisabled(sse.outcome);
    } finally {
      await sse.cleanup();
    }
  });

  it("OMCP-018: rejects zcode_official combined with oauth", async () => {
    const { cleanup, outcome } = await discoverWithMcpServer({
      auth: { provider: "jwt_token", type: "zcode_official" },
      oauth: { type: "authorization_code" },
      type: "http",
      url: "https://mcp.zcode.example/mcp",
    });
    try {
      expectDisabled(outcome);
    } finally {
      await cleanup();
    }
  });

  it("OMCP-007 / OMCP-020: rejects reserved identity and protocol headers, case-insensitively", async () => {
    const reserved = [
      "authorization",
      "AUTHORIZATION",
      "x-coding-plan-api-key",
      "X-Coding-Plan-Api-Key",
      "x-bigmodel-authorization",
      "bigmodel-target-type",
      "Bigmodel-Organization",
      "bigmodel-project",
      "mcp-session-id",
      "MCP-Protocol-Version",
    ];
    for (const header of reserved) {
      const { cleanup, outcome } = await discoverWithMcpServer({
        auth: { provider: "jwt_token", type: "zcode_official" },
        headers: { [header]: "attacker-supplied" },
        type: "http",
        url: "https://mcp.zcode.example/mcp",
      });
      try {
        expectDisabled(outcome);
      } finally {
        await cleanup();
      }
    }
  });

  it("keeps ordinary non-reserved static headers without official auth", async () => {
    const { cleanup, outcome } = await discoverWithMcpServer({
      headers: { "x-trace-hint": "keep-me" },
      type: "http",
      url: "https://mcp.zcode.example/mcp",
    });
    try {
      expect(outcome.mcpServers[RUNTIME_NAME]?.headers).toEqual({ "x-trace-hint": "keep-me" });
    } finally {
      await cleanup();
    }
  });

  it("OMCP-019: leaves ordinary http MCP untouched, including a static authorization header", async () => {
    const { cleanup, outcome } = await discoverWithMcpServer({
      headers: { authorization: "Bearer third-party-token" },
      type: "http",
      url: "https://third-party.example/mcp",
    });
    try {
      // 保留头黑名单只在官方鉴权路径生效；全局拦截会让既有第三方 MCP 回归。
      expect(outcome.mcpServers[RUNTIME_NAME]).toMatchObject({
        headers: { authorization: "Bearer third-party-token" },
        type: "http",
      });
      expect(outcome.mcpServers[RUNTIME_NAME]?.auth).toBeUndefined();
      expect(outcome.mcpServers[RUNTIME_NAME]?.official).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});
