import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  apiIds,
  bundled,
  bundledUrl,
  compileModelOptionMaps,
  newIds,
  NodeZCodeBuiltinProviderConfigSource,
  personalProvider,
  plain,
  provider,
  providerTemplates,
  resolveModel,
  resolveProviders,
  templates,
} from "./bundled-model-catalog.mjs";

test("fixed-source MiMo templates add 2.6 without account providers or entitlement gates", async (t) => {
  const source = new NodeZCodeBuiltinProviderConfigSource({
    bundledFilePath: fileURLToPath(bundledUrl),
    watch: false,
  });
  t.after(() => source.dispose());
  const snapshot = await source.read();
  assert.deepEqual(bundled.config.providerConfigRules.providerRules, []);
  assert.deepEqual(bundled.config.modelConfigRules.builtinProviderModelRules, []);
  assert.equal(snapshot.providers.entries().length, 0);
  for (const [id, name, baseUrl, modelIds] of templates) {
    const template = snapshot.providerTemplates.get(id);
    assert.ok(template, id);
    assert.deepEqual(template.templateNameMap, { "zh-CN": name, "en-US": name });
    assert.deepEqual(template.config.api.toJSON(), { type: "anthropic-messages", baseUrl });
    assert.deepEqual(template.config.access.toJSON(), {
      type: "api-key",
      apiKeyManagementUrl: "https://platform.xiaomimimo.com/",
    });
    assert.deepEqual(template.config.builtinModelIds, modelIds);
    assert.deepEqual(template.config.logo, { type: "builtin", key: "xiaomi-mimo" });
    for (const modelId of newIds) {
      const exact = bundled.config.modelConfigRules.templateModelRules.filter(
        (rule) => rule.templateId === id && rule.modelId === modelId,
      );
      assert.deepEqual(
        exact.map((rule) => rule.config),
        [{ enabled: true }],
      );
    }
  }
});

for (const modelId of newIds) {
  test(`${modelId} has fixed-source capabilities and non-adaptive Anthropic thinking maps`, () => {
    for (const [id, , baseUrl] of templates) {
      const model = resolveModel(modelId, "anthropic-messages", baseUrl, id);
      assert.equal(model.enabled, true);
      assert.equal(model.properties.contextWindow, 1000000);
      assert.deepEqual(model.properties.inputFormat.toJSON(), {
        supportsText: true,
        supportsImage: true,
        supportsVideo: true,
        supportsAudio: true,
        supportsPdf: false,
      });
      assert.deepEqual(model.properties.outputFormat.toJSON(), { supportsText: true });
      assert.equal(model.properties.supportsToolCall, true);
      assert.equal(model.properties.supportsJsonSchemaOutput, false);
      assert.equal(model.properties.supportsNativeWebSearch, false);
      assert.equal(model.optionSpecs.maxOutputTokens.max, 131072);
      assert.deepEqual(model.optionSpecs.reasoningLevel.values, ["disabled", "enabled"]);
      const maps = compileModelOptionMaps(model.optionSpecs);
      const body = Object.freeze({ sentinel: Object.freeze({ fixture: true }) });
      // MiMo 不接受 Claude 通用 adaptive；专用 model-api 规则必须在通用规则之后覆盖。
      for (const reasoningLevel of model.optionSpecs.reasoningLevel.values) {
        for (const maxOutputTokens of [1, 1024, 131072]) {
          assert.deepEqual(plain(maps.apply(body, { reasoningLevel, maxOutputTokens })), {
            sentinel: { fixture: true },
            thinking: { type: reasoningLevel },
            max_tokens: maxOutputTokens,
          });
        }
      }
      assert.deepEqual(body, { sentinel: { fixture: true } });
    }
  });
}

test("MiMo 2.6 matching preserves model suffix boundaries and the API-specific scope", () => {
  for (const modelId of [
    "vendor/MIMO-v2.6-pro-20261001",
    "mimo-v2.6-flash[1m]",
    "mimo-v2.6-pro:extended",
  ]) {
    const model = resolveModel(modelId);
    assert.equal(model.properties.inputFormat.supportsAudio, true);
    assert.deepEqual(
      plain(
        compileModelOptionMaps(model.optionSpecs).apply(
          {},
          {
            reasoningLevel: "enabled",
            maxOutputTokens: 1024,
          },
        ),
      ),
      { thinking: { type: "enabled" }, max_tokens: 1024 },
    );
  }
  const generic = resolveModel("unknown-fixture-model");
  for (const modelId of ["mimo-v2.6-profile", "mimo-v2.6-flashlight", "mimo-v2.60-pro"]) {
    assert.deepEqual(resolveModel(modelId).toJSON(), generic.toJSON());
  }
  const responses = resolveModel(newIds[0], "openai-responses");
  assert.deepEqual(
    plain(
      compileModelOptionMaps(responses.optionSpecs).apply(
        {},
        {
          reasoningLevel: "enabled",
          maxOutputTokens: 1024,
        },
      ),
    ),
    { reasoning: { effort: "high" }, max_output_tokens: 1024 },
  );
});

test("old MiMo 2.5 models retain their identities, modalities and public reasoning levels", () => {
  for (const modelId of apiIds.slice(2)) {
    const model = resolveModel(modelId, "anthropic-messages", templates[0][2], templates[0][0]);
    assert.equal(model.properties.contextWindow, 1000000);
    for (const format of ["supportsImage", "supportsVideo", "supportsAudio"]) {
      assert.equal(model.properties.inputFormat[format], modelId === "mimo-v2.5");
    }
    assert.equal(model.optionSpecs.maxOutputTokens.max, 131072);
    assert.deepEqual(model.optionSpecs.reasoningLevel.values, ["disabled", "enabled"]);
  }
});

test("API key MiMo instances are executable without account facts; missing keys remain invalid", () => {
  const resolution = resolveProviders(templates.map(([id]) => personalProvider(id)));
  assert.deepEqual(resolution.issues, []);
  for (const [id, , baseUrl, modelIds] of templates) {
    const entry = resolution.registryProviders.find((candidate) => candidate.providerId === id);
    assert.ok(entry, id);
    assert.equal(entry.config.access.type, "api-key");
    assert.equal(entry.config.access.apiKey, "fixture-key");
    assert.equal(entry.config.api.baseUrl, baseUrl);
    assert.deepEqual(
      entry.models.map((model) => model.modelId),
      modelIds,
    );
  }
  const noKey = resolveProviders([
    personalProvider(templates[1][0], "no-key", {
      access: { type: "api-key" },
    }),
  ]);
  assert.equal(noKey.registryProviders.length, 0);
  assert.ok(noKey.issues.length > 0);
});

test("personal URL, disabled identity, model order and exact reasoning overrides remain authoritative", () => {
  const customUrl = "https://provider.example.invalid/anthropic";
  const personalRules = [
    personalProvider(templates[1][0], "override", {
      api: { baseUrl: customUrl },
      modelOrder: [...newIds].reverse(),
    }),
    {
      ...personalProvider(templates[0][0], "legacy", { api: { baseUrl: customUrl } }),
      providerName: "My MiMo",
      enabled: false,
    },
  ];
  const before = structuredClone(personalRules);
  const models = provider.parsePersonalModelConfigRules({
    providerModelRules: [
      { providerId: "override", modelId: newIds[0], config: { enabled: false } },
      {
        providerId: "override",
        modelId: newIds[1],
        config: {
          properties: { contextWindow: 888000 },
          optionSpecs: {
            reasoningLevel: {
              values: ["minimum", "maximum"],
              map: "{'output_config': {'effort': reasoningLevel}}",
            },
            maxOutputTokens: { max: 64000 },
          },
        },
      },
    ],
    manualProviderModelRules: [],
  });
  const resolution = resolveProviders(personalRules, models);
  assert.deepEqual(personalRules, before);
  assert.equal(resolution.registryProviders.length, 1);
  const entry = resolution.registryProviders[0];
  assert.equal(entry.config.api.baseUrl, customUrl);
  assert.deepEqual(
    entry.models.map((model) => model.modelId),
    [newIds[1]],
  );
  const model = entry.models[0].config;
  assert.equal(model.properties.contextWindow, 888000);
  assert.equal(model.optionSpecs.maxOutputTokens.max, 64000);
  assert.deepEqual(model.optionSpecs.reasoningLevel.values, ["minimum", "maximum"]);
  assert.deepEqual(
    plain(
      compileModelOptionMaps(model.optionSpecs).apply(
        {},
        {
          reasoningLevel: "maximum",
          maxOutputTokens: 1024,
        },
      ),
    ),
    { output_config: { effort: "maximum" }, max_tokens: 1024 },
  );
  const legacy = resolution.resolvedProviders.find(
    (candidate) => candidate.providerId === "legacy",
  );
  assert.equal(legacy.enabled, false);
  assert.equal(legacy.providerName, "My MiMo");
  assert.equal(legacy.templateId, "xiaomi-mimo");
  assert.equal(legacy.config.api.baseUrl, customUrl);
  assert.equal(legacy.config.access.apiKey, "fixture-key");
});

test("MiMo catalog values and maps keep the public schema fail-closed", () => {
  for (const spec of [{ values: [] }, { values: ["enabled", "enabled"] }, { map: "{" }]) {
    const invalid = structuredClone(bundled.config.modelConfigRules);
    const rule = invalid.modelRules.find(({ modelMatch }) => modelMatch.includes("mimo-v2\\.6"));
    assert.ok(rule);
    rule.config.optionSpecs.reasoningLevel = { ...rule.config.optionSpecs.reasoningLevel, ...spec };
    assert.throws(() => provider.parseZCodeBuiltinModelConfigRules(invalid));
  }
});

test("all bundled API key template models prove complete configurations and valid public maps", () => {
  for (const [templateId, template] of providerTemplates.entries()) {
    assert.notEqual(template.config.access.type, "zhipu-account");
    for (const modelId of template.config.builtinModelIds) {
      const model = resolveModel(
        modelId,
        template.config.api.type,
        template.config.api.baseUrl,
        templateId,
      );
      const levels = model.optionSpecs.reasoningLevel.values;
      assert.ok(levels.length > 0);
      assert.equal(new Set(levels).size, levels.length);
      const maps = compileModelOptionMaps(model.optionSpecs);
      for (const reasoningLevel of levels) {
        assert.ok(
          maps.apply(
            {},
            { reasoningLevel, maxOutputTokens: model.optionSpecs.maxOutputTokens.max },
          ),
        );
      }
    }
  }
});
