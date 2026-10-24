import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createProviderRuntime } from "../src/model-provider/providerRuntime.js";
import { fetchProviderModelCatalog } from "../src/model-provider/providerModelCatalog.js";
import { withCatalogMetadata } from "../../ui/src/settings/model-provider-section/providerModelCatalogSelection.js";

// 与卡片的 onAddPersonalModel 参数完全相同，不把 Effective config 当作持久化对象。
test("official Gemini catalog limits survive the real add/save/reload path and manual overrides", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-google-catalog-"));
  const personalFilePath = join(dir, "personal.json");
  const runtime = createProviderRuntime({
    zcodeBuiltinFilePath: fileURLToPath(
      new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
    ),
    personalFilePath,
    personalPollingIntervalMs: false,
    watch: false,
  });
  try {
    const created = await runtime.providerSettings.createPersonalProvider({
      providerName: "Google custom",
      initialConfig: {
        access: { type: "api-key", apiKey: "mock-only-key" },
        api: {
          type: "google-generative-ai",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        },
      },
    });
    const catalog = await fetchProviderModelCatalog({
      apiClient: {
        request: async () =>
          Response.json({
            models: [
              {
                name: "models/gemini-catalog-test",
                inputTokenLimit: 1048576,
                outputTokenLimit: 32768,
                displayName: "Do not use as ID",
              },
            ],
          }),
      },
      request: {
        apiType: "google-generative-ai",
        apiKey: "mock-only-key",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      },
    });
    assert.ok(catalog.success);
    const modelId = catalog.modelIds[0]!;
    const candidate = withCatalogMetadata(catalog.metadata?.[modelId]);
    const added = await runtime.providerSettings.addPersonalModel(
      created.providerId,
      modelId,
      candidate.personalConfig ?? {},
    );
    const model = added.providers
      .find((item) => item.providerId === created.providerId)!
      .models.find((item) => item.modelId === modelId)!;
    assert.equal(model.effectiveConfig.properties?.contextWindow, 1048576);
    assert.equal(model.effectiveConfig.optionSpecs?.maxOutputTokens?.max, 32768);
    assert.deepEqual(model.personalExactConfig?.properties, { contextWindow: 1048576 });
    const saved = await runtime.providerSettings.savePersonalModelDraft({
      providerId: created.providerId,
      originalModelId: modelId,
      nextModelId: modelId,
      basedOnRevision: added.revision,
      personalConfig: {
        properties: { contextWindow: 64000 },
        optionSpecs: { maxOutputTokens: { max: 4096 } },
      },
    });
    const manual = saved.providers
      .find((item) => item.providerId === created.providerId)!
      .models.find((item) => item.modelId === modelId)!;
    assert.equal(manual.effectiveConfig.properties?.contextWindow, 64000);
    assert.equal(manual.effectiveConfig.optionSpecs?.maxOutputTokens?.max, 4096);
    const document = JSON.parse(await readFile(personalFilePath, "utf8"));
    assert.ok(JSON.stringify(document).includes('"contextWindow":64000'));
    const resolved = await runtime.providerSettings.resolveModelConfig({
      providerId: created.providerId,
      modelId,
    });
    assert.equal(resolved.effectiveConfig.properties?.contextWindow, 64000);
    assert.equal(resolved.effectiveConfig.optionSpecs?.maxOutputTokens?.max, 4096);
    const restarted = createProviderRuntime({
      zcodeBuiltinFilePath: fileURLToPath(
        new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
      ),
      personalFilePath,
      personalPollingIntervalMs: false,
      watch: false,
    });
    try {
      const reloaded = await restarted.providerSettings.resolveModelConfig({
        providerId: created.providerId,
        modelId,
      });
      assert.equal(reloaded.effectiveConfig.properties?.contextWindow, 64000);
      assert.equal(reloaded.effectiveConfig.optionSpecs?.maxOutputTokens?.max, 4096);
    } finally {
      restarted.dispose();
    }
  } finally {
    runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
