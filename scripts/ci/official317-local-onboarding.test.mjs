import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createOnboardingRecordService } from "../../packages/services/src/onboarding/onboardingRecordService.ts";
import { onboardingRecordFileSchema } from "../../packages/shared/src/onboardingRecord.ts";
import { getAppConfigDir } from "../../packages/services/src/paths.ts";
import { assertProjectPath } from "./project-test-sandbox.mjs";

const entry = {
  occupation: "fixture",
  interfaceMode: "coding",
  memoryEnabled: true,
  proactiveSuggestionsEnabled: false,
  completedAt: "2026-01-01T00:00:00Z",
};
test("legacy onboarding normalizes to local answers without account or device state", () => {
  assert.deepEqual(
    onboardingRecordFileSchema.parse({
      version: 2,
      deviceMid: "fixture-device",
      decisions: [
        {
          userId: "fixture-account",
          status: "dismissed",
          reason: "user_closed",
          decidedAt: "fixture",
        },
      ],
      entries: [entry],
    }),
    { version: 1, entries: [entry] },
  );
});
test("onboarding writes remain readable and queued preference patches preserve answers", async () => {
  const path = await assertProjectPath(join(getAppConfigDir(), "onboarding-record.json"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ version: 1, entries: [] }));
  const service = createOnboardingRecordService();
  await service.appendRecord(entry);
  await Promise.all([
    service.updateRecordPreferences({ memoryEnabled: false }),
    service.updateRecordPreferences({ proactiveSuggestionsEnabled: true }),
  ]);
  assert.deepEqual(await service.getLatestEntry(), {
    ...entry,
    memoryEnabled: false,
    proactiveSuggestionsEnabled: true,
  });
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.version, 1);
  assert.deepEqual(Object.keys(saved).sort(), ["entries", "version"]);
  assert.deepEqual(await service.getRecords(), saved);
});
