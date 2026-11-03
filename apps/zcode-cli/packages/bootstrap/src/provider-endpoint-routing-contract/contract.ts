/** 只解析用户自选 Provider 的现有路由端口；无官方鉴权、账号或自动端点回退。公开调用类型沿当前源码，不另造状态或执行入口。 */
// 原因：跨包源码类型引用会被 Bootstrap 纳入 rootDir；公开 package exports 只解析 adapters 的声明产物。
export type ProviderEndpointRoutingEntry1 =
  typeof import("@zcode/adapters/provider-endpoint-routing");
export type ProviderEndpointRoutingEntry2 =
  typeof import("@zcode/adapters/provider-endpoint-routing-options");
export type { ProviderEndpointRoutingFactoryOptions } from "@zcode/adapters/provider-endpoint-routing-options";
export type ProviderEndpointRoutingEntry3 = typeof import("../provider-endpoint-routing.js");
export type { ResolveProcessProviderEndpointRoutingPortOptions } from "../provider-endpoint-routing.js";
export type { CreateDefaultProviderEndpointRoutingPortOptions } from "../provider-endpoint-routing.js";
