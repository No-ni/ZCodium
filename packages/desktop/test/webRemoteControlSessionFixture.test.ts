import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createProjectTestSandbox } from "../../../scripts/ci/project-test-sandbox.mjs";
import { prepareWebRemoteControlSessionFixture } from "./e2e/helpers/web-remote-control-session-fixture.js";

it("does not prepare a network fixture for retired account-only scenarios", async () => {
  expect(
    await prepareWebRemoteControlSessionFixture({
      specs: ["web-remote-control-auth-gate.test.ts"],
      credentialsFile: "unused",
      settingsFile: "unused",
      workspacePath: "unused",
    }),
  ).toBeNull();
});

it("uses anonymous self-hosted mobile pairing and restores its environment on close", async () => {
  const sandbox = await createProjectTestSandbox("mobile-session-contract");
  const credentialsFile = join(sandbox.data, "credentials.json");
  const settingsFile = join(sandbox.data, "setting.json");
  const previousUrl = process.env.ZCODIUM_E2E_MOBILE_URL;
  let close: (() => Promise<void>) | null = null;
  try {
    await writeFile(settingsFile, JSON.stringify({ locale: "zh-CN" }));
    close = await prepareWebRemoteControlSessionFixture({
      specs: ["conversation-session-web-remote-unread.test.ts"],
      credentialsFile,
      settingsFile,
      workspacePath: sandbox.root,
      webUrl: "http://127.0.0.1:0/remote/v4",
    });
    expect(close).not.toBeNull();
    const origin = process.env.ZCODIUM_E2E_MOBILE_URL!;
    expect(new URL(origin).hostname).toBe("127.0.0.1");
    expect(Number(new URL(origin).port)).toBeGreaterThan(0);
    expect(JSON.parse(await readFile(credentialsFile, "utf8"))).toEqual({});
    expect(JSON.parse(await readFile(settingsFile, "utf8"))).toEqual({
      locale: "zh-CN",
      webRemoteControlEndpointMode: "custom",
      webRemoteControlCustomEndpointUrl: `${origin.replace("http:", "ws:")}ws`,
      webRemoteControlLastEnabledContext: { workspacePath: sandbox.root },
    });
    expect((await fetch(new URL("/healthz", origin))).status).toBe(200);
    // 旧夹具模拟官方设备与账号 API；本仓真实匿名 relay 不提供这条控制面。
    expect((await fetch(new URL("/api/v1/remote/token", origin), { method: "POST" })).status).toBe(
      404,
    );
    const page = await (await fetch(origin)).text();
    expect(page).toContain("mobile");
    await close!();
    close = null;
    expect(process.env.ZCODIUM_E2E_MOBILE_URL).toBe(previousUrl);
    await expect(fetch(new URL("/healthz", origin))).rejects.toThrow();
  } finally {
    await close?.();
  }
}, 90_000);
