import { describe, expect, it } from "vitest";
import type { AiSdkModelExecutionConfig } from "@zcode/adapters/model";
import type { ProviderEndpointRoutingPort } from "@zcode/contracts";
import { createRuntimeAiSdkModelExecutionConfig } from "../src/model-config.js";
import { createModelAdapter, type CreateModelAdapterOptions } from "../src/model-factory.js";

// 修复依据：bootstrap 把注入的路由端口透传给 model adapter，但 adapters 的执行配置类型没有声明这个字段。
// 这里只按运行时形状收窄断言，类型收口属于 src 边界，测试不改契约。
type RuntimeExecutionConfig = AiSdkModelExecutionConfig & {
  endpointRoutingPort?: ProviderEndpointRoutingPort;
};

const ENV = { ZCODE_APP_VERSION: "3.17.1", ZCODE_ENV: "test" };
const NETWORK = {
  caCertFile: "/fixture/test-ca.pem",
  httpProxy: "http://proxy.example.test:8080",
  noProxy: "routing-config.example.test",
};

// 端口只充当“显式注入”的身份标记，直连行为回归见 provider-endpoint-routing.test.ts。
const endpointRoutingPort: ProviderEndpointRoutingPort = {
  async resolve(url: string) {
    return { routed: false, url };
  },
};

function createConfig(
  env: Record<string, string | undefined> = ENV,
  options?: Parameters<typeof createRuntimeAiSdkModelExecutionConfig>[1],
): RuntimeExecutionConfig {
  return createRuntimeAiSdkModelExecutionConfig(env, options) as RuntimeExecutionConfig;
}

describe("createModelAdapter", () => {
  it("缺少执行基础设施配置时拒绝创建 Adapter", () => {
    expect(() => createModelAdapter({ env: {} } as CreateModelAdapterOptions)).toThrow(
      "requires executionConfig",
    );
  });
});

describe("createRuntimeAiSdkModelExecutionConfig", () => {
  it("保持 env、network 与显式注入的路由端口", () => {
    const config = createConfig(ENV, {
      appVersion: "3.17.1",
      endpointRoutingPort,
      network: NETWORK,
    });

    expect(config).toEqual({ env: ENV, network: NETWORK, endpointRoutingPort });
    expect(config.endpointRoutingPort).toBe(endpointRoutingPort);
    // env 原样透传，不往里塞设备、系统或地区事实。
    expect(Object.keys(config.env ?? {})).toEqual(["ZCODE_APP_VERSION", "ZCODE_ENV"]);
  });

  it("不注入 defaultHeaders、HTTP-Referer、设备、系统或地区字段", () => {
    const config = createConfig(ENV, {
      appVersion: "3.17.1",
      endpointRoutingPort,
      network: NETWORK,
    });
    const ownKeys = Object.keys(config).map((key) => key.toLowerCase());

    expect(ownKeys.sort()).toEqual(["endpointroutingport", "env", "network"]);
    for (const forbidden of [
      "defaultheaders",
      "headers",
      "http-referer",
      "user-agent",
      "x-title",
      "x-zcode-app-version",
      "device",
      "deviceid",
      "os",
      "osversion",
      "locale",
      "language",
    ]) {
      expect(ownKeys).not.toContain(forbidden);
    }
  });

  it("未注入路由端口时不自行创建端口", () => {
    expect(createConfig(ENV, { appVersion: "3.17.1", network: NETWORK })).toEqual({
      env: ENV,
      network: NETWORK,
    });
  });

  it("过滤空网络配置", () => {
    expect(createConfig(ENV, { network: {} })).not.toHaveProperty("network");
    expect(
      createConfig(ENV, { network: { caCertFile: "", httpProxy: "", noProxy: "" } }),
    ).not.toHaveProperty("network");
    expect(createConfig(ENV)).not.toHaveProperty("network");
  });

  it("网络配置只保留显式给出的字段", () => {
    expect(createConfig(ENV, { network: { httpProxy: NETWORK.httpProxy } })).toEqual({
      env: ENV,
      network: { httpProxy: NETWORK.httpProxy },
    });
  });
});
