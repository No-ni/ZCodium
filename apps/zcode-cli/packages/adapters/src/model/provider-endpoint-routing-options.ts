/** 默认 transport 不采集官方身份或请求归因；宿主仍可显式注入自建路由端口。 */
export type ProviderEndpointRoutingFactoryOptions = Readonly<Record<string, never>>;
