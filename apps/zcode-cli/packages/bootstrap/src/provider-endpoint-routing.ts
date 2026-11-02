import { createProviderEndpointRoutingPort } from "@zcode/adapters/model";
import type { ConfigResult } from "@zcode/adapters/config";
import type { Logger, LoggerFactory, ProviderEndpointRoutingPort } from "@zcode/contracts";
import type { ModelProviderSourceTitle } from "./model-config.js";

export interface ResolveProcessProviderEndpointRoutingPortOptions {
  appVersion?: string;
  env?: NodeJS.ProcessEnv;
  logger: Logger;
  network: ConfigResult["config"]["network"];
  sourceTitle?: ModelProviderSourceTitle;
}

export interface CreateDefaultProviderEndpointRoutingPortOptions {
  appVersion?: string;
  env?: NodeJS.ProcessEnv;
  loggerFactory?: LoggerFactory;
  projectConfigPath?: string;
  skipUserConfig?: boolean;
  sourceTitle?: ModelProviderSourceTitle;
  userConfigPath?: string;
  workingDirectory: string;
}

// 启动调用保持现有注入签名；默认直连端口没有配置、网络、凭据或设备身份 IO。
export function resolveProcessProviderEndpointRoutingPort(
  _options: ResolveProcessProviderEndpointRoutingPortOptions,
): ProviderEndpointRoutingPort {
  return createProviderEndpointRoutingPort();
}

export function createDefaultProviderEndpointRoutingPort(
  _options: CreateDefaultProviderEndpointRoutingPortOptions,
): ProviderEndpointRoutingPort {
  return createProviderEndpointRoutingPort();
}
