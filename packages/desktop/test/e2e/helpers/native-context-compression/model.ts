import { modelSelectionSchema } from "@zcode/shared";
import { readModelProvider } from "../desktop-app.js";
import {
  getSelectedUpstreamModelLabel,
  getUpstreamProviderModelValues,
  selectRegistryProviderModelById,
  selectUpstreamThoughtLevelValue,
} from "../upstream-provider.js";
import { getV4ModelConfig, waitForV4ComposerSelectionReady } from "../v4-conversation.js";
import { nativeContextCurrentTarget, type NativeContextTestTarget } from "./queries.js";

export interface NativeContextComposerModel {
  providerId: string;
  modelId: string;
  reasoningLevel: string | null;
}

/** 冷恢复可没有 task 草稿；真实下一请求选择由 Composer 受控值和 Host 目录共同证明。 */
export async function readNativeContextComposerModel(
  target: NativeContextTestTarget,
): Promise<NativeContextComposerModel> {
  await waitForV4ComposerSelectionReady();
  expect(await nativeContextCurrentTarget()).toEqual(target);
  const config = await getV4ModelConfig();
  expect(config.source).toBe("composer");
  const thought = config.thought?.trim();
  const selection = modelSelectionSchema.parse({
    providerId: config.provider,
    modelId: config.model,
    ...(thought ? { options: { reasoningLevel: thought } } : {}),
  });
  const provider = await readModelProvider(selection.providerId);
  const model = provider?.models.find((candidate) => candidate.id === selection.modelId);
  if (
    !model ||
    model.deleted ||
    model.disabledReason ||
    provider?.enabled === false ||
    provider?.systemDisabledReason
  )
    throw new Error("NCTX current Composer selection is not an available real registry model");
  const trigger = await getSelectedUpstreamModelLabel();
  expect(
    getUpstreamProviderModelValues(selection.modelId, {
      providerId: selection.providerId,
      includePlainModelFallback: false,
    }),
  ).toContain(trigger.currentValue);
  expect(await getV4ModelConfig()).toEqual(config);
  expect(await nativeContextCurrentTarget()).toEqual(target);
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    reasoningLevel: selection.options?.reasoningLevel ?? null,
  };
}

export async function restoreNativeContextComposerModel(
  target: NativeContextTestTarget,
  selection: NativeContextComposerModel,
) {
  expect(await nativeContextCurrentTarget()).toEqual(target);
  await selectRegistryProviderModelById(selection.modelId, {
    providerId: selection.providerId,
    includePlainModelFallback: false,
  });
  if (selection.reasoningLevel) await selectUpstreamThoughtLevelValue(selection.reasoningLevel);
  expect(await readNativeContextComposerModel(target)).toEqual(selection);
}
