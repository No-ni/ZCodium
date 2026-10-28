import { createSourcePersistenceEnv, type SourceDataRoots } from "@zcode/shared/node";
import {
  createNodeProviderRuntimePathEnv,
  type NodeProviderRuntimePaths,
} from "@zcode/provider-node";
import type { ZCodeAgentCommandResolver } from "../zcode-agent/zcodeAgentProcessManager.js";

export function createSourceAgentCommandResolver(options: {
  roots: SourceDataRoots;
  resolver: ZCodeAgentCommandResolver;
  resolveProviderPaths(): Promise<NodeProviderRuntimePaths>;
}): ZCodeAgentCommandResolver {
  return async (context) => {
    const command = await options.resolver(context);
    if (!command) return null;
    const providerEnv = createNodeProviderRuntimePathEnv(await options.resolveProviderPaths());
    const commandEnv = createSourcePersistenceEnv(options.roots.serverRoot, command.env ?? {});
    for (const key of Object.keys(commandEnv)) {
      // 部署命令仍拥有非 persistence env 优先级；Provider 路径只能来自同一 Source runtime。
      if (Object.hasOwn(providerEnv, key.toUpperCase())) delete commandEnv[key];
    }
    return { ...command, env: { ...commandEnv, ...providerEnv } };
  };
}
