import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "@zcode/shared";
import { createRecommendedNativeContextConfiguration } from "@zcode/shared/native-context-compression";
import { createSettingService } from "../../packages/services/src/setting/settingService.ts";
import { assertProjectPath, createProjectTestFixture } from "./project-test-sandbox.mjs";

test("full settings supply LAN defaults while an unrelated patch has no endpoint choice", () => {
  assert.equal(appSettingsSchema.parse({}).webRemoteControlEndpointMode, "lan");
  for (const patch of [{}, { locale: "en-US" }]) {
    assert.equal(
      Object.hasOwn(appSettingsPatchSchema.parse(patch), "webRemoteControlEndpointMode"),
      false,
    );
  }
});

test("saving native compression defaults and concurrent preferences preserves the custom endpoint", async () => {
  const root = await createProjectTestFixture("native-context-settings-isolation");
  const settingsFilePath = await assertProjectPath(join(root, "settings", "setting.json"));
  const service = createSettingService({ settingsFilePath, fixedDataBaseDir: root });
  const endpoint = "ws://fixture.invalid/ws";
  await service.update({
    webRemoteControlEndpointMode: "custom",
    webRemoteControlCustomEndpointUrl: endpoint,
  });
  const initial = await service.get();
  const configuration = createRecommendedNativeContextConfiguration();
  configuration.parameters.images.jpegQuality = 83;
  await Promise.all([
    service.update(
      {
        nativeContextCompression: {
          version: initial.nativeContextCompression?.version ?? 0,
          configuration,
        },
      },
      { expectedNativeContextCompressionVersion: initial.nativeContextCompression?.version ?? 0 },
    ),
    service.update({ locale: "en-US" }),
    service.update({ messageStreamShowReasoning: false }),
  ]);
  const restored = await createSettingService({ settingsFilePath, fixedDataBaseDir: root }).get();
  assert.equal(restored.webRemoteControlEndpointMode, "custom");
  assert.equal(restored.webRemoteControlCustomEndpointUrl, endpoint);
  assert.equal(restored.locale, "en-US");
  assert.equal(restored.messageStreamShowReasoning, false);
  assert.equal(
    restored.nativeContextCompression?.version,
    (initial.nativeContextCompression?.version ?? 0) + 1,
  );
  assert.deepEqual(restored.nativeContextCompression?.configuration, configuration);
  await service.update({ webRemoteControlEndpointMode: "lan" });
  assert.equal((await service.get()).webRemoteControlEndpointMode, "lan");
  assert.equal((await service.get()).webRemoteControlCustomEndpointUrl, endpoint);
});
