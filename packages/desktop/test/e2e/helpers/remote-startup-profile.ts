import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { onboardingRecordFileSchema } from "@zcode/shared";

/** 远程场景从已完成引导的隔离账号开始；导航专项仍走自己的真实引导链。 */
export async function seedRemoteOnboardingFixture(options: {
  enabled: boolean;
  specs: readonly string[];
  appConfigDir: string;
}): Promise<void> {
  if (
    !options.enabled ||
    options.specs.some((spec) =>
      spec.endsWith("conversation-session-rpn-project-navigation.test.ts"),
    )
  )
    return;

  // 本地引导记录只有答案；不播种官方账号、设备或上传状态。
  const record = onboardingRecordFileSchema.parse({
    version: 1,
    entries: [
      {
        occupation: "developer",
        interfaceMode: "coding",
        memoryEnabled: false,
        proactiveSuggestionsEnabled: false,
        completedAt: new Date().toISOString(),
      },
    ],
  });
  await mkdir(options.appConfigDir, { recursive: true });
  await writeFile(
    join(options.appConfigDir, "onboarding-record.json"),
    JSON.stringify(record, null, 2),
  );
  const settingsPath = join(options.appConfigDir, "setting.json");
  const settings = await readFile(settingsPath, "utf8").then(
    (contents) => JSON.parse(contents),
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return {};
    },
  );
  await writeFile(
    settingsPath,
    JSON.stringify(
      {
        ...settings,
        onboardingOccupation: "developer",
        memoryEnabled: false,
        proactiveSuggestionsEnabled: false,
      },
      null,
      2,
    ),
  );
}
