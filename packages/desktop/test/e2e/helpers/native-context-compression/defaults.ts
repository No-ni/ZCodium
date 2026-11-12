import { ServiceChannels, type AppSettings } from "@zcode/shared";
import {
  nativeContextConfigurationSchema,
  type NativeContextConfiguration,
} from "@zcode/shared/native-context-compression";
import { DEFAULT_WORKSPACE } from "../desktop-app.js";
import { projectRowSelector, startDraftFromProject } from "../project-sidebar.js";
import { selectV4TaskById } from "../v4-conversation.js";
import { callHandoffHost } from "../remote-project-handoff-probe.js";
import { withNativeContextCleanup } from "./cleanup.js";
import { sendNativeContextPrompt } from "./images.js";
import { getNativeContextStatus, nativeContextCurrentTarget } from "./queries.js";
import {
  chooseNativeContextOption,
  closeNativeContextDetails,
  loadNativeContextConfiguration,
  nativeContextElement,
  openNativeContextDetails,
  readNativeContextFormConfiguration,
} from "./ui.js";

async function readOwnerDefaults() {
  const { nativeContextCompression: defaults } = await callHandoffHost<AppSettings>(
    ServiceChannels.Setting,
    "get",
  );
  if (!defaults || !Number.isSafeInteger(defaults.version) || defaults.version < 0)
    throw new Error("NCTX LocalHost has no valid owning defaults version");
  return {
    version: defaults.version,
    configuration: nativeContextConfigurationSchema.parse(defaults.configuration),
  };
}

async function saveDefaults(configuration: NativeContextConfiguration) {
  await loadNativeContextConfiguration(configuration);
  const status = nativeContextElement("parameter-save-status");
  const previousVersion = Number(await status.getAttribute("data-version"));
  expect(previousVersion).toBe((await readOwnerDefaults()).version);
  await nativeContextElement("save-parameters").waitForEnabled();
  await nativeContextElement("save-parameters").click();
  await browser.waitUntil(
    async () => {
      const state = await status.getAttribute("data-state");
      if (state === "error") throw new Error("NCTX default save failed");
      return (
        (state === "clean" || state === "saved") &&
        Number(await status.getAttribute("data-version")) > previousVersion
      );
    },
    {
      timeout: 20000,
      timeoutMsg: "NCTX default candidate did not reach its owning settings version",
    },
  );
  const owner = await readOwnerDefaults();
  expect(owner.version).toBeGreaterThan(previousVersion);
  expect(Number(await status.getAttribute("data-version"))).toBe(owner.version);
  expect(owner.configuration).toEqual(configuration);
  expect(await readNativeContextFormConfiguration()).toEqual(configuration);
  expect(await nativeContextElement("reload-parameters").isExisting()).toBe(false);
  expect(await nativeContextElement("parameters-defaults").getAttribute("data-unavailable")).toBe(
    "false",
  );
  expect(await nativeContextElement("parameters-defaults").getAttribute("data-applied")).toBe(
    "true",
  );
}

/** 新任务由真实settings→创建意图捕获；不能只比较两个表单草稿。 */
export async function assertNativeContextDefaultsForFutureTask(marker: string) {
  const parentTarget = await nativeContextCurrentTarget();
  const parent = await getNativeContextStatus(parentTarget);
  await openNativeContextDetails("parameters");
  await chooseNativeContextOption("scope", 1);
  const previous = await readNativeContextFormConfiguration();
  const candidate = structuredClone(previous);
  candidate.mode = "auto";
  candidate.parameters.images.jpegQuality =
    candidate.parameters.images.jpegQuality === 83 ? 84 : 83;
  return withNativeContextCleanup(
    async () => {
      await saveDefaults(candidate);
      expect((await getNativeContextStatus(parentTarget)).policy).toEqual(parent.policy);
      await closeNativeContextDetails();
      // 原因：前置多宽度验收会让 Shell 自动收起侧栏；先用真实开关恢复入口，不能靠隐藏节点创建草稿。
      if ((await $("#sidebar > aside").getAttribute("aria-hidden")) === "true") {
        const toggle = $('[data-testid="desktop-top-logo-sidebar-toggle"]');
        await toggle.waitForDisplayed();
        await toggle.click();
      }
      await $(`#sidebar ${projectRowSelector(DEFAULT_WORKSPACE)}`).waitForDisplayed({
        timeout: 30000,
        timeoutMsg: "NCTX the real project task-creation row did not become visible",
      });
      await startDraftFromProject(DEFAULT_WORKSPACE);
      const future = await sendNativeContextPrompt(marker, "native-default-new-task-main", 3300);
      expect(future.target.sessionId).not.toBe(parentTarget.sessionId);
      expect({
        schemaVersion: future.status.policy.schemaVersion,
        mode: future.status.policy.mode,
        parameters: future.status.policy.parameters,
      }).toEqual(candidate);
      expect((await getNativeContextStatus(parentTarget)).policy).toEqual(parent.policy);
      return future.target;
    },
    async () => {
      await closeNativeContextDetails();
      await selectV4TaskById(parentTarget.sessionId);
      await openNativeContextDetails("parameters");
      await chooseNativeContextOption("scope", 1);
      await saveDefaults(previous);
      await chooseNativeContextOption("scope", 0);
      await closeNativeContextDetails();
    },
  );
}
