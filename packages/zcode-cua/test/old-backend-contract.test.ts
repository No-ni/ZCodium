import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  UNAVAILABLE_TEXT,
  assertCuaDriverClient,
  createComputerUseRuntime,
  createUnavailableRuntime,
  projectDriverError,
  projectToolResult,
} from "../runtime.js";
import { ZCODE_SURFACE_TOOLS } from "../surface.js";
import { describeCompatReadiness } from "../platform.js";

const packageRoot = join(import.meta.dirname, "..");

interface FakeClient {
  calls: { name: string; argsJson: string; hasOptions: boolean }[];
  callTool(name: string, argsJson: string, options?: unknown): Promise<unknown>;
}

function fakeClient(result?: Record<string, unknown>): FakeClient {
  const calls: FakeClient["calls"] = [];
  return {
    calls,
    async callTool(name, argsJson, options) {
      calls.push({ name, argsJson, hasOptions: options !== undefined });
      return (
        result ?? {
          text: "ok",
          images: [],
          isError: false,
          degraded: false,
          structuredJson: "",
          rawJson: "",
        }
      );
    },
  };
}

const context = {
  sessionId: "session-1",
  runtimeScope: "main" as const,
  workspaceKey: "workspace-1",
};

// 可控的 driver ToolResult 夹具：带 apps 结构化清单与一张截图，供投影断言取准。
function driverFixture() {
  return {
    text: "ok",
    images: [{ mimeType: "image/png", dataBase64: "AAAA" }],
    isError: false,
    degraded: false,
    structuredJson: JSON.stringify({ apps: [{ name: "Notes", pid: 42 }] }),
    rawJson: JSON.stringify({ ok: true }),
  };
}

// 本轮保留 @trycua/cua-driver 旧后端（撤销官方占位接管）。这里钉住宿主依赖的三件事：
// runtime 的 execute 契约形状、未观察就动作时的拒收口径，以及后端文件面不得被官方占位覆盖。
// 全部只注入假 client，不触碰真实 driver，也不操控真实桌面。
describe("CUA driver runtime contract", () => {
  it("routes ZCode surface tools to the injected driver client and keeps the MCP result shape", async () => {
    const client = fakeClient(driverFixture());
    const runtime = createComputerUseRuntime({ client: client as never });
    const result = await runtime.execute({
      toolName: "list_apps",
      arguments: {},
      context: { ...context, actionTitle: "打开系统设置" },
    });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.name).toBe("list_apps");
    expect(client.calls[0]?.argsJson).toBe("{}");
    // driver SDK 的第三个参数只在真有 signal 时传，空对象会让 SDK 读 signal.aborted 报错。
    expect(client.calls[0]?.hasOptions).toBe(false);
    expect(result.isError).toBe(false);
    // surface 层按 apps 清单投影，模型看到的是可寻址目标而不是 driver 原始文本。
    expect(result.content).toEqual([{ type: "text", text: '[{"name":"Notes","pid":42}]' }]);
    // 带 actionTitle 的 context 必须原样穿过装配点（badge 链路，宿主 broker 会读它）。
    expect(result.isError).toBe(false);

    await expect(runtime.closeSession(context)).resolves.toBeUndefined();
    await expect(runtime.dispose()).resolves.toBeUndefined();
  });

  it("passes native driver tool names through, with a signal, and refuses input before observation", async () => {
    const client = fakeClient(driverFixture());
    const runtime = createComputerUseRuntime({ client: client as never });
    const passthrough = await runtime.execute({
      toolName: "get_window_state",
      arguments: { window_id: 7 },
      context,
    });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toEqual({
      name: "get_window_state",
      argsJson: '{"window_id":7}',
      hasOptions: false,
    });
    expect(passthrough.content).toEqual([
      { type: "text", text: "ok" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]);
    expect(passthrough.isError).toBe(false);

    const controller = new AbortController();
    await runtime.execute({
      toolName: "get_window_state",
      arguments: { window_id: 8 },
      context,
      signal: controller.signal,
    });
    expect(client.calls.at(-1)?.hasOptions).toBe(true);

    // 未建立观察目标就下发动作：必须拒收且不投递给 driver（actionSent:false）。
    const click = await runtime.execute({
      toolName: "left_click",
      arguments: { x: 1, y: 2 },
      context,
    });
    expect(click.isError).toBe(true);
    expect(click.structuredContent).toMatchObject({ code: "STALE_STATE" });
    expect(click._meta).toMatchObject({ actionSent: false, errorCode: "STALE_STATE" });
    expect(client.calls.filter((call) => call.name === "left_click")).toHaveLength(0);
  });

  it("stays fail-closed without an injected driver client", async () => {
    const runtime = createComputerUseRuntime();
    const result = await runtime.execute({ toolName: "list_apps", arguments: {}, context });
    expect(result.isError).toBe(true);
    expect(result._meta).toMatchObject({ cuaUnavailable: true });
    expect(String(result.content?.[0]?.text)).toContain("unavailable");
    expect(assertCuaDriverClient({})).toContain("callTool");
    expect(assertCuaDriverClient(fakeClient())).toBeUndefined();
    const custom = await createUnavailableRuntime(UNAVAILABLE_TEXT).execute({
      toolName: "list_apps",
      arguments: {},
      context,
    });
    expect(custom.content).toEqual([{ type: "text", text: UNAVAILABLE_TEXT }]);
  });

  it("keeps the platform routing decision pure: native path stays default, compat only for legacy GNOME", () => {
    // Windows / macOS / 新合成器始终走原生；只有老 GNOME 且缺 WinRects 扩展时才报需要装扩展。
    expect(describeCompatReadiness({})).toMatchObject({ ready: true, needsExtension: false });
    expect(
      describeCompatReadiness({ gnomeShellVersion: "46", portalRemoteDesktopVersion: "2" }),
    ).toMatchObject({ ready: true, needsExtension: false });
    expect(
      describeCompatReadiness({ gnomeShellVersion: "42", portalRemoteDesktopVersion: "1" }),
    ).toMatchObject({ ready: false, needsExtension: true });
  });

  it("projects driver results and refusals into MCP-shaped payloads", () => {
    expect(
      projectToolResult({
        text: "screen",
        images: [{ mimeType: "image/png", dataBase64: "AAAA" }],
        isError: true,
        errorCode: "foreground_required",
        degraded: true,
        structuredJson: '{"apps":[]}',
        rawJson: '{"action":"click"}',
      }),
    ).toEqual({
      content: [
        { type: "text", text: "screen" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
      isError: true,
      structuredContent: { apps: [] },
      _meta: {
        errorCode: "foreground_required",
        degraded: true,
        driverResult: { action: "click" },
      },
    });

    const refusal = projectDriverError(
      "select_text",
      Object.assign(new Error("unsupported"), { code: "action_unavailable" }),
    );
    expect(refusal.isError).toBe(true);
    expect(refusal._meta).toMatchObject({ errorCode: "action_unavailable", driverError: true });
    expect(refusal.structuredContent).toMatchObject({
      tool: "select_text",
      code: "action_unavailable",
    });
  });

  it("exposes the 14-tool ZCode surface and the actionTitle contract", () => {
    expect(ZCODE_SURFACE_TOOLS).toHaveLength(14);
    expect(ZCODE_SURFACE_TOOLS).toContain("stop_computer_control");
    const declarations = readFileSync(join(packageRoot, "index.d.ts"), "utf8");
    expect(declarations).toMatch(/actionTitle\?: string/u);
    expect(declarations).toMatch(
      /deliveryKind\?: "web-remote-replayable" \| "desktop-continuous"/u,
    );
  });
});

// 后端唯一性守卫：旧驱动文件面必须在，官方占位面必须不在。
describe("single backend guard", () => {
  const required = [
    "index.js",
    "runtime.js",
    "surface.js",
    "surface-target.js",
    "platform.js",
    "permissions.js",
    "driver-host.js",
    "helper-transport.js",
    "macos-permissions.js",
    "compatible/executor.js",
    "compatible/helper/cua-wayland-input.js",
    "test/runtime.test.mjs",
    "test/surface.test.mjs",
    "test/platform.test.mjs",
    "test/windows-parity.test.mjs",
  ];
  const forbidden = [
    "broker.js",
    "broker.d.ts",
    "broker-server.js",
    "broker-server.d.ts",
    "broker-ports.js",
    "broker-socket-path.js",
    "broker-helper-constants.js",
    "broker-helper-health.js",
    "pip-session.js",
    "pip-session.d.ts",
    "pip-session-node.js",
    "pip-session-node.d.ts",
    "test/availability.test.ts",
    "test/official-contract.test.ts",
  ];

  for (const file of required) {
    it(`keeps ${file}`, () => {
      expect(existsSync(join(packageRoot, file))).toBe(true);
    });
  }

  for (const file of forbidden) {
    it(`has no official placeholder ${file}`, () => {
      expect(existsSync(join(packageRoot, file))).toBe(false);
    });
  }

  it("keeps the driver dependency and the host-facing exports", () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      exports: Record<string, unknown>;
      scripts: Record<string, string>;
      zcodeCuaPlaceholder?: boolean;
    };
    expect(pkg.dependencies["@trycua/cua-driver"]).toBeTypeOf("string");
    expect(pkg.zcodeCuaPlaceholder).toBeUndefined();
    expect(pkg.scripts.test).toBe("node --test test/*.test.mjs");
    for (const specifier of [
      ".",
      "./platform",
      "./frame-contract",
      "./host-display-contract",
      "./request-access-contract",
      "./permissions",
      "./driver-host",
      "./macos-permissions",
      "./helper-transport",
    ]) {
      expect(pkg.exports[specifier]).toBeTruthy();
    }
    for (const specifier of ["./broker", "./pip-session", "./pip-session/node"]) {
      expect(pkg.exports[specifier]).toBeUndefined();
    }
  });
});
