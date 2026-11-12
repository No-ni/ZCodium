import {
  NATIVE_CONTEXT_PARAMETER_FIELDS,
  nativeContextConfigurationSchema,
  type NativeContextConfiguration,
  type NativeContextParameterPath,
} from "@zcode/shared/native-context-compression";
import { setInputValueByTestIdDom } from "../desktop-app.js";
import { getNativeContextStatus, nativeContextCurrentTarget } from "./queries.js";

export const nativeContextElement = (id: string) => $(`[data-testid="native-context-${id}"]`);

export async function openNativeContextDetails(
  tab: "overview" | "trends" | "records" | "parameters" = "overview",
) {
  if (!(await nativeContextElement("details").isDisplayed())) {
    if (!(await nativeContextElement("popover").isDisplayed()))
      await nativeContextElement("entry").click();
    await nativeContextElement(tab === "parameters" ? "open-parameters" : "open-trends").click();
    await nativeContextElement("details").waitForDisplayed();
  }
  await nativeContextElement(`tab-${tab}`).click();
}

export async function closeNativeContextDetails() {
  if (await nativeContextElement("details").isDisplayed()) {
    await browser.keys("Escape");
    await nativeContextElement("details").waitForDisplayed({ reverse: true });
  }
  if (await nativeContextElement("popover").isDisplayed()) {
    // 原因：Escape 已发送时 portal 仍可能在卸载；先观察关闭，避免重开时点击已失效的入口。
    await browser.keys("Escape");
    await nativeContextElement("popover").waitForDisplayed({ reverse: true });
  }
}

export async function expandNativeContextParameterGroup(
  group: "trigger" | "history" | "tools" | "images" | "prompts",
) {
  const details = nativeContextElement(`advanced-${group}`);
  if ((await details.getAttribute("open")) === null) await details.$("summary").click();
}

export async function expandNativeContextJson() {
  const details = nativeContextElement("complete-editor");
  if ((await details.getAttribute("open")) === null) await details.$("summary").click();
}

export async function readNativeContextFormConfiguration() {
  await expandNativeContextJson();
  return nativeContextConfigurationSchema.parse(
    JSON.parse(await nativeContextElement("configuration-json").getValue()),
  );
}

export async function loadNativeContextConfiguration(configuration: NativeContextConfiguration) {
  nativeContextConfigurationSchema.parse(configuration);
  await openNativeContextDetails("parameters");
  await expandNativeContextJson();
  // 原因：完整 JSON 应模拟整段粘贴；逐字符键入会重复触发 90 字段的渲染并阻塞驱动。
  await setInputValueByTestIdDom(
    "native-context-configuration-json",
    JSON.stringify(configuration, null, 2) + "\n",
  );
  await nativeContextElement("json-pending").waitForDisplayed();
  await nativeContextElement("json-load").click();
  await nativeContextElement("json-pending").waitForDisplayed({ reverse: true });
  expect(await nativeContextElement("configuration-json").getAttribute("aria-invalid")).not.toBe(
    "true",
  );
  expect(await readNativeContextFormConfiguration()).toEqual(configuration);
}

export async function saveNativeContextConfiguration(configuration: NativeContextConfiguration) {
  const target = await nativeContextCurrentTarget();
  const previous = await getNativeContextStatus(target);
  await loadNativeContextConfiguration(configuration);
  if (
    JSON.stringify({ ...previous.policy, policyVersion: undefined }) ===
    JSON.stringify(configuration)
  )
    return previous;
  await nativeContextElement("save-parameters").waitForEnabled();
  await nativeContextElement("save-parameters").click();
  let result = previous;
  await browser.waitUntil(
    async () => {
      result = await getNativeContextStatus(target);
      return (
        result.policy.policyVersion > previous.policy.policyVersion &&
        JSON.stringify(result.policy.parameters) === JSON.stringify(configuration.parameters) &&
        result.policy.mode === configuration.mode
      );
    },
    {
      timeout: 20000,
      timeoutMsg: "NCTX parameter save did not commit the candidate to the owning CLI session",
    },
  );
  return result;
}

export async function setNativeContextRawField(path: NativeContextParameterPath, value: string) {
  const field = NATIVE_CONTEXT_PARAMETER_FIELDS.find((item) => item.path === path);
  if (!field) throw new Error("NCTX unknown parameter path");
  await expandNativeContextParameterGroup(field.group);
  await nativeContextElement(`parameter-${path}`).setValue(value);
}

export async function chooseNativeContextOption(testId: string, optionIndex: number) {
  const trigger = nativeContextElement(testId);
  await trigger.click();
  const options = await $$('[role="option"]');
  const option = options[optionIndex];
  if (!option) throw new Error(`NCTX option ${optionIndex} is absent from ${testId}`);
  await option.click();
}
