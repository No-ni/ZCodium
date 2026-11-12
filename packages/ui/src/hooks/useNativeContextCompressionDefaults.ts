import { useCallback, useMemo } from "react";
import {
  createRecommendedNativeContextConfiguration,
  nativeContextConfigurationSchema,
  type NativeContextConfiguration,
} from "@zcode/shared/native-context-compression";
import { useBaseWorkspaceServices } from "./useWorkspaceServices.js";
import { useSettings } from "./useSettingService.js";
import { useComposerClientNamespace } from "./useServices.js";
import { useModelSelectionServiceView } from "./useModelSelectionView.js";
import type { NativeContextModelCandidate } from "@/native-context-compression/contract.js";

const RECOMMENDED_DEFAULT = createRecommendedNativeContextConfiguration();

/** 新任务默认始终经本机 Local Host 设置队列保存，不随 workspace 设置 Scope 改写。 */
export function useNativeContextCompressionDefaults() {
  const services = useBaseWorkspaceServices();
  const { settings, loading, error, refresh, readFresh, update } = useSettings({ services });
  const clientNamespace = useComposerClientNamespace();
  const defaults = settings?.nativeContextCompression;
  const configuration = defaults?.configuration ?? RECOMMENDED_DEFAULT;
  const version = defaults?.version ?? 0;
  const save = useCallback(
    async (candidate: NativeContextConfiguration, expectedVersion: number) => {
      const parsed = nativeContextConfigurationSchema.parse(candidate);
      await update(
        { nativeContextCompression: { version: expectedVersion + 1, configuration: parsed } },
        {
          expectedNativeContextCompressionVersion: expectedVersion,
        },
      );
      // 原因：通用设置刷新会在读取失败时保留旧缓存；成功提示及表单都必须使用同一 Host 的确认快照。
      const confirmed = (await readFresh()).nativeContextCompression;
      if (
        !confirmed ||
        confirmed.version <= expectedVersion ||
        JSON.stringify(nativeContextConfigurationSchema.parse(confirmed.configuration)) !==
          JSON.stringify(parsed)
      )
        throw new Error("native-context-defaults-unconfirmed");
      return confirmed.version;
    },
    [readFresh, update],
  );
  return {
    scopeKey: `native-context-defaults:${clientNamespace}`,
    configuration,
    version,
    loading,
    unavailable: loading || error !== null || settings === null,
    refresh,
    save,
  };
}

export function useNativeContextDefaultModels(
  enabled: boolean,
): readonly NativeContextModelCandidate[] {
  const services = useBaseWorkspaceServices();
  const read = useModelSelectionServiceView(
    services.modelSelectionService,
    enabled,
    "missing-target",
  );
  const view = read.state.status === "ready" ? read.state.view : null;
  return useMemo(
    () =>
      view?.providers.flatMap((provider) =>
        provider.models.map((model) => ({
          selection: { providerId: provider.providerId, modelId: model.modelId },
          label: `${provider.providerName?.trim() || provider.providerId} / ${model.modelId}`,
          supportsImages: model.config.properties?.inputFormat?.supportsImage === true,
        })),
      ) ?? [],
    [view],
  );
}
