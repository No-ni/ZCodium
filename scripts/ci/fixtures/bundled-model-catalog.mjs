import assert from "node:assert/strict";
import { after, mock } from "node:test";
import { readFile } from "node:fs/promises";
import { tsImport } from "tsx/esm/api";

const fetch = mock.method(globalThis, "fetch", async () => {
  throw new Error("Bundled model catalog must remain offline");
});
after(() => {
  assert.equal(fetch.mock.callCount(), 0);
  fetch.mock.restore();
});

export const provider = await tsImport("../../../packages/provider/src/index.ts", import.meta.url);
export const { NodeZCodeBuiltinProviderConfigSource } = await tsImport(
  "../../../packages/provider-node/src/index.ts",
  import.meta.url,
);
export const { compileModelOptionMaps } = await tsImport(
  "../../../packages/model-option-map/src/index.ts",
  import.meta.url,
);
export const { createModelCatalogPort } = await tsImport(
  "../../../apps/zcode-cli/packages/bootstrap/src/app/model-catalog-port.ts",
  import.meta.url,
);
export const { listRegistryBackedModels, completeAuxiliaryRegistryModelSelection } = await tsImport(
  "../../../apps/zcode-cli/packages/bootstrap/src/app/provider-registry-selection.ts",
  import.meta.url,
);
export const bundledUrl = new URL("../../../config/provider/zcode-builtin.json", import.meta.url);
export const bundled = JSON.parse(await readFile(bundledUrl, "utf8"));
export const { providers, providerTemplates } = provider.parseZCodeBuiltinProviderConfigRules(
  bundled.config.providerConfigRules,
);
export const rules = provider.parseZCodeBuiltinModelConfigRules(bundled.config.modelConfigRules);
export const newIds = ["mimo-v2.6-pro", "mimo-v2.6-flash"];
export const apiIds = [...newIds, "mimo-v2.5-pro", "mimo-v2.5"];
export const templates = [
  ["xiaomi-mimo", "Xiaomi MiMo API", "https://api.xiaomimimo.com/anthropic", apiIds],
  [
    "xiaomi-mimo-token-plan",
    "Xiaomi MiMo Token Plan",
    "https://token-plan-cn.xiaomimimo.com/anthropic",
    newIds,
  ],
];
export const plain = (value) => JSON.parse(JSON.stringify(value));

export function resolveModel(
  modelId,
  apiType = "anthropic-messages",
  baseUrl = "https://catalog.example.invalid/v1",
  templateId,
) {
  const result = provider.createRegistryModelConfig(
    rules.resolve({ providerId: "fixture", modelId, apiType, baseUrl, templateId }),
  );
  assert.equal(result.ok, true, `${modelId}: complete model configuration`);
  return result.config;
}

export function personalProvider(templateId, providerId = templateId, config = {}) {
  return {
    providerId,
    templateId,
    providerName: `Fixture ${providerId}`,
    config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey: "fixture-key" },
      ...config,
    },
  };
}

export function resolveProviders(
  providerRules,
  personalModels = provider.ModelConfigRules.empty(),
) {
  const personal = provider.parsePersonalProviderConfigMap({ providerRules });
  const before = personal.toJSON();
  const result = new provider.ProviderConfigResolver().resolve({
    zcodeBuiltinProviders: providers,
    zcodeBuiltinProviderTemplates: providerTemplates,
    personalProviders: personal,
    personalModels,
    zcodeBuiltinModelRules: rules,
    accountProviders: provider.ProviderConfigMap.empty(),
  });
  assert.deepEqual(personal.toJSON(), before, "resolution must not rewrite personal config");
  return result;
}

export function mimoRegistry() {
  return new provider.ProviderRegistry(
    resolveProviders(templates.map(([id]) => personalProvider(id))).registryProviders,
  );
}
