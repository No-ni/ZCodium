import { createHash } from "node:crypto";
import type {
  NativeContextObservation,
  NativeContextStatus,
} from "@zcode/shared/native-context-compression";
import {
  getUpstreamRequestEvidence,
  getUpstreamRequestRecordCount,
} from "../conversation-session-network.js";
import {
  E2E_REPLY_TOKEN,
  pasteV4ComposerImageAttachment,
  sendV4Prompt,
  waitForV4ConversationState,
} from "../v4-conversation.js";
import {
  getNativeContextStatus,
  listNativeContextObservations,
  listNativeContextRecords,
  nativeContextCurrentTarget,
  readNativeContextOriginalImage,
  readNativeContextRecord,
  type NativeContextTestTarget,
} from "./queries.js";
import {
  nativePngHasTransparentPixel,
  readNativePngDimensions,
  type NativeContextPngFixture,
} from "./fixture.js";
import { closeNativeContextDetails, nativeContextElement, openNativeContextDetails } from "./ui.js";

export interface NativeContextImageEvidence {
  target: NativeContextTestTarget;
  request: unknown;
  observation: NativeContextObservation;
  status: NativeContextStatus;
  operationId: string;
  sourceMessageId: string;
  originalRefs: string[];
  originalSha256: string;
  sourceBytes: number;
  sentBytes: number;
  chunkCounts: number[];
}

/** 只解析 provider 收到的图片；不拿 UI 的 thumbnail 或 observation 自报值代替实际编码。 */
export function nativeContextWireImages(
  value: unknown,
): Array<{ bytes: Buffer; mediaType: string }> {
  if (Array.isArray(value)) return value.flatMap(nativeContextWireImages);
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const source = object.source as Record<string, unknown> | undefined;
  if (
    object.type === "image" &&
    source?.type === "base64" &&
    typeof source.data === "string" &&
    typeof source.media_type === "string"
  )
    return [
      {
        bytes: Buffer.from(source.data, "base64"),
        mediaType: source.media_type,
      },
    ];
  const imageUrl = object.image_url as { url?: unknown } | undefined;
  if (object.type === "image_url" && typeof imageUrl?.url === "string") {
    const match = /^data:(image\/[^;,]+);base64,(.+)$/.exec(imageUrl.url);
    if (match) return [{ bytes: Buffer.from(match[2]!, "base64"), mediaType: match[1]! }];
  }
  return Object.values(object).flatMap(nativeContextWireImages);
}

/** 最后真实用户上传由 marker 定位；不能把整份历史尾部图片的排列猜作附件身份。 */
export function nativeContextLatestUploadImages(request: unknown, marker: string) {
  return nativeContextWireImages(nativeContextLatestUploadContent(request, marker));
}

function nativeContextLatestUploadContent(request: unknown, marker: string) {
  const messages = (request as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) throw new Error("NCTX provider request has no message array");
  const message = messages.findLast((value: unknown) => {
    if (!value || typeof value !== "object") return false;
    const candidate = value as { role?: string; content?: unknown };
    return candidate.role === "user" && JSON.stringify(candidate.content).includes(marker);
  }) as { content?: unknown } | undefined;
  if (!message)
    throw new Error("NCTX current real user upload is missing from the provider request");
  return message.content;
}

/** 来源身份由本次实际发送的ref说明证明；回复的用量锚点不是用户上传的message。 */
function nativeContextLatestUploadRefs(request: unknown, marker: string) {
  const content = nativeContextLatestUploadContent(request, marker);
  if (!Array.isArray(content)) throw new Error("NCTX upload has no structured image content");
  return content.flatMap((part: unknown) => {
    if (!part || typeof part !== "object") return [];
    const text = (part as { type?: unknown; text?: unknown }).text;
    if (typeof text !== "string") return [];
    return Array.from(
      text.matchAll(/\[Image ref=([^\]\r\n]{1,240}?): sending a smaller copy;/gu),
      (match) => match[1]!,
    );
  });
}

export async function sendNativeContextPrompt(
  marker: string,
  fixtureId: string,
  expectedInputTokens: number,
  prompt?: string,
) {
  // 原因：afterIndex 为排他边界，不能把 count 当作最后一条请求索引。
  const afterIndex = (await getUpstreamRequestRecordCount()) - 1;
  await closeNativeContextDetails();
  await sendV4Prompt(
    prompt ?? `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`,
  );
  let records = await getUpstreamRequestEvidence(
    { lastUserMessageIncludes: [marker] },
    { afterIndex },
  );
  await browser.waitUntil(
    async () => {
      records = await getUpstreamRequestEvidence(
        { lastUserMessageIncludes: [marker] },
        { afterIndex },
      );
      return records.some(
        (record) => record.fixtureId === fixtureId && record.status === "complete",
      );
    },
    {
      timeout: 90000,
      timeoutMsg: `${marker} did not complete through its controlled provider fixture`,
    },
  );
  expect(records).toHaveLength(1);
  expect(records[0]?.fixtureId).toBe(fixtureId);
  expect(records[0]?.statusCode).toBe(200);
  await waitForV4ConversationState(
    (state) => state.state === "idle" && state.queueCount === 0,
    `${marker} did not settle in the existing CLI runtime`,
    90000,
  );
  const target = await nativeContextCurrentTarget();
  let status = await getNativeContextStatus(target);
  await browser.waitUntil(
    async () => {
      status = await getNativeContextStatus(target);
      return (
        status.lastObservation?.purpose === "main" &&
        status.lastObservation.status === "completed" &&
        status.lastObservation.actualInputTokens === expectedInputTokens
      );
    },
    {
      timeout: 20000,
      timeoutMsg: `${marker} did not freeze the provider's real usage observation`,
    },
  );
  return {
    target,
    status,
    observation: status.lastObservation!,
    request: records[0]!.requestJson,
  };
}

export async function sendNativeContextImage(
  marker: string,
  fixtureId: string,
  fixture: NativeContextPngFixture,
  count: number,
  expectedInputTokens: number,
): Promise<NativeContextImageEvidence> {
  await closeNativeContextDetails();
  for (let index = 0; index < count; index += 1)
    await pasteV4ComposerImageAttachment(`${marker}-${index + 1}.png`, {
      base64: fixture.base64,
      mimeType: "image/png",
    });
  const sent = await sendNativeContextPrompt(marker, fixtureId, expectedInputTokens);
  const images = nativeContextWireImages(sent.request);
  expect(images.length).toBeGreaterThanOrEqual(count);
  expect(images.every((image) => image.bytes.byteLength > 0)).toBe(true);
  expect(sent.observation.images.afterBytes).toBe(
    images.reduce((sum, image) => sum + image.bytes.length, 0),
  );
  expect(sent.observation.images.sourceCoverage).toBe(sent.observation.images.sourceCount);
  expect(sent.observation.images.sentCount).toBe(images.length);
  const currentImages = nativeContextLatestUploadImages(sent.request, marker);
  expect(currentImages).toHaveLength(count);
  for (const copy of currentImages) {
    expect(createHash("sha256").update(copy.bytes).digest("hex")).not.toBe(fixture.sha256);
    expect(copy.mediaType).toBe("image/png");
    const dimensions = readNativePngDimensions(copy.bytes);
    expect(Math.max(dimensions.width, dimensions.height)).toBeLessThanOrEqual(
      sent.status.policy.parameters.images.maxEdge,
    );
    expect(Math.max(dimensions.width, dimensions.height)).toBeGreaterThanOrEqual(
      sent.status.policy.parameters.images.minEdge,
    );
    expect(copy.bytes.length).toBeLessThan(fixture.bytes.length);
    if (fixture.alpha) expect(nativePngHasTransparentPixel(copy.bytes)).toBe(true);
  }
  const operations = await listNativeContextRecords(sent.target, sent.status, {
    limit: 200,
  });
  const imageOperations = operations.items.filter(
    (item) => item.kind === "image" && sent.observation.operationIds.includes(item.operationId),
  );
  expect(imageOperations.length).toBeGreaterThan(0);
  expect(sent.observation.anchorMessageId).toBeTruthy();
  const currentRefs = new Set(nativeContextLatestUploadRefs(sent.request, marker));
  expect(currentRefs.size).toBe(count);
  const originals: Array<{
    ref: string;
    partId: string;
    pages: number;
    operationId: string;
  }> = [];
  const sourceMessageIds = new Set<string>();
  for (const operation of imageOperations) {
    expect(operation.status).toBe("completed");
    const detail = await readNativeContextRecord(sent.target, sent.status, operation.operationId, {
      sourceLimit: 100,
    });
    for (const source of detail.sources.filter(
      (item) => item.kind === "image" && currentRefs.has(item.ref),
    )) {
      expect(source.partId).not.toBeNull();
      expect(source.originalAvailable).toBe(true);
      const original = await readNativeContextOriginalImage(sent.target, sent.status, source.ref);
      expect(original.sha256).toBe(fixture.sha256);
      sourceMessageIds.add(source.messageId);
      if (!originals.some((item) => item.ref === source.ref))
        originals.push({
          ref: source.ref,
          partId: source.partId!,
          pages: original.pages.length,
          operationId: operation.operationId,
        });
    }
  }
  expect(new Set(originals.map((item) => item.ref)).size).toBe(count);
  expect(new Set(originals.map((item) => item.partId)).size).toBe(count);
  expect(sourceMessageIds.size).toBe(1);
  expect(sourceMessageIds.has(sent.observation.anchorMessageId!)).toBe(false);
  if (fixture.bytes.length > 512 * 1024)
    expect(originals.every((item) => item.pages > 1)).toBe(true);
  return {
    ...sent,
    operationId: originals[0]!.operationId,
    sourceMessageId: [...sourceMessageIds][0]!,
    originalRefs: originals.map((item) => item.ref),
    originalSha256: fixture.sha256,
    sourceBytes: fixture.bytes.length,
    sentBytes: images.reduce((sum, image) => sum + image.bytes.length, 0),
    chunkCounts: originals.map((item) => item.pages),
  };
}

export async function inspectNativeContextImageRecord(
  evidence: NativeContextImageEvidence,
  fixture: NativeContextPngFixture,
) {
  const before = await getUpstreamRequestRecordCount();
  await openNativeContextDetails("records");
  await nativeContextElement(`record-${evidence.operationId}`).waitForDisplayed();
  await nativeContextElement(`record-${evidence.operationId}`).click();
  await nativeContextElement("record-detail").waitForDisplayed();
  expect(await nativeContextElement("record-detail").getAttribute("data-operation-id")).toBe(
    evidence.operationId,
  );
  const facts = nativeContextElement("record-image-facts");
  await browser.waitUntil(
    async () =>
      (await facts.getAttribute("data-after-bytes")) ===
      String(evidence.observation.images.afterBytes),
    {
      timeout: 20000,
      timeoutMsg: "NCTX image record has no actual main-request byte facts",
    },
  );
  expect(await facts.getAttribute("data-before-bytes")).toBe(
    String(evidence.observation.images.beforeBytes),
  );
  await nativeContextElement(`source-${evidence.originalRefs[0]}`).click();
  await nativeContextElement("read-image").click();
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const image = document.querySelector<HTMLImageElement>(
          '[data-testid="native-context-original-image"]',
        );
        return !!image?.complete && image.naturalWidth > 0;
      }),
    {
      timeout: 30000,
      timeoutMsg: "NCTX did not combine original image chunks into a decodable preview",
    },
  );
  const actual = await browser.execute(() => {
    const image = document.querySelector<HTMLImageElement>(
      '[data-testid="native-context-original-image"]',
    )!;
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      source: image.src.startsWith("blob:"),
    };
  });
  expect(actual).toEqual({
    width: fixture.width,
    height: fixture.height,
    source: true,
  });
  expect(await getUpstreamRequestRecordCount()).toBe(before);
  const current = await getNativeContextStatus(evidence.target);
  const observations = await listNativeContextObservations(evidence.target, current, {
    limit: 200,
  });
  expect(
    observations.items.find((item) => item.id === evidence.observation.id)?.images.restoredCount,
  ).toBe(evidence.observation.images.restoredCount);
}
