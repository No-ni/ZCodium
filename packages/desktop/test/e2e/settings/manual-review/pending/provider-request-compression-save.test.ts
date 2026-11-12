import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import {
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_MODEL_PROVIDER_REQUEST_COMPRESSION_ITEM,
  TID_MODEL_PROVIDER_REQUEST_COMPRESSION_TRIGGER,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clickTestIdByDom, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { restartIntoWorkspace, seedReplayProvider } from "#e2e/helpers/model-provider-restart";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

import {
  installSaveGate,
  waitForHeldSave,
  releaseSave,
  restoreSaveGate,
  readSaveCount,
  waitForSaveReply,
  releaseSaveReply,
} from "#e2e/helpers/provider-compression-save-gate";

const PROVIDER_ID = "E2E_COMPRESSION_SAVE_PROVIDER";
const FAILURE_MARKER = "E2E_COMPRESSION_SAVE_REJECT";

async function openProviderSettings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
  await clickTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, `custom:${PROVIDER_ID}`));
  await $(`[data-testid="${TID_MODEL_PROVIDER_REQUEST_COMPRESSION_TRIGGER}"]`).waitForDisplayed();
}

async function chooseCompression(value: "off" | "brotli" | "gzip") {
  const trigger = $(`[data-testid="${TID_MODEL_PROVIDER_REQUEST_COMPRESSION_TRIGGER}"]`);
  await trigger.waitForClickable();
  await trigger.click();
  const option = $(`[data-testid="${testId(TID_MODEL_PROVIDER_REQUEST_COMPRESSION_ITEM, value)}"]`);
  await option.waitForClickable();
  const label = await option.getText();
  await option.click();
  await trigger.waitForDisplayed();
  return label;
}

async function openDeleteConfirmation() {
  const actions = $('[data-testid="model-provider-actions-button"]');
  await actions.waitForClickable();
  await actions.click();
  const item = $(
    '//*[@role="menuitem" and (normalize-space(.)="Delete" or normalize-space(.)="删除")]',
  );
  await item.waitForClickable();
  await item.click();
  await $(`[data-testid="${TID_CONFIRM_DIALOG_CONFIRM}"]`).waitForDisplayed();
}

describe("PCOMP_SAVE provider outbound compression", () => {
  let repository: NodePersonalProviderConfigRepository;

  async function readCompression() {
    return (await repository.read()).providers.get(PROVIDER_ID)?.api?.requestCompression ?? "off";
  }

  async function waitForSaved(value: "off" | "gzip") {
    await browser.waitUntil(async () => (await readCompression()) === value, {
      timeout: 15_000,
      timeoutMsg: `Latest compression choice ${value} was not persisted`,
    });
    await browser.waitUntil(async () => (await readSaveCount()) === 2, {
      timeout: 15_000,
      timeoutMsg: "Latest draft was not saved as the second serialized RPC",
    });
  }

  before(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    await restartIntoWorkspace({
      afterElectronProcessExit: () =>
        seedReplayProvider({
          id: PROVIDER_ID,
          name: "E2E Compression Save",
          apiKey: "e2e-only",
          baseURL: "https://fixture.invalid/v1",
          models: ["E2E_COMPRESSION_MODEL"],
        }),
    });
    repository = new NodePersonalProviderConfigRepository({
      filePath: getE2EAppDataPaths().configFile,
      pollingIntervalMs: false,
    });
  });

  after(async () => {
    repository?.dispose();
    await restoreSaveGate();
  });

  for (const finalValue of ["off", "gzip"] as const) {
    it(`PCOMP-SAVE-01 keeps the final ${finalValue} during a pending Brotli save`, async function () {
      this.timeout(90_000);
      await openProviderSettings();
      await installSaveGate(PROVIDER_ID);
      try {
        expect(await readCompression()).toBe("off");
        await chooseCompression("brotli");
        const requestId = await waitForHeldSave();
        const expectedLabel = await chooseCompression(finalValue);
        const trigger = $(`[data-testid="${TID_MODEL_PROVIDER_REQUEST_COMPRESSION_TRIGGER}"]`);
        expect(await trigger.getText()).toBe(expectedLabel);
        expect(await readCompression()).toBe("off");
        await releaseSave(requestId);
        await waitForSaved(finalValue);
        await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
        await openProviderSettings();
        expect(await trigger.getText()).toBe(expectedLabel);
        const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
        if (artifactDir) {
          await browser.saveScreenshot(join(artifactDir, `compression-save-${finalValue}.png`));
          await writeFile(
            join(artifactDir, `compression-save-${finalValue}.json`),
            JSON.stringify({
              caseId: "PCOMP-SAVE-01",
              persisted: await readCompression(),
              finalValue,
            }),
          );
        }
        if (finalValue === "gzip") {
          await restoreSaveGate();
          await chooseCompression("off");
          await browser.waitUntil(async () => (await readCompression()) === "off", {
            timeout: 15_000,
          });
        }
        await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
      } finally {
        await restoreSaveGate();
      }
    });
  }

  it("PCOMP-SAVE-02 reports a failed pending save and retries the latest gzip draft", async function () {
    this.timeout(90_000);
    await openProviderSettings();
    await installSaveGate(PROVIDER_ID);
    try {
      await chooseCompression("brotli");
      const requestId = await waitForHeldSave();
      await chooseCompression("gzip");
      await releaseSave(requestId, { reject: FAILURE_MARKER });
      const failure = $('[data-provider-detail-feedback-state="failure"]');
      await failure.waitForDisplayed({ timeout: 15_000 });
      expect(await failure.getText()).toContain(FAILURE_MARKER);
      expect(await readCompression()).toBe("off");
      await failure.$('.//button[normalize-space(.)="Retry" or normalize-space(.)="重试"]').click();
      await waitForSaved("gzip");
      await failure.waitForExist({ reverse: true, timeout: 15_000 });
      const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
      if (artifactDir)
        await browser.saveScreenshot(join(artifactDir, "compression-save-retry.png"));
      await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    } finally {
      await restoreSaveGate();
    }
  });

  it("PCOMP-SAVE-05 serializes compression edits behind a pending enabled update", async function () {
    this.timeout(90_000);
    await openProviderSettings();
    await chooseCompression("off");
    await browser.waitUntil(async () => (await readCompression()) === "off", { timeout: 15_000 });
    const toggle = $('[data-testid="model-provider-enabled-switch"]');
    const originalEnabled = (await toggle.getAttribute("aria-checked")) === "true";
    await installSaveGate(PROVIDER_ID);
    try {
      await toggle.waitForClickable();
      await toggle.click();
      const requestId = await waitForHeldSave("off");
      await chooseCompression("brotli");
      expect(await readSaveCount()).toBe(1);
      expect(await readCompression()).toBe("off");
      await releaseSave(requestId);
      await browser.waitUntil(
        async () => {
          const providers = (await repository.read()).providers;
          return (
            providers.get(PROVIDER_ID)?.api?.requestCompression === "brotli" &&
            providers.getRule(PROVIDER_ID)?.enabled === !originalEnabled &&
            (await readSaveCount()) === 2
          );
        },
        {
          timeout: 15_000,
          timeoutMsg: "Enabled update and latest compression were not serialized",
        },
      );
      expect(await toggle.getAttribute("aria-checked")).toBe(String(!originalEnabled));
      await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
      await openProviderSettings();
      expect(await toggle.getAttribute("aria-checked")).toBe(String(!originalEnabled));
      expect(await readCompression()).toBe("brotli");
      const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
      if (artifactDir)
        await browser.saveScreenshot(join(artifactDir, "compression-save-enabled.png"));
      await restoreSaveGate();
      await toggle.click();
      await browser.waitUntil(
        async () =>
          (await repository.read()).providers.getRule(PROVIDER_ID)?.enabled === originalEnabled,
        { timeout: 15_000 },
      );
      await chooseCompression("off");
      await browser.waitUntil(async () => (await readCompression()) === "off", { timeout: 15_000 });
      await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    } finally {
      await restoreSaveGate();
    }
  });

  it("PCOMP-SAVE-03 resumes the latest off draft after cancelling deletion", async function () {
    this.timeout(90_000);
    await openProviderSettings();
    await chooseCompression("off");
    await browser.waitUntil(async () => (await readCompression()) === "off", { timeout: 15_000 });
    await installSaveGate(PROVIDER_ID);
    try {
      await chooseCompression("brotli");
      const requestId = await waitForHeldSave();
      await chooseCompression("off");
      await openDeleteConfirmation();
      await releaseSave(requestId);
      await waitForSaveReply();
      expect(await readCompression()).toBe("brotli");
      expect(await readSaveCount()).toBe(1);
      await $('[role="dialog"]')
        .$('.//button[span[normalize-space(.)="Cancel" or normalize-space(.)="取消"]]')
        .click();
      await waitForSaved("off");
      await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    } finally {
      await restoreSaveGate();
    }
  });

  it("PCOMP-SAVE-04 keeps a deleted provider absent after a late save reply", async function () {
    this.timeout(90_000);
    await openProviderSettings();
    await installSaveGate(PROVIDER_ID);
    try {
      await chooseCompression("brotli");
      const requestId = await waitForHeldSave();
      await chooseCompression("off");
      await releaseSave(requestId, { holdReply: true });
      await waitForSaveReply();
      expect(await readCompression()).toBe("brotli");
      await openDeleteConfirmation();
      await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM);
      await browser.waitUntil(async () => !(await repository.read()).providers.has(PROVIDER_ID), {
        timeout: 15_000,
      });
      await releaseSaveReply();
      await browser.executeAsync((done: () => void) => requestAnimationFrame(() => done()));
      expect(await readSaveCount()).toBe(1);
      expect((await repository.read()).providers.has(PROVIDER_ID)).toBe(false);
      const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
      if (artifactDir)
        await browser.saveScreenshot(join(artifactDir, "compression-save-delete.png"));
      await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    } finally {
      await restoreSaveGate();
    }
  });
});
