import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger, LoggerFactory } from "@zcode/contracts";
import {
  createDefaultProviderEndpointRoutingPort,
  resolveProcessProviderEndpointRoutingPort,
} from "../src/provider-endpoint-routing.js";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));

const logger: Logger = {
  child: () => logger,
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

const loggerFactory: LoggerFactory = {
  createLogger: () => logger,
  setLevel: vi.fn(),
  withContext: () => logger,
};

function resolvePort(options: Parameters<typeof resolveProcessProviderEndpointRoutingPort>[0]) {
  return resolveProcessProviderEndpointRoutingPort(options);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("默认路由端口的无状态边界", () => {
  it("官方 origin 与 network 参数不同也返回同一个直连端口", () => {
    const first = resolvePort({
      appVersion: "1.2.3",
      env: { ZCODE_ENV: "test", ZCODE_BASE_URL: "https://first.example.test" },
      logger,
      network: {},
      sourceTitle: "cli",
    });
    const second = resolvePort({
      appVersion: "9.9.9",
      env: { ZCODE_ENV: "production", ZCODE_BASE_URL: "https://second.example.test" },
      logger,
      network: { httpProxy: "http://proxy.example.test:8080", noProxy: "second.example.test" },
      sourceTitle: "electron",
    });

    expect(second).toBe(first);
  });

  it("装配不读配置、不发网络请求也不写日志", () => {
    const fetchMock = vi.fn(() => {
      throw new Error("默认路由端口不应发起网络请求");
    });
    vi.stubGlobal("fetch", fetchMock);

    const resolved = resolvePort({
      appVersion: "3.17.1",
      env: { ZCODE_ENV: "test", ZCODE_BASE_URL: "https://routing-config.example.test" },
      logger,
      network: { httpProxy: "http://proxy.example.test:8080" },
      sourceTitle: "cli",
    });
    const created = createDefaultProviderEndpointRoutingPort({
      appVersion: "3.17.1",
      env: { ZCODE_ENV: "test" },
      loggerFactory,
      sourceTitle: "electron",
      workingDirectory: TEST_DIR,
    });

    expect(created).toBe(resolved);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("端口只暴露 resolve 且保持冻结", () => {
    const port = resolvePort({ logger, network: {} });

    expect(Object.isFrozen(port)).toBe(true);
    expect(Reflect.ownKeys(port)).toEqual(["resolve"]);
  });
});

describe("默认路由端口 resolve 行为", () => {
  it("完整保留含 query 的地址，routed=false 且不注入 Header", async () => {
    const port = resolvePort({ logger, network: {} });
    const url = "https://user-endpoint.example.test/v1/chat/completions?beta=true&stream=true";

    const decision = await port.resolve(url, {
      apiKeyId: "account:fixture",
      signal: new AbortController().signal,
    });

    expect(decision).toEqual({ routed: false, url });
    expect(decision).not.toHaveProperty("headers");
    expect(Object.keys(decision).sort()).toEqual(["routed", "url"]);
  });

  it("重复解析只返回原地址，不缓存也不改写", async () => {
    const port = resolvePort({ logger, network: {} });
    const url = "https://user-endpoint.example.test/v1/messages?beta=true";

    expect(await port.resolve(url)).toEqual({ routed: false, url });
    expect(await port.resolve(url, { apiKeyId: "account:fixture" })).toEqual({
      routed: false,
      url,
    });
  });

  it("已取消的 signal 按原 reason 拒绝", async () => {
    const port = resolvePort({ logger, network: {} });
    const controller = new AbortController();
    const reason = new Error("fixture: 请求在派发前已取消");
    controller.abort(reason);

    await expect(
      port.resolve("https://user-endpoint.example.test/v1", { signal: controller.signal }),
    ).rejects.toBe(reason);
  });

  it("未取消的 signal 不影响直连", async () => {
    const port = resolvePort({ logger, network: {} });
    const url = "https://user-endpoint.example.test/v1";

    await expect(port.resolve(url, { signal: new AbortController().signal })).resolves.toEqual({
      routed: false,
      url,
    });
  });
});

describe("createDefaultProviderEndpointRoutingPort 配置边界", () => {
  it("传入 project 内不存在的配置路径同样成功，且不创建任何文件", () => {
    // 修复依据：默认端口没有配置 IO。路径刻意指向 project 内不存在的目录，任何读取或写入都会让它出现。
    const fixtureDir = resolve(TEST_DIR, ".endpoint-routing-noop-fixture");
    const projectConfigPath = resolve(fixtureDir, "project-config.json");
    const userConfigPath = resolve(fixtureDir, "user-config.json");
    expect(existsSync(projectConfigPath)).toBe(false);
    expect(existsSync(userConfigPath)).toBe(false);

    const port = createDefaultProviderEndpointRoutingPort({
      appVersion: "3.17.1",
      env: { ZCODE_ENV: "test" },
      loggerFactory,
      projectConfigPath,
      skipUserConfig: false,
      sourceTitle: "cli",
      userConfigPath,
      workingDirectory: fixtureDir,
    });

    expect(port).toBe(
      resolvePort({
        env: { ZCODE_ENV: "production", ZCODE_BASE_URL: "https://other.example.test" },
        logger,
        network: { httpProxy: "http://proxy.example.test:8080" },
      }),
    );
    expect(existsSync(fixtureDir)).toBe(false);
  });
});
