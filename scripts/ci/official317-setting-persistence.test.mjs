import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { createSettingService } from "../../packages/services/src/setting/settingService.ts";
import { getAgentUserInstructionsFilePath } from "../../packages/services/src/paths.ts";
import { USER_INSTRUCTIONS_MAX_BYTES } from "@zcode/shared";
import { assertProjectPath, createProjectTestFixture } from "./project-test-sandbox.mjs";

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
