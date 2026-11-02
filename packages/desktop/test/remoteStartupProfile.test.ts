import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertProjectPath,
  createProjectTestSandbox,
} from "../../../scripts/ci/project-test-sandbox.mjs";
import { createOnboardingRecordService } from "../../services/src/onboarding/onboardingRecordService.js";
import { getAppConfigDir, setDataBaseDir } from "../../services/src/paths.js";
import { seedRemoteOnboardingFixture } from "./e2e/helpers/remote-startup-profile.js";

const remoteSpec = "conversation-session-ssh-remote-connection-p0.test.ts";
const rpnNavigationSpec = "conversation-session-rpn-project-navigation.test.ts";
const sandboxRoots: string[] = [];

// 官方账号引导（shouldOnboard / claimAnonymousRecord / syncSettingsFromRecord）已随审计边界退休，
// 生产 onboardingRecordService 只剩 append/getLatest/updatePrefs/getRecords/clear 的本地记录契约；
// 这里只验证 fixture 播种后真实 service 的读取结果，不为退休接口造 stub。
async function prepare(enabled: boolean, spec = remoteSpec) {
  // 引导记录落在 dataBaseDir 下，临时目录必须位于当前工作树内的项目沙箱，不写系统临时目录。
  const sandbox = await createProjectTestSandbox("remote-startup-profile");
  sandboxRoots.push(sandbox.root);
  setDataBaseDir(sandbox.data);
  await seedRemoteOnboardingFixture({ enabled, specs: [spec], appConfigDir: getAppConfigDir() });
}

afterEach(async () => {
  setDataBaseDir(null);
  // 清理前重新校验路径仍在项目工作树内且未经过重解析点，确认后才递归删除本次沙箱。
  await Promise.all(
    sandboxRoots.splice(0).map(async (root) => {
      await rm(await assertProjectPath(root), { recursive: true, force: true });
    }),
  );
});

describe("远程 E2E 的已完成引导前置", () => {
  it("开启后真实记录服务只读回本机答案，且只有一条无身份字段的记录", async () => {
    await prepare(true);
    const service = createOnboardingRecordService();
    expect(await service.getLatestEntry()).toMatchObject({
      occupation: "developer",
      interfaceMode: "coding",
      memoryEnabled: false,
      proactiveSuggestionsEnabled: false,
    });
    const records = await service.getRecords();
    expect(records?.entries).toHaveLength(1);
    // 账号归属、设备档案与上传状态已退休：schema 只投影本地答案，落盘文件不得出现这些字段。
    expect(JSON.stringify(records)).not.toMatch(/userId|deviceMid|uploadState/);
  });

  it("未开启时不写引导记录，普通 E2E 保持首次引导", async () => {
    await prepare(false);
    const service = createOnboardingRecordService();
    expect(await service.getRecords()).toBeNull();
    expect(await service.getLatestEntry()).toBeNull();
  });

  it("项目导航 case 不播种引导记录，保留真实引导链", async () => {
    await prepare(true, rpnNavigationSpec);
    const service = createOnboardingRecordService();
    expect(await service.getRecords()).toBeNull();
    expect(await service.getLatestEntry()).toBeNull();
  });
});
