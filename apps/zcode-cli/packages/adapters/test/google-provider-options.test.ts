import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { ModelConfig, ModelConfigRules } from "@zcode/provider";
import { compileModelOptionMaps } from "@zcode/model-option-map";
const bundled = JSON.parse(
  await readFile(
    new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
    "utf8",
  ),
);
const googleRule = () => {
  const rule = bundled.config.modelConfigRules.modelApiRules.find(
    (r: any) => r.apiTypeMatch === "google-generative-ai",
  );
  assert.ok(rule, "Gemini needs native option maps");
  return rule;
};
test("Gemini maps thinking and output only into generationConfig", () => {
  const maps = compileModelOptionMaps(googleRule().config.optionSpecs);
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(
    plain(maps.apply({ contents: [] }, { reasoningLevel: "enabled", maxOutputTokens: 32768 })),
    {
      contents: [],
      generationConfig: {
        thinkingConfig: { thinkingLevel: "high", includeThoughts: true },
        maxOutputTokens: 32768,
      },
    },
  );
  assert.deepEqual(
    plain(maps.apply({ contents: [] }, { reasoningLevel: "disabled", maxOutputTokens: 1024 })),
    { contents: [], generationConfig: { maxOutputTokens: 1024 } },
  );
});
test("OpenCode Gemini limits are exact-site scoped and do not advertise untested attachments", () => {
  const apiRules = bundled.config.modelConfigRules.modelApiRules.filter(
    (r: any) => r.apiTypeMatch === "google-generative-ai",
  );
  assert.ok(apiRules.every((r: any) => r.config.properties.contextWindow === undefined));
  const siteRules = bundled.config.modelConfigRules.providerSiteRules.filter(
    (r: any) => r.apiTypeMatch === "google-generative-ai",
  );
  assert.equal(siteRules.length, 9);
  const rules = new ModelConfigRules(
    siteRules.map((r: any) => ({
      ...r,
      type: "provider-site",
      config: ModelConfig.fromData(r.config),
    })),
  );
  const models = [
    "gemini-4-argon-contributor",
    "gemini-4-argon",
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-pro",
    "gemini-3-flash",
  ];
  for (const modelId of models) {
    for (const baseUrl of [
      "https://opencode.ai/inference/google/v1beta",
      "https://opencode.ai/inference/go/google/v1beta/",
    ]) {
      const model = rules.resolve({
        providerId: "custom",
        modelId,
        baseUrl,
        apiType: "google-generative-ai",
      });
      assert.equal(model.properties?.contextWindow, 1048576);
      assert.equal(
        model.optionSpecs?.maxOutputTokens?.max,
        modelId.includes("argon") ? 32768 : 65536,
      );
      assert.equal(model.properties?.inputFormat?.supportsImage, true);
      assert.equal(model.properties?.inputFormat?.supportsVideo, false);
      assert.equal(model.properties?.inputFormat?.supportsAudio, false);
      assert.equal(model.properties?.inputFormat?.supportsPdf, false);
    }
    for (const baseUrl of [
      "https://generativelanguage.googleapis.com/v1beta",
      "https://proxy.example/google/v1beta",
      "https://opencode.ai/inference/google/v1beta/evil",
      "https://evil.example/https://opencode.ai/inference/google/v1beta",
    ]) {
      assert.equal(
        rules.resolve({ providerId: "custom", modelId, baseUrl, apiType: "google-generative-ai" })
          .properties?.contextWindow,
        undefined,
      );
    }
  }
  assert.equal(
    rules.resolve({
      providerId: "custom",
      modelId: "unknown",
      baseUrl: "https://opencode.ai/inference/google/v1beta",
      apiType: "google-generative-ai",
    }).properties?.contextWindow,
    undefined,
  );
});
test("Go/Zen Google templates use native endpoints and API Key access", () => {
  const templates = bundled.config.providerConfigRules.templateRules.filter(
    (t: any) => t.config.api?.type === "google-generative-ai",
  );
  assert.deepEqual(
    templates.map((t: any) => t.templateId),
    ["opencode-go-google", "opencode-zen-google"],
  );
  assert.deepEqual(
    templates.map((t: any) => t.config.builtinModelIds.length),
    [1, 8],
  );
  for (const template of templates) {
    assert.match(
      template.config.api.baseUrl,
      /^https:\/\/opencode\.ai\/inference\/(go\/)?google\/v1beta$/,
    );
    assert.equal(template.config.access.type, "api-key");
    assert.ok(template.config.access.apiKeyManagementUrl);
  }
});
