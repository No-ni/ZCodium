import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { createSettingService } from "../../packages/services/src/setting/settingService.ts";
import { getAgentUserInstructionsFilePath } from "../../packages/services/src/paths.ts";
import {
  USER_INSTRUCTIONS_MAX_BYTES,
  appSettingsSchema,
  appSettingsPatchSchema,
} from "@zcode/shared";
import { assertProjectPath, createProjectTestFixture } from "./project-test-sandbox.mjs";

test("grouping switches persist false across reloads and unrelated settings patches", async () => {
  const root = await createProjectTestFixture("grouping-settings");
  const settingsFilePath = await assertProjectPath(join(root, "setting.json"));
  const service = createSettingService({ settingsFilePath });
  const fields = [
    "toolGroupingExploreEnabled",
    "toolGroupingTerminalEnabled",
    "toolGroupingChangesEnabled",
  ];
  await service.update(Object.fromEntries(fields.map((field) => [field, false])));
  await service.update({ locale: "en-US", terminalFontFamily: "monospace" });
  const reloaded = createSettingService({ settingsFilePath });
  for (const field of fields) assert.equal((await reloaded.get())[field], false);
  await reloaded.update({ toolGroupingTerminalEnabled: true });
  const saved = await reloaded.get();
  assert.deepEqual(
    fields.map((field) => saved[field]),
    [false, true, false],
  );
  for (const field of fields) {
    assert.equal(appSettingsSchema.safeParse({ [field]: "false" }).success, false);
    const before = await readFile(settingsFilePath, "utf8");
    await assert.rejects(reloaded.update({ [field]: "false" }));
    assert.equal(await readFile(settingsFilePath, "utf8"), before);
  }
});

test("unrelated patches preserve custom remote mode and its connection context", async () => {
  const root = await createProjectTestFixture("remote-mode-settings");
  const settingsFilePath = await assertProjectPath(join(root, "setting.json"));
  const service = createSettingService({ settingsFilePath });
  const remote = {
    webRemoteControlEndpointMode: "custom",
    webRemoteControlCustomEndpointUrl: "wss://relay.example.invalid/ws",
    webRemoteControlDeviceMid: "fixture-mid",
    webRemoteControlExternalRelayDevice: { deviceSid: "fixture-sid" },
    webRemoteControlLastEnabledContext: { workspacePath: root, initialTaskId: "fixture-task" },
  };
  await service.update(remote);
  for (const patch of [
    { terminalFontFamily: "monospace" },
    { locale: "en-US" },
    { toolGroupingExploreEnabled: false },
  ]) {
    assert.equal(
      Object.hasOwn(appSettingsPatchSchema.parse(patch), "webRemoteControlEndpointMode"),
      false,
    );
    await service.update(patch);
    const saved = await createSettingService({ settingsFilePath }).get();
    for (const [field, value] of Object.entries(remote)) assert.deepEqual(saved[field], value);
  }
  await service.update({ webRemoteControlEndpointMode: "lan" });
  assert.equal((await service.get()).webRemoteControlEndpointMode, "lan");
  assert.equal(
    (await service.get()).webRemoteControlCustomEndpointUrl,
    remote.webRemoteControlCustomEndpointUrl,
  );
});

test("full settings provide defaults while empty patches inject no preference", () => {
  const settings = appSettingsSchema.parse({});
  for (const field of [
    "toolGroupingExploreEnabled",
    "toolGroupingTerminalEnabled",
    "toolGroupingChangesEnabled",
  ])
    assert.equal(settings[field], true);
  assert.equal(settings.webRemoteControlEndpointMode, "lan");
  assert.deepEqual(appSettingsPatchSchema.parse({}), {});
});

test("setting patches preserve each other and a fixed Source root cannot be changed", async () => {
  const root = await createProjectTestFixture("setting-patches");
  const settingsFilePath = await assertProjectPath(join(root, "settings", "setting.json"));
  const service = createSettingService({ settingsFilePath, fixedDataBaseDir: root });
  await Promise.all([
    service.update({ locale: "en-US" }),
    service.update({ messageStreamShowReasoning: false }),
  ]);
  const current = await service.get();
  assert.equal(current.locale, "en-US");
  assert.equal(current.messageStreamShowReasoning, false);
  assert.equal(current.dataBaseDir, root);
  await assert.rejects(
    service.update({ dataBaseDir: join(root, "other") }),
    /SOURCE_DATA_BASE_DIR_FIXED/,
  );
});

test("personal instructions use the CLI .zcodium path and serialize first saves", async () => {
  const root = await createProjectTestFixture("personal-instructions");
  const path = await assertProjectPath(getAgentUserInstructionsFilePath());
  assert.match(path, /[\\/]\.zcodium[\\/]AGENTS\.md$/);
  const service = createSettingService({
    settingsFilePath: await assertProjectPath(join(root, "setting.json")),
  });
  const before = await service.getUserInstructions();
  assert.equal(before.filePath, path);
  assert.equal(before.content, "");
  await Promise.all([
    service.saveUserInstructions("first"),
    service.saveUserInstructions("latest"),
  ]);
  assert.deepEqual(await service.getUserInstructions(), { content: "latest", filePath: path });
  assert.equal(await readFile(path, "utf8"), "latest");
  assert.ok((await stat(path)).isFile());
  await assert.rejects(service.saveUserInstructions("x".repeat(USER_INSTRUCTIONS_MAX_BYTES + 1)), {
    code: "user_instructions_too_large",
  });
  assert.equal((await service.getUserInstructions()).content, "latest");
});
