import assert from "node:assert/strict";
import {
  ApiKeyAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  ModelConfig,
  ModelPropertiesConfig,
  ModelOptionSpecsConfig,
  createRegistryModelConfig,
  createRegistryProviderConfig,
  ProviderRegistry,
} from "@zcode/provider";
import { BATCH_MAIN, BATCH_MAINTENANCE } from "./native-context-tool-batch-model.js";

/** 通过当前 Registry 完整配置校验；不复用 legacy 测试中已过时的 Provider 字段。 */
export function createBatchProviderRegistry() {
  const provider = createRegistryProviderConfig(
    new ProviderConfig({
      group: "standard-personal",
      access: new ApiKeyAccessConfig({ apiKey: "synthetic-bootstrap-key" }),
      api: new ProviderApiConfig({
        type: "anthropic-messages",
        baseUrl: "https://bootstrap-model.invalid",
      }),
      builtinModelIds: [BATCH_MAIN.modelId, BATCH_MAINTENANCE.modelId],
      visibility: "visible",
    }),
  );
  assert.ok(provider.ok);
  const models = [BATCH_MAIN, BATCH_MAINTENANCE].map((selection) => {
    const configured = createRegistryModelConfig(
      new ModelConfig({
        enabled: true,
        properties: new ModelPropertiesConfig({
          requiresMfjsToolSchema: false,
          contextWindow: 65536,
          inputFormat: {
            supportsText: true,
            supportsImage: false,
            supportsVideo: false,
            supportsAudio: false,
            supportsPdf: false,
          },
          outputFormat: { supportsText: true },
          supportsToolCall: true,
          supportsJsonSchemaOutput: true,
          supportsNativeWebSearch: false,
          supportsMidConversationSystem: false,
        }),
        optionSpecs: new ModelOptionSpecsConfig({
          reasoningLevel: { values: ["medium"], map: '{"reasoning":reasoningLevel}' },
          maxOutputTokens: { max: 1024, map: '{"max_tokens":maxOutputTokens}' },
        }),
      }),
    );
    assert.ok(configured.ok);
    return { modelId: selection.modelId, config: configured.config };
  });
  return new ProviderRegistry([
    { providerId: BATCH_MAIN.providerId, config: provider.config, models },
  ]);
}
