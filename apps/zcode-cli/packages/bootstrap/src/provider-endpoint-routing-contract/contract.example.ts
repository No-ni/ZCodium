import type { ProviderEndpointRoutingEntry1 } from "./contract.js";
/** 调用方持有既有入口；示例只转交一次相同意图，不装配进程或读真实目录。 */
export function exampleProviderEndpointRouting(api: ProviderEndpointRoutingEntry1, ...args: Parameters<ProviderEndpointRoutingEntry1["createProviderEndpointRoutingPort"]>): ReturnType<ProviderEndpointRoutingEntry1["createProviderEndpointRoutingPort"]> {
return api.createProviderEndpointRoutingPort(...args);
}
