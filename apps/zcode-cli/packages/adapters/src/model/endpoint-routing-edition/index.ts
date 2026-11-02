import type { ProviderEndpointRoutingPort } from "@zcode/contracts";
import type { ProviderEndpointRoutingFactoryOptions } from "../provider-endpoint-routing-options.js";

// 修复依据：官方路由只服务账号/配置下发；默认 BYOK 请求必须保留用户地址且不读取凭据。
const directPort: ProviderEndpointRoutingPort = Object.freeze({
  async resolve(url: string, options?: Parameters<ProviderEndpointRoutingPort["resolve"]>[1]) {
    options?.signal?.throwIfAborted();
    return { routed: false, url };
  },
});

export function createProviderEndpointRoutingPort(
  _options: ProviderEndpointRoutingFactoryOptions = {},
): ProviderEndpointRoutingPort {
  return directPort;
}
