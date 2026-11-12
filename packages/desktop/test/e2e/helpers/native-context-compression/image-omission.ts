import { createHash } from "node:crypto";
import type {
  NativeContextConfiguration,
  NativeContextObservation,
} from "@zcode/shared/native-context-compression";
import { setInputValueByTestIdDom as setInput } from "../desktop-app.js";
import {
  getV4ComposerAttachments,
  getV4ComposerText,
  setV4ComposerText,
  waitForV4ComposerText,
  waitForV4ConversationState,
} from "../v4-conversation.js";
import { runNativeContextCleanup, withNativeContextCleanup } from "./cleanup.js";
import { readNativePngDimensions, type NativeContextPngFixture } from "./fixture.js";
import {
  nativeContextWireImages as wireImages,
  sendNativeContextImage,
  sendNativeContextPrompt,
} from "./images.js";
import {
  getNativeContextStatus as readStatus,
  listNativeContextRecords as listRecords,
  nativeContextCurrentTarget as currentTarget,
  readNativeContextOriginalImage as readOriginal,
  type NativeContextTestTarget,
} from "./queries.js";
import {
  chooseNativeContextOption as chooseOption,
  closeNativeContextDetails as closeDetails,
  expandNativeContextJson as expandJson,
  loadNativeContextConfiguration as loadConfiguration,
  nativeContextElement as element,
  openNativeContextDetails as openDetails,
  readNativeContextFormConfiguration as readForm,
  saveNativeContextConfiguration as saveConfiguration,
} from "./ui.js";

function replay(name: string, inputTokens: number) {
  return {
    marker: `E2E_NCTX_IMAGE_OMISSION_${name.toUpperCase()}`,
    fixtureId: `native-image-omission-${name}-main`,
    inputTokens,
  };
}
export const NATIVE_CONTEXT_IMAGE_OMISSION_REPLAY = {
  prime: replay("prime", 3600),
  omit: replay("new", 3700),
  manual: replay("manual", 3800),
  disabled: replay("disabled", 3900),
  reencoded: replay("reencoded", 4000),
} as const;
type Step = keyof typeof NATIVE_CONTEXT_IMAGE_OMISSION_REPLAY;
export type NativeContextImageOmissionMarkers = Record<Step, string>;
interface SourceGroup {
  marker: string;
  count: number;
  sha256: string;
  refs?: readonly string[];
}
export interface NativeContextImageOmissionEvidence {
  target: NativeContextTestTarget;
  originalRefs: string[];
  newRef: string;
  steps: Array<{
    marker: string;
    fixtureId: string;
    observation: NativeContextObservation;
    wireSha256: string[];
    omittedRefs: string[];
  }>;
}
type Sent = Awaited<ReturnType<typeof sendNativeContextPrompt>>;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const hashes = (value: unknown) =>
  wireImages(value)
    .map((image) => sha256(image.bytes))
    .sort();
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const jsonEditor = () => element("configuration-json");

function textParts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(textParts);
  if (!object(value)) return [];
  return typeof value.text === "string" ? [value.text] : textParts(value.content ?? value.messages);
}
function uploadContent(request: unknown, marker: string): unknown {
  if (!object(request) || !Array.isArray(request.messages))
    throw new Error("NCTX omission request has no real provider messages");
  const user = request.messages.findLast(
    (message) =>
      object(message) &&
      message.role === "user" &&
      textParts(message.content).some((text) => text.includes(marker)),
  );
  if (!object(user)) throw new Error(`NCTX omission cannot locate the real upload ${marker}`);
  return user.content;
}
function imageRefs(content: unknown, kind: "sent" | "omitted"): string[] {
  const pattern =
    kind === "sent"
      ? /\[Image ref=([^:\]]+): sending a smaller copy;/g
      : /\[Image ref=([^:\]]+): original available with context_read_image\.\]/g;
  return [
    ...new Set(
      textParts(content).flatMap((text) => [...text.matchAll(pattern)].map((match) => match[1]!)),
    ),
  ].sort();
}
function assertWire(sent: Sent, sourceCount: number, beforeBytes: number) {
  const images = wireImages(sent.request);
  const omittedRefs = imageRefs(sent.request, "omitted");
  expect(sent.observation.images.sourceCount).toBe(sourceCount);
  expect(sent.observation.images.sourceCoverage).toBe(sourceCount);
  expect(sent.observation.images.sentCount).toBe(images.length);
  expect(sent.observation.images.omittedCount).toBe(omittedRefs.length);
  expect(sent.observation.images.sentCount + omittedRefs.length).toBe(sourceCount);
  expect(sent.observation.images.beforeBytes).toBe(beforeBytes);
  expect(sent.observation.images.afterBytes).toBe(
    images.reduce((total, image) => total + image.bytes.length, 0),
  );
  expect(sent.observation.images.foldedCount).toBe(0);
  expect(sent.observation.images.restoredCount).toBe(0);
  expect(sent.observation.visionTokens).toBeNull();
  return omittedRefs;
}

function paidOperationIds(page: Awaited<ReturnType<typeof listRecords>>) {
  expect(page.nextCursor).toBeNull();
  return page.items
    .filter(({ kind }) => kind === "summary" || kind === "decision")
    .map(({ operationId }) => operationId)
    .sort();
}

async function rawInputs() {
  return browser.execute(() =>
    Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'input[data-testid^="native-context-parameter-"],textarea[data-testid^="native-context-parameter-"]',
      ),
    ).map((input) => ({ id: input.dataset.testid!, value: input.value })),
  );
}
async function restoreRawInputs(inputs: Awaited<ReturnType<typeof rawInputs>>) {
  for (const input of inputs)
    if ((await $(`[data-testid="${input.id}"]`).getValue()) !== input.value)
      await setInput(input.id, input.value);
}

/** 冷恢复和原图工具成功回取后、deep compact 前独立执行；不清库，也不签发测试证明。 */
export async function assertNativeContextImageOmission(input: {
  target: NativeContextTestTarget;
  sources: readonly SourceGroup[];
  newImage: NativeContextPngFixture;
  markers: NativeContextImageOmissionMarkers;
}): Promise<NativeContextImageOmissionEvidence> {
  const { target, sources, newImage, markers } = input;
  expect(await currentTarget()).toEqual(target);
  expect(sources.map((source) => source.count)).toEqual([1, 2, 1]);
  expect(new Set(sources.map((source) => source.marker)).size).toBe(3);
  await closeDetails();
  const composerText = await getV4ComposerText();
  if (composerText === null) throw new Error("NCTX omission requires the real mounted composer");
  expect(await getV4ComposerAttachments()).toHaveLength(0);
  await waitForV4ConversationState(
    (state) =>
      state.sessionId === target.sessionId && state.state === "idle" && state.queueCount === 0,
    "NCTX omission requires the same settled CLI owner",
  );
  const before = await readStatus(target);
  expect(before.phase).toBe("idle");
  expect(before.policy.mode).toBe("manual");
  const paidBefore = paidOperationIds(await listRecords(target, before, { limit: 200 }));
  const originalConfiguration: NativeContextConfiguration = {
    schemaVersion: 1,
    mode: before.policy.mode,
    parameters: structuredClone(before.policy.parameters),
  };
  await openDetails("parameters");
  const defaultsScope = await element("parameters-defaults").isDisplayed();
  if (defaultsScope) await chooseOption("scope", 0);
  await expandJson();
  const json = {
    text: await jsonEditor().getValue(),
    pending: await element("json-pending").isExisting(),
    invalid: (await jsonEditor().getAttribute("aria-invalid")) === "true",
  };
  const raw = await rawInputs();
  let originalDraft: NativeContextConfiguration | null = null;
  let policyChanged = false;
  const filename = `${markers.omit}-1.png`;
  const run = async () => {
    if (json.pending) await element("json-restore").click();
    originalDraft = await readForm();
    const configuration = structuredClone(originalConfiguration);
    configuration.mode = "auto";
    Object.assign(configuration.parameters.history, {
      preserveTurns: 0,
      preserveMessages: 0,
      preserveTokens: 0,
    });
    Object.assign(configuration.parameters.trigger, {
      start: { kind: "percent", value: 95 },
      target: { kind: "percent", value: 90 },
      modelDecides: false,
      growthMode: "constant",
      growthTokens: 1000000,
      checkIntervalRounds: 1000,
      periodicCheckRounds: 0,
      opportunisticPercent: 95,
    });
    configuration.parameters.tools.reference.enabled = false;
    configuration.parameters.tools.distill.enabled = false;
    Object.assign(configuration.parameters.images, {
      rescale: true,
      omitSeen: true,
      keepRecentUserTurns: 1,
      foldWithHistory: false,
      maxEdge: 320,
      minEdge: 128,
      pngMode: "preserve",
      alphaMode: "preserve",
    });
    const evidence: NativeContextImageOmissionEvidence = {
      target,
      originalRefs: [],
      newRef: "",
      steps: [],
    };
    const send = async (step: Step, candidate: NativeContextConfiguration) => {
      policyChanged = true;
      const applied = await saveConfiguration(candidate);
      const { fixtureId: id, inputTokens: tokens } = NATIVE_CONTEXT_IMAGE_OMISSION_REPLAY[step];
      const marker = markers[step];
      // 原因：复用的发送 helper 使用 count-1 排他边界，并等待真实 usage 完成及 CLI idle。
      const sent =
        step === "omit"
          ? await sendNativeContextImage(marker, id, newImage, 1, tokens)
          : await sendNativeContextPrompt(marker, id, tokens);
      expect(sent.target).toEqual(target);
      expect(sent.status.policy).toEqual(applied.policy);
      expect(sent.status.generation).toBe(before.generation);
      expect(sent.status.effectiveBlocks).toBe(before.effectiveBlocks);
      expect(sent.observation.policyVersion).toBe(applied.policy.policyVersion);
      evidence.steps.push({
        marker,
        fixtureId: id,
        observation: sent.observation,
        wireSha256: hashes(sent.request),
        omittedRefs: imageRefs(sent.request, "omitted"),
      });
      return sent;
    };
    // 完整图片策略进入证明 key；先成功发送当前表示，再验证下一轮省略，不能只看 HTTP 200。
    const prime = await send("prime", configuration);
    const baseCount = prime.observation.images.sourceCount;
    const baseBytes = prime.observation.images.beforeBytes;
    if (baseBytes === null || baseCount < 4)
      throw new Error("NCTX omission prime lacks measurable original carriers");
    expect(assertWire(prime, baseCount, baseBytes)).toHaveLength(0);
    for (const source of sources) {
      const content = uploadContent(prime.request, source.marker);
      const refs = imageRefs(content, "sent");
      expect(refs).toHaveLength(source.count);
      expect(wireImages(content)).toHaveLength(source.count);
      if (source.refs) expect(refs).toEqual([...source.refs].sort());
      evidence.originalRefs.push(...refs);
    }
    expect(new Set(evidence.originalRefs).size).toBe(4);
    const omit = await send("omit", configuration);
    const count = baseCount + 1,
      bytes = baseBytes + newImage.bytes.length;
    const omitted = assertWire(omit, count, bytes);
    for (const source of sources) {
      const content = uploadContent(omit.request, source.marker);
      expect(wireImages(content)).toHaveLength(0);
      expect(imageRefs(content, "omitted")).toEqual(
        imageRefs(uploadContent(prime.request, source.marker), "sent"),
      );
    }
    const currentContent = uploadContent(omit.request, markers.omit);
    // 新图来源、原 hash 和真实缩图已由同一发送 helper 对账，此处只验证旧证明不能授权新 ref。
    evidence.newRef = imageRefs(currentContent, "sent")[0]!;
    expect(evidence.originalRefs).not.toContain(evidence.newRef);
    expect(omitted).not.toContain(evidence.newRef);
    const manualConfiguration = structuredClone(configuration);
    manualConfiguration.mode = "manual";
    Object.assign(manualConfiguration.parameters.images, {
      rescale: false,
      omitSeen: false,
      maxEdge: 160,
    });
    const manual = await send("manual", manualConfiguration);
    expect(assertWire(manual, count, bytes)).toEqual(omitted);
    expect(hashes(manual.request)).toEqual(hashes(omit.request));
    // 关闭 omitSeen 时恢复同一 320px 表示；编码不变仍须重新发送，不能无条件延续省略 latch。
    const disabledConfiguration = structuredClone(configuration);
    disabledConfiguration.parameters.images.omitSeen = false;
    const disabled = await send("disabled", disabledConfiguration);
    expect(assertWire(disabled, count, bytes)).toHaveLength(0);
    expect(hashes(disabled.request)).toEqual(
      [...hashes(prime.request), ...hashes(currentContent)].sort(),
    );
    const reencodedConfiguration = structuredClone(configuration);
    reencodedConfiguration.parameters.images.maxEdge = 160;
    const reencoded = await send("reencoded", reencodedConfiguration);
    expect(assertWire(reencoded, count, bytes)).toHaveLength(0);
    for (const image of wireImages(reencoded.request)) {
      expect(image.mediaType).toBe("image/png");
      const size = readNativePngDimensions(image.bytes);
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(160);
      expect(hashes(disabled.request)).not.toContain(sha256(image.bytes));
    }
    for (const source of sources)
      for (const ref of imageRefs(uploadContent(prime.request, source.marker), "sent")) {
        const original = await readOriginal(target, reencoded.status, ref);
        expect(original.sha256).toBe(source.sha256);
      }
    // image 记录可随成功 receipt 新增；主图片用量不是付费摘要/决策维护，必须分开对账。
    expect(paidOperationIds(await listRecords(target, reencoded.status, { limit: 200 }))).toEqual(
      paidBefore,
    );
    return evidence;
  };
  return withNativeContextCleanup(run, () =>
    runNativeContextCleanup(
      async () => {
        if (policyChanged) await saveConfiguration(originalConfiguration);
        if (originalDraft) {
          await loadConfiguration(originalDraft);
          await restoreRawInputs(raw);
        }
        if (json.pending) {
          await setInput("native-context-configuration-json", json.text);
          await element("json-pending").waitForDisplayed();
          if (json.invalid) {
            await element("json-load").click();
            expect(await jsonEditor().getAttribute("aria-invalid")).toBe("true");
          }
        }
        expect(await jsonEditor().getValue()).toBe(json.text);
      },
      async () => {
        await closeDetails();
        for (const attachment of await getV4ComposerAttachments()) {
          expect(attachment.text).toBe(filename);
          const remove = $("[data-composer-attachment-remove]");
          await remove.moveTo();
          await remove.click();
        }
        expect(await getV4ComposerAttachments()).toHaveLength(0);
      },
      async () => {
        await setV4ComposerText(composerText);
        await waitForV4ComposerText(
          composerText,
          "NCTX omission did not restore the unsent composer text",
        );
      },
      async () => {
        if (defaultsScope) {
          await openDetails("parameters");
          await chooseOption("scope", 1);
        }
        await closeDetails();
      },
    ),
  );
}
