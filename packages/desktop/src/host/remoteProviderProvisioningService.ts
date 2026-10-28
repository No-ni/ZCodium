import { randomUUID } from "node:crypto";
import type { ProviderProvisioningResult } from "@zcode/shared";
import type { IProviderProvisioningTargetService, IServiceAccessor } from "@zcode/services";
import {
  getProviderProvisioningSource,
  type ProviderProvisioningSource,
} from "@zcode/services/node";
import type { ServiceCollection } from "@zcode/services";

interface RemoteProviderProvisioningExecutor {
  syncLocalToRemote(assertAuthorized?: () => Promise<void>): Promise<ProviderProvisioningResult>;
}

const executors = new WeakMap<ServiceCollection, RemoteProviderProvisioningExecutor>();

/** Window Host 私有执行能力；不会随 ServiceCollection 暴露到 Renderer RPC。 */
export function getRemoteProviderProvisioningExecutor(
  services: ServiceCollection,
): RemoteProviderProvisioningExecutor | undefined {
  return executors.get(services);
}

export function registerRemoteProviderProvisioningExecutor(
  services: ServiceCollection,
  executor: RemoteProviderProvisioningExecutor,
): void {
  executors.set(services, executor);
}

function createRemoteProviderProvisioningExecutor(options: {
  source?: ProviderProvisioningSource;
  target?: IProviderProvisioningTargetService;
}): RemoteProviderProvisioningExecutor {
  const syncLocalToRemote = async (
    assertAuthorized?: () => Promise<void>,
  ): Promise<ProviderProvisioningResult> => {
    const syncId = randomUUID();
    if (!options.source || !options.target) {
      return unsupportedResult(syncId, "Local/Remote Provider Provisioning capability 不可用");
    }
    try {
      await assertAuthorized?.();
      const envelope = await options.source.read(syncId);
      // 本机文件读取期间 Profile 可能撤权，发送到目标前必须再次核验。
      await assertAuthorized?.();
      return await options.target.apply(envelope);
    } catch {
      return {
        syncId,
        status: "failed",
        personalProviderCount: 0,
        errorMessage: "Provider Provisioning 执行失败",
        rolledBack: true,
      } satisfies ProviderProvisioningResult;
    }
  };

  return { syncLocalToRemote };
}

export function createRemoteProviderProvisioningExecutorFromWorkspace(options: {
  connectionServices: IServiceAccessor;
  sourceServices?: ServiceCollection;
}): RemoteProviderProvisioningExecutor {
  const source = options.sourceServices
    ? getProviderProvisioningSource(options.sourceServices)
    : undefined;
  const target = (
    options.connectionServices as IServiceAccessor & {
      providerProvisioningTargetService?: IProviderProvisioningTargetService;
    }
  ).providerProvisioningTargetService;
  return createRemoteProviderProvisioningExecutor({ source, target });
}

function unsupportedResult(syncId: string, errorMessage: string): ProviderProvisioningResult {
  return {
    syncId,
    status: "unsupported",
    personalProviderCount: 0,
    errorMessage,
    rolledBack: false,
  };
}
