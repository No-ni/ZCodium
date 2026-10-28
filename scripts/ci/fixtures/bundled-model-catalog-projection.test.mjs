import assert from "node:assert/strict";
import test from "node:test";
import {
  apiIds,
  compileModelOptionMaps,
  completeAuxiliaryRegistryModelSelection,
  createModelCatalogPort,
  listRegistryBackedModels,
  mimoRegistry,
  newIds,
  plain,
  personalProvider,
  provider,
  providerTemplates,
  resolveModel,
  resolveProviders,
  templates,
} from "./bundled-model-catalog.mjs";

test("CLI picker, tool catalog and new selection share the highest public level; auxiliary uses lowest", () => {
  const registry = mimoRegistry();
  const catalog = createModelCatalogPort({
    registry,
    currentSelection: () => undefined,
  }).listModels();
  const picker = listRegistryBackedModels(registry);
  assert.equal(catalog.length, apiIds.length + newIds.length);
  for (const entry of catalog) {
    const selection = { providerId: entry.providerId, modelId: entry.modelId };
    assert.deepEqual(entry.reasoningLevels, ["disabled", "enabled"]);
    assert.equal(entry.defaultReasoningLevel, "enabled");
    assert.equal(entry.current, false);
    assert.equal(Object.hasOwn(entry, "disabledReason"), false);
    const option = picker.find(
      (candidate) =>
        candidate.ref.providerId === entry.providerId && candidate.ref.modelId === entry.modelId,
    );
    assert.equal(option.reasoning.defaultLevel, entry.defaultReasoningLevel);
    assert.deepEqual(
      option.reasoning.levels.map((level) => level.value),
      entry.reasoningLevels,
    );
    assert.deepEqual(provider.completeNewModelSelection(registry.getView(), selection), {
      ...selection,
      options: { reasoningLevel: "enabled" },
    });
    assert.deepEqual(
      completeAuxiliaryRegistryModelSelection(registry, {
        ...selection,
        options: { maxOutputTokens: 1024 },
      }),
      { ...selection, options: { maxOutputTokens: 1024, reasoningLevel: "disabled" } },
    );
    assert.deepEqual(provider.normalizeModelSelection(registry.getView(), selection), selection);
    assert.equal(registry.validateSelection(selection).code, "reasoning-level-missing");
    const invalid = { ...selection, options: { reasoningLevel: "unsupported" } };
    assert.equal(registry.validateSelection(invalid).code, "reasoning-level-not-supported");
    assert.deepEqual(provider.normalizeModelSelection(registry.getView(), invalid), selection);
    const valid = { ...selection, options: { reasoningLevel: "disabled" } };
    assert.equal(provider.normalizeModelSelection(registry.getView(), valid), valid);
  }
  const configuredDefault = {
    providerId: templates[0][0],
    modelId: "mimo-v2.5-pro",
    options: { reasoningLevel: "disabled" },
  };
  assert.deepEqual(
    provider.resolveInitialModelSelection({ registry: registry.getView(), configuredDefault }),
    {
      source: "configured-default",
      selection: configuredDefault,
    },
  );
});

test("catalog reads live registry/current identity and copies its public level arrays", () => {
  const registry = mimoRegistry();
  let current = {
    providerId: templates[0][0],
    modelId: newIds[0],
    options: { reasoningLevel: "disabled" },
  };
  const port = createModelCatalogPort({ registry, currentSelection: () => current });
  const first = port.listModels();
  assert.equal(first.filter((entry) => entry.current).length, 1);
  assert.equal(first.find((entry) => entry.current).providerId, current.providerId);
  first[0].reasoningLevels.push("caller-only");
  assert.deepEqual(
    registry.getModel(current.providerId, current.modelId).config.optionSpecs.reasoningLevel.values,
    ["disabled", "enabled"],
  );
  current = {
    providerId: templates[1][0],
    modelId: newIds[0],
    options: { reasoningLevel: "enabled" },
  };
  assert.equal(port.listModels().find((entry) => entry.current).providerId, current.providerId);
  registry.replace([registry.getProvider(templates[0][0])], "fixture-remove-provider");
  assert.equal(
    port.listModels().some((entry) => entry.providerId === current.providerId),
    false,
  );
  assert.equal(
    port.listModels().some((entry) => entry.current),
    false,
  );
  assert.equal(first.length, apiIds.length + newIds.length);
});

test("existing model families keep their public levels, defaults, context and API-specific maps", () => {
  const cases = [
    ["GLM-5.3", "anthropic-messages", 1000000, ["low", "high", "max"]],
    ["gpt-6-astra", "openai-responses", 1050000, ["low", "medium", "high", "xhigh", "max"]],
    ["gpt-5.6-sol", "openai-responses", 1050000, ["none", "low", "medium", "high", "xhigh", "max"]],
    ["claude-fable-5-1", "anthropic-messages", 1000000, ["low", "medium", "high", "xhigh", "max"]],
    ["grok-4.6", "openai-responses", 500000, ["low", "medium", "high", "xhigh"]],
    ["kimi-k3", "anthropic-messages", 1048576, ["low", "high", "max"]],
    ["MiniMax-M3", "anthropic-messages", 1000000, ["disabled", "enabled"]],
    ["deepseek-v4-pro", "anthropic-messages", 1000000, ["disabled", "low", "high", "max"]],
    ["qwen3.8-max", "openai-chat-completions", 1000000, ["low", "medium", "xhigh"]],
  ];
  const models = cases.map(([id, apiType, contextWindow, levels]) => {
    const model = resolveModel(id, apiType);
    assert.equal(model.properties.contextWindow, contextWindow, id);
    assert.deepEqual(model.optionSpecs.reasoningLevel.values, levels, id);
    const maps = compileModelOptionMaps(model.optionSpecs);
    for (const reasoningLevel of levels) {
      const output = plain(maps.apply({}, { reasoningLevel, maxOutputTokens: 1024 }));
      if (apiType === "openai-responses") {
        assert.deepEqual(
          output,
          { reasoning: { effort: reasoningLevel }, max_output_tokens: 1024 },
          id,
        );
      } else if (id === "claude-fable-5-1" || id === "GLM-5.3") {
        assert.deepEqual(
          output,
          {
            thinking: { type: id === "GLM-5.3" ? "enabled" : "adaptive" },
            output_config: { effort: reasoningLevel },
            max_tokens: 1024,
          },
          id,
        );
      } else if (id === "kimi-k3") {
        assert.deepEqual(
          output,
          { output_config: { effort: reasoningLevel }, max_tokens: 1024 },
          id,
        );
      } else if (id === "deepseek-v4-pro") {
        assert.deepEqual(
          output,
          {
            thinking: { type: reasoningLevel === "disabled" ? "disabled" : "enabled" },
            ...(reasoningLevel === "disabled" ? {} : { output_config: { effort: reasoningLevel } }),
            max_tokens: 1024,
          },
          id,
        );
      } else {
        assert.ok(output);
      }
    }
    return { modelId: id, config: model };
  });
  const registry = new provider.ProviderRegistry(
    resolveProviders([personalProvider("xiaomi-mimo", "fixture-families")]).registryProviders,
  );
  registry.replace(
    [{ ...registry.getProvider("fixture-families"), models }],
    "fixture-family-models",
  );
  const catalog = createModelCatalogPort({
    registry,
    currentSelection: () => undefined,
  }).listModels();
  const picker = listRegistryBackedModels(registry);
  for (const [id, , , levels] of cases) {
    const selection = { providerId: "fixture-families", modelId: id };
    assert.equal(
      catalog.find((entry) => entry.modelId === id).defaultReasoningLevel,
      levels.at(-1),
    );
    assert.equal(
      picker.find((entry) => entry.ref.modelId === id).reasoning.defaultLevel,
      levels.at(-1),
    );
    assert.equal(
      provider.completeNewModelSelection(registry.getView(), selection).options.reasoningLevel,
      levels.at(-1),
    );
    assert.equal(
      completeAuxiliaryRegistryModelSelection(registry, selection).options.reasoningLevel,
      levels[0],
    );
  }
});

test("personal reasoning overrides and single-level models determine defaults without hard-coded effort", () => {
  const levelsById = [
    [newIds[0], ["only"]],
    [newIds[1], ["minimum", "maximum"]],
  ];
  const personalModels = provider.parsePersonalModelConfigRules({
    providerModelRules: levelsById.map(([modelId, values]) => ({
      providerId: "fixture-overrides",
      modelId,
      config: {
        optionSpecs: {
          reasoningLevel: {
            values,
            map: "{'output_config': {'effort': reasoningLevel}}",
          },
        },
      },
    })),
    manualProviderModelRules: [],
  });
  const registry = new provider.ProviderRegistry(
    resolveProviders(
      [personalProvider("xiaomi-mimo-token-plan", "fixture-overrides")],
      personalModels,
    ).registryProviders,
  );
  const catalog = createModelCatalogPort({
    registry,
    currentSelection: () => undefined,
  }).listModels();
  const picker = listRegistryBackedModels(registry);
  for (const [modelId, levels] of levelsById) {
    const selection = { providerId: "fixture-overrides", modelId };
    assert.equal(
      catalog.find((entry) => entry.modelId === modelId).defaultReasoningLevel,
      levels.at(-1),
    );
    assert.equal(
      picker.find((entry) => entry.ref.modelId === modelId).reasoning.defaultLevel,
      levels.at(-1),
    );
    assert.equal(
      provider.completeNewModelSelection(registry.getView(), selection).options.reasoningLevel,
      levels.at(-1),
    );
    assert.equal(
      completeAuxiliaryRegistryModelSelection(registry, selection).options.reasoningLevel,
      levels[0],
    );
    assert.equal(
      registry.validateSelection({ ...selection, options: { reasoningLevel: "enabled" } }).code,
      "reasoning-level-not-supported",
    );
    assert.deepEqual(provider.normalizeModelSelection(registry.getView(), selection), selection);
  }
});

test("existing nine Gemini models retain Google-native catalog scope, budgets and two-level maps", () => {
  const googleTemplates = [
    ["opencode-go-google", ["gemini-4-argon-contributor"]],
    [
      "opencode-zen-google",
      [
        "gemini-4-argon",
        "gemini-3.8-flash",
        "gemini-3.7-flash",
        "gemini-3.6-flash",
        "gemini-3.5-flash",
        "gemini-3.5-flash-lite",
        "gemini-3.1-pro",
        "gemini-3-flash",
      ],
    ],
  ];
  for (const [id, ids] of googleTemplates) {
    const template = providerTemplates.get(id);
    assert.deepEqual(template.config.builtinModelIds, ids);
    assert.equal(template.config.api.type, "google-generative-ai");
    for (const modelId of ids) {
      const model = resolveModel(
        modelId,
        template.config.api.type,
        template.config.api.baseUrl,
        id,
      );
      assert.equal(model.properties.contextWindow, 1048576);
      assert.equal(
        model.optionSpecs.maxOutputTokens.max,
        modelId.startsWith("gemini-4-argon") ? 32768 : 65536,
      );
      assert.deepEqual(model.optionSpecs.reasoningLevel.values, ["disabled", "enabled"]);
      const maps = compileModelOptionMaps(model.optionSpecs);
      assert.deepEqual(
        plain(maps.apply({ contents: [] }, { reasoningLevel: "disabled", maxOutputTokens: 1024 })),
        {
          contents: [],
          generationConfig: { maxOutputTokens: 1024 },
        },
      );
      assert.deepEqual(
        plain(maps.apply({ contents: [] }, { reasoningLevel: "enabled", maxOutputTokens: 1024 })),
        {
          contents: [],
          generationConfig: {
            thinkingConfig: { thinkingLevel: "high", includeThoughts: true },
            maxOutputTokens: 1024,
          },
        },
      );
    }
  }
  const id = "gemini-3.8-flash";
  assert.equal(
    resolveModel(id, "google-generative-ai", "https://OPENCODE.AI:443/inference/google/v1beta/")
      .properties.contextWindow,
    1048576,
  );
  for (const url of [
    "https://google.example.invalid/v1beta",
    "https://opencode.ai/inference/Google/v1beta",
    "https://opencode.ai/inference/google/v1beta?fixture=1",
  ]) {
    assert.equal(resolveModel(id, "google-generative-ai", url).properties.contextWindow, 200000);
  }
  assert.equal(
    resolveModel(id, "openai-responses", "https://opencode.ai/inference/google/v1beta").properties
      .contextWindow,
    200000,
  );
});
