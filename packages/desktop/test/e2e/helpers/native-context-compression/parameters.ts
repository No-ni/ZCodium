import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  NATIVE_CONTEXT_PARAMETER_FIELDS,
  getNativeContextParameterValue,
  nativeContextConfigurationSchema,
  type NativeContextConfiguration,
  type NativeContextResolvedToolProtection,
} from "@zcode/shared/native-context-compression";
import { getUpstreamRequestRecordCount } from "../conversation-session-network.js";
import { setInputValueByTestIdDom } from "../desktop-app.js";
import { getNativeContextStatus, nativeContextCurrentTarget } from "./queries.js";
import { assertNativeContextTestPath } from "./environment.js";
import {
  chooseNativeContextOption,
  closeNativeContextDetails,
  expandNativeContextJson,
  expandNativeContextParameterGroup,
  loadNativeContextConfiguration,
  nativeContextElement,
  openNativeContextDetails,
  readNativeContextFormConfiguration,
  saveNativeContextConfiguration,
  setNativeContextRawField,
} from "./ui.js";

async function setPendingJson(text: string) {
  await expandNativeContextJson();
  // 原因：长 JSON 使用真实 input/change 的整段粘贴语义，避免逐字符渲染阻塞验证。
  await setInputValueByTestIdDom("native-context-configuration-json", text);
  await nativeContextElement("json-pending").waitForDisplayed();
  expect(await nativeContextElement("save-parameters").isEnabled()).toBe(false);
  expect(await nativeContextElement("export-configuration").isEnabled()).toBe(false);
}

async function saveDefaultDraft() {
  const status = nativeContextElement("parameter-save-status");
  const previousVersion = Number(await status.getAttribute("data-version"));
  await nativeContextElement("save-parameters").waitForEnabled();
  await nativeContextElement("save-parameters").click();
  // 原因：保存中按钮同样禁用，必须观察真实完成状态和递增版本。
  await browser.waitUntil(
    async () => {
      const state = await status.getAttribute("data-state");
      if (state === "error") throw new Error("NCTX default parameter save failed");
      return (
        (state === "saved" || state === "clean") &&
        Number(await status.getAttribute("data-version")) > previousVersion
      );
    },
    { timeout: 20000, timeoutMsg: "NCTX default save did not confirm its committed version" },
  );
}

async function withDraftCleanup(action: () => Promise<void>, cleanup: () => Promise<void>) {
  let failed = false;
  let failure: unknown;
  let cleanupFailed = false;
  let cleanupFailure: unknown;
  try {
    await action();
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    try {
      await cleanup();
    } catch (error) {
      cleanupFailed = true;
      cleanupFailure = error;
    }
  }
  if (failed && cleanupFailed)
    throw new AggregateError(
      [failure, cleanupFailure],
      "NCTX assertion and draft cleanup both failed",
    );
  if (failed) throw failure;
  if (cleanupFailed) throw cleanupFailure;
}

async function assertResolvedToolProtection(protection: NativeContextResolvedToolProtection) {
  const table = nativeContextElement("tool-protection");
  await table.waitForDisplayed();
  if ((await table.getAttribute("open")) === null) await table.$("summary").click();
  expect(Number(await table.getAttribute("data-count"))).toBe(protection.items.length);
  expect(Number(await table.getAttribute("data-total"))).toBe(protection.total);
  const rows = await browser.execute(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-testid="native-context-tool-protection"] [data-tool-name]',
      ),
    ).map((row) => {
      const rules = Array.from(row.querySelectorAll<HTMLElement>("[data-rule]"));
      return {
        name: row.getAttribute("data-tool-name"),
        count: rules.length,
        ...Object.fromEntries(
          rules.map((rule) => [
            rule.getAttribute("data-rule"),
            rule.getAttribute("data-active") === "true",
          ]),
        ),
      };
    }),
  );
  for (const [index, item] of protection.items.entries())
    expect(rows[index]).toEqual({ ...item, count: 6 });
  expect(rows).toHaveLength(protection.items.length);
  expect(await nativeContextElement("tool-protection-truncated").isExisting()).toBe(
    protection.total > protection.items.length,
  );
}

export async function assertNativeContextParameterRegistry() {
  await openNativeContextDetails("parameters");
  expect(await nativeContextElement("attribution-kernel").getAttribute("href")).toBe(
    "https://github.com/No-ni/ZCodium/blob/main/docs/specs/native-context-compression.md#acp-kernel",
  );
  expect(await nativeContextElement("attribution-project").getAttribute("href")).toBe(
    "https://github.com/No-ni/ZCodium/blob/main/docs/specs/native-context-compression.md#billion-context",
  );
  expect(await nativeContextElement("feature-documentation").getAttribute("href")).toBe(
    "https://github.com/No-ni/ZCodium/blob/main/docs/specs/native-context-compression.md",
  );
  const configuration = await readNativeContextFormConfiguration();
  const status = await getNativeContextStatus(await nativeContextCurrentTarget());
  expect(configuration.parameters).toEqual(status.policy.parameters);
  expect(configuration.mode).toBe(status.policy.mode);
  expect(status.resolvedToolProtection).toBeDefined();
  if (!status.resolvedToolProtection)
    throw new Error("NCTX runtime tool protection is unavailable");
  await assertResolvedToolProtection(status.resolvedToolProtection);
  expect(NATIVE_CONTEXT_PARAMETER_FIELDS).toHaveLength(90);
  for (const group of ["trigger", "history", "tools", "images", "prompts"] as const)
    await expandNativeContextParameterGroup(group);
  const values = await browser.execute(
    (fields) =>
      fields.map((field) => {
        const selector = `[data-testid="native-context-parameter-${field.path}"]`;
        const elements = document.querySelectorAll<HTMLElement>(selector);
        const element = elements[0];
        return {
          path: field.path,
          count: elements.length,
          text: element?.textContent?.trim() ?? "",
          value:
            element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
              ? element.value
              : null,
          checked: element?.getAttribute("aria-checked"),
          checkedCount: element?.querySelectorAll('[aria-checked="true"]').length ?? 0,
          label: element?.getAttribute("aria-label") ?? "",
        };
      }),
    NATIVE_CONTEXT_PARAMETER_FIELDS.map((field) => ({ path: field.path })),
  );
  for (const [index, field] of NATIVE_CONTEXT_PARAMETER_FIELDS.entries()) {
    const actual = values[index]!;
    const value = getNativeContextParameterValue(configuration.parameters, field.path);
    expect(actual.count).toBe(1);
    if (field.type === "boolean") expect(actual.checked).toBe(String(value));
    else if (field.type === "threshold")
      expect(actual.value).toBe(String((value as { value: number }).value));
    else if (field.type === "list" && field.options)
      expect(actual.checkedCount).toBe((value as string[]).length);
    else if (
      field.type === "number" ||
      field.type === "auto-number" ||
      field.type === "text" ||
      field.type === "list"
    )
      expect(actual.value).toBe(Array.isArray(value) ? value.join(", ") : String(value));
    else expect(actual.text.length).toBeGreaterThan(0);
    if (field.type !== "list" || !field.options)
      expect(Object.values(field.labels)).toContain(actual.label);
  }
  return configuration;
}

export async function assertNativeContextJsonValidationAndDrafts() {
  // 原因：每场结束会关闭弹窗；独立场景必须先明确打开自己的参数页。
  await openNativeContextDetails("parameters");
  const target = await nativeContextCurrentTarget();
  const before = await getNativeContextStatus(target);
  const requestCount = await getUpstreamRequestRecordCount();
  const original = await readNativeContextFormConfiguration();
  await withDraftCleanup(
    async () => {
      for (const invalid of [
        "{",
        { ...original, unexpectedInternalState: {} },
        {
          ...original,
          parameters: {
            ...original.parameters,
            tools: {
              ...original.parameters.tools,
              simplify: { ...original.parameters.tools.simplify, enabled: true },
              distill: { ...original.parameters.tools.distill, enabled: false },
            },
          },
        },
        {
          ...original,
          parameters: {
            ...original.parameters,
            trigger: {
              ...original.parameters.trigger,
              start: { kind: "percent", value: 40 },
              target: { kind: "percent", value: 60 },
            },
          },
        },
        {
          ...original,
          parameters: {
            ...original.parameters,
            images: { ...original.parameters.images, jpegQuality: 50, minJpegQuality: 70 },
          },
        },
        {
          ...original,
          parameters: {
            ...original.parameters,
            maintenance: { ...original.parameters.maintenance, model: "configured-preview" },
          },
        },
      ]) {
        const text = typeof invalid === "string" ? invalid : JSON.stringify(invalid, null, 2);
        await setPendingJson(text);
        await nativeContextElement("json-load").click();
        expect(await nativeContextElement("configuration-json").getAttribute("aria-invalid")).toBe(
          "true",
        );
        await nativeContextElement("tab-trends").click();
        await nativeContextElement("tab-parameters").click();
        await closeNativeContextDetails();
        await openNativeContextDetails("parameters");
        await expandNativeContextJson();
        expect(await nativeContextElement("configuration-json").getValue()).toBe(text);
        await nativeContextElement("json-restore").click();
        await nativeContextElement("json-pending").waitForDisplayed({ reverse: true });
        expect(await readNativeContextFormConfiguration()).toEqual(original);
      }
      await setNativeContextRawField("images.jpegQuality", "NaN");
      expect(await nativeContextElement("save-parameters").isEnabled()).toBe(false);
      await nativeContextElement("tab-trends").click();
      await nativeContextElement("tab-parameters").click();
      await expandNativeContextParameterGroup("images");
      expect(await nativeContextElement("parameter-images.jpegQuality").getValue()).toBe("NaN");
      await loadNativeContextConfiguration(original);
      expect((await getNativeContextStatus(target)).policy.policyVersion).toBe(
        before.policy.policyVersion,
      );
      expect(await getUpstreamRequestRecordCount()).toBe(requestCount);
    },
    async () => {
      await loadNativeContextConfiguration(original);
    },
  );
}

export async function assertNativeContextTaskAndDefaultDraftIsolation() {
  const target = await nativeContextCurrentTarget();
  const status = await getNativeContextStatus(target);
  await openNativeContextDetails("parameters");
  const originalTask = await readNativeContextFormConfiguration();
  let originalDefault: NativeContextConfiguration | null = null;
  await withDraftCleanup(
    async () => {
      await setNativeContextRawField("images.jpegQuality", "77");
      const taskJson = JSON.stringify(
        { ...(await readNativeContextFormConfiguration()), taskOnlyDraft: true },
        null,
        2,
      );
      await setPendingJson(taskJson);
      await chooseNativeContextOption("scope", 1);
      await nativeContextElement("parameters-defaults").waitForDisplayed();
      originalDefault = await readNativeContextFormConfiguration();
      await setNativeContextRawField("images.jpegQuality", "81");
      const defaultJson = JSON.stringify(
        { ...(await readNativeContextFormConfiguration()), defaultOnlyDraft: true },
        null,
        2,
      );
      await setPendingJson(defaultJson);
      await chooseNativeContextOption("scope", 0);
      await expandNativeContextJson();
      expect(await nativeContextElement("configuration-json").getValue()).toBe(taskJson);
      expect(await nativeContextElement("parameter-images.jpegQuality").getValue()).toBe("77");
      await closeNativeContextDetails();
      await openNativeContextDetails("parameters");
      await expandNativeContextJson();
      expect(await nativeContextElement("configuration-json").getValue()).toBe(taskJson);
      expect(await nativeContextElement("parameter-images.jpegQuality").getValue()).toBe("77");
      await chooseNativeContextOption("scope", 1);
      expect(await nativeContextElement("configuration-json").getValue()).toBe(defaultJson);
      expect(await nativeContextElement("parameter-images.jpegQuality").getValue()).toBe("81");
      await nativeContextElement("json-restore").click();
      await saveDefaultDraft();
      expect((await getNativeContextStatus(target)).policy.policyVersion).toBe(
        status.policy.policyVersion,
      );
      await chooseNativeContextOption("scope", 0);
      expect(await nativeContextElement("configuration-json").getValue()).toBe(taskJson);
      expect(await nativeContextElement("parameter-images.jpegQuality").getValue()).toBe("77");
      await nativeContextElement("json-restore").click();
      await saveNativeContextConfiguration({
        ...originalTask,
        parameters: {
          ...originalTask.parameters,
          images: { ...originalTask.parameters.images, jpegQuality: 77 },
        },
      });
      await chooseNativeContextOption("scope", 1);
      await loadNativeContextConfiguration(originalDefault);
      await saveDefaultDraft();
      await chooseNativeContextOption("scope", 0);
      expect(await readNativeContextFormConfiguration()).toEqual({
        ...originalTask,
        parameters: {
          ...originalTask.parameters,
          images: { ...originalTask.parameters.images, jpegQuality: 77 },
        },
      });
    },
    async () => {
      await openNativeContextDetails("parameters");
      if (originalDefault) {
        await chooseNativeContextOption("scope", 1);
        await loadNativeContextConfiguration(originalDefault);
        if (await nativeContextElement("save-parameters").isEnabled()) await saveDefaultDraft();
      }
      await chooseNativeContextOption("scope", 0);
      const applied = await getNativeContextStatus(target);
      if (await nativeContextElement("reload-parameters").isExisting())
        await nativeContextElement("reload-parameters").click();
      await loadNativeContextConfiguration({
        schemaVersion: 1,
        mode: applied.policy.mode,
        parameters: applied.policy.parameters,
      });
    },
  );
}

export async function assertNativeContextExport(evidenceDirectory: string) {
  await openNativeContextDetails("parameters");
  const configuration = await readNativeContextFormConfiguration();
  const exportPath = await assertNativeContextTestPath(
    join(evidenceDirectory, "native-context-configuration.json"),
  );
  const dialog = await browser.electron.mock("dialog", "showSaveDialog");
  try {
    await dialog.mockResolvedValueOnce({ canceled: false, filePath: exportPath });
    await nativeContextElement("export-configuration").click();
    let exported: NativeContextConfiguration | null = null;
    await browser.waitUntil(
      async () => {
        try {
          exported = nativeContextConfigurationSchema.parse(
            JSON.parse(await readFile(exportPath, "utf8")),
          );
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      },
      {
        timeout: 20000,
        timeoutMsg: "NCTX did not export configuration through the native save dialog",
      },
    );
    expect(exported).toEqual(configuration);
    expect(Object.keys(exported!).sort()).toEqual(["mode", "parameters", "schemaVersion"]);
    await dialog.mockResolvedValueOnce({ canceled: true });
    await nativeContextElement("export-configuration").click();
    expect(await readNativeContextFormConfiguration()).toEqual(configuration);
  } finally {
    await dialog.mockRestore();
  }
}
