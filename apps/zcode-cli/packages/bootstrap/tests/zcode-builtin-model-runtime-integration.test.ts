import type { CreateAiSdkModelOptions } from "@zcode/adapters/model";
import type { Model } from "@zcode/contracts";
import { fileURLToPath } from "node:url";
import {
  ApiKeyAccessConfig,
  ModelConfigRules,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigResolver,
  ProviderRegistry,
  type ProviderId,
} from "@zcode/provider";
import {
  NodeZCodeBuiltinProviderConfigSource,
  type ZCodeBuiltinProviderConfigSnapshot,
} from "@zcode/provider-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiProviderModelRuntime } from "../src/app/provider-registry-model-runtime.js";

const zcodeBuiltinProviderConfigFilePath = fileURLToPath(
  new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
);
const source = new NodeZCodeBuiltinProviderConfigSource({
  bundledFilePath: zcodeBuiltinProviderConfigFilePath,
  watch: false,
});
let zcodeBuiltin: ZCodeBuiltinProviderConfigSnapshot;

beforeAll(async () => {
  zcodeBuiltin = await source.read();
});

afterAll(() => source.dispose());

describe("真实 ZCode Built-in Config 到 Active Model", () => {
  it("API Key Personal Overlay 经 Registry 原样装配到 Adapter", () => {
    const providerId = "zai-api";
    const modelId = "glm-5.3";
    const registry = resolveOneBuiltinProvider(providerId, {
      personalProviders: new ProviderConfigMap([
        [
          providerId,
          // 实例在创建时复制模板；Resolver 不会从已退场的 templateId 字段隐式继承。
          zcodeBuiltin.providerTemplates
            .get("zai-api")!
            .config.withPersonalModelIds([modelId])
            .overlay(
              new ProviderConfig({
                group: "standard-personal",
                access: new ApiKeyAccessConfig({ apiKey: "test-zai-api-key" }),
              }),
            ),
        ],
      ]),
    });
    const capture = captureRuntime(registry);

    const model = capture.runtime.modelFactory({
      selection: selectionWithHighestReasoning(registry, providerId, modelId),
    });
    const registryProvider = registry.getProvider(providerId);
    const registryModel = registry.getModel(providerId, modelId);

    expect(model).toBe(capture.models[0]);
    expect(capture.created[0]?.providerConfig).toBe(registryProvider?.config);
    expect(capture.created[0]?.modelConfig).toBe(registryModel?.config);
    expect(capture.created[0]).toMatchObject({
      providerId,
      modelId,
      providerConfig: {
        access: { type: "api-key", apiKey: "test-zai-api-key" },
        api: {
          type: zcodeBuiltin.providerTemplates.get("zai-api")?.config.api?.type,
          baseUrl: zcodeBuiltin.providerTemplates.get("zai-api")?.config.api?.baseUrl,
        },
      },
    });
  });


});

function selectionWithHighestReasoning(
  registry: ProviderRegistry,
  providerId: ProviderId,
  modelId: string,
) {
  const reasoningLevel = registry
    .getModel(providerId, modelId)
    ?.config.optionSpecs.reasoningLevel.values.at(-1);
  if (!reasoningLevel) throw new Error(`测试模型缺少 reasoning: ${providerId}/${modelId}`);
  return { providerId, modelId, options: { reasoningLevel } };
}

function resolveOneBuiltinProvider(
  providerId: ProviderId,
  overlays: {
    personalProviders?: ProviderConfigMap;
    models?: ModelConfigRules;
  } = {},
): ProviderRegistry {
  const provider = zcodeBuiltin.providers.get(providerId);
  const personalProvider = overlays.personalProviders?.get(providerId);
  if (!provider && !personalProvider) {
    throw new Error(`测试引用的 Built-in Provider 或 Personal 实例不存在: ${providerId}`);
  }
  const resolution = new ProviderConfigResolver().resolve({
    zcodeBuiltinProviders: provider
      ? new ProviderConfigMap([[providerId, provider]])
      : ProviderConfigMap.empty(),
    zcodeBuiltinProviderTemplates: zcodeBuiltin.providerTemplates,
    accountProviders: ProviderConfigMap.empty(),
    personalProviders: overlays.personalProviders ?? ProviderConfigMap.empty(),
    zcodeBuiltinModelRules: zcodeBuiltin.models,
    personalModels: overlays.models ?? ModelConfigRules.empty(),
  });
  expect(resolution.issues).toEqual([]);
  return new ProviderRegistry(resolution.registryProviders);
}

function captureRuntime(registry: ProviderRegistry) {
  const created: CreateAiSdkModelOptions[] = [];
  const models: Model[] = [];
  const runtime = new ApiProviderModelRuntime({
    registry: {
      getView: () => registry.getView(),
      getProvider: (providerId) => registry.getProvider(providerId),
      getModel: (providerId, modelId) => registry.getModel(providerId, modelId),
      validateSelection: (selection) => registry.validateSelection(selection),
      onDidChange: (listener) => registry.onDidChange(listener),
    },
    modelAdapter: {
      createModel(options) {
        created.push(options);
        const model = createCapturedModel(options);
        models.push(model);
        return model;
      },
    },
  });
  runtime.start();
  return { created, models, runtime };
}

function createCapturedModel(options: CreateAiSdkModelOptions): Model {
  const model: Model = {
    providerId: options.providerId,
    modelId: options.modelId,
    properties: options.modelConfig.properties,
    optionSpecs: options.modelConfig.optionSpecs,
    options: options.options,
    bind() {
      return model;
    },
    async generateText() {
      throw new Error("not used");
    },
    streamText() {
      throw new Error("not used");
    },
  };
  return model;
}
