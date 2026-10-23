import {
  modelMessageContentToText,
  type ModelMessageContent,
  type ModelMessageContentBlock,
} from "@zcode/contracts";
import { findOfficialCuaFrameContentPair } from "@zcode/zcode-cua/frame-contract";
import type { ToolResultSerialization } from "../types.js";

interface HookStringProjection {
  content: string;
  truncated: boolean;
}

const OFFICIAL_CUA_TEXT_TRUNCATION_MARKER =
  "[Official CUA text truncated by resultBudget. Re-observe with detail=compact or a narrower window before relying on omitted state.]";

const OFFICIAL_CUA_FRAME_CONTRACT_ERROR_CODE = "official_cua_frame_pair_not_leading";

export class OfficialCuaFrameContractError extends Error {
  readonly code = OFFICIAL_CUA_FRAME_CONTRACT_ERROR_CODE;

  constructor() {
    super("Official CUA frame pair must be the first two result blocks");
    this.name = "OfficialCuaFrameContractError";
  }
}

export function projectOfficialCuaStructuredContent(
  content: ModelMessageContentBlock[],
  maxModelBytes: number,
  direction: "head" | "tail",
): { content: ModelMessageContentBlock[]; truncated: boolean } | undefined {
  const pair = findOfficialCuaFrameContentPair(content);
  if (!pair) return undefined;
  // 官方 producer 的 canonical pair 必须已经位于结果首部。consumer 只校验、
  // 预算并保序，不再猜测或提升非 canonical 布局。这里直接失败，避免后续通用
  // 小结果直通路径重新把带前缀的 frame authority 交给模型。
  if (pair.imageIndex !== 0 || pair.imageRefIndex !== 1) {
    throw new OfficialCuaFrameContractError();
  }

  const pairContent: ModelMessageContentBlock[] = [pair.image, pair.imageRef];
  const suffixBlocks = content
    .slice(2)
    .filter(
      (block): block is Extract<ModelMessageContentBlock, { type: "text" }> =>
        block.type === "text" && block.text.length > 0,
    );
  const hasOtherStructuredBlocks = content.some(
    (block, index) =>
      index !== pair.imageRefIndex && index !== pair.imageIndex && block.type !== "text",
  );
  const completeContent: ModelMessageContentBlock[] = [...pairContent, ...suffixBlocks];
  if (
    !hasOtherStructuredBlocks &&
    Buffer.byteLength(stringifyModelContentForSerialization(completeContent), "utf8") <=
      maxModelBytes
  ) {
    return { content: completeContent, truncated: false };
  }

  const suffixText = joinTextBlocks(suffixBlocks);
  const pairBytes = Buffer.byteLength(stringifyModelContentForSerialization(pairContent), "utf8");
  const remainingAfterPair = Math.max(0, maxModelBytes - pairBytes);
  const projectedMarker = fitStringToBytes(
    OFFICIAL_CUA_TEXT_TRUNCATION_MARKER,
    Math.max(0, remainingAfterPair - 2),
    "head",
  );
  const markerCost =
    projectedMarker.length > 0 ? Buffer.byteLength(projectedMarker, "utf8") + 2 : 0;
  const suffixBudget =
    projectedMarker.length > 0 ? Math.max(0, remainingAfterPair - markerCost - 2) : 0;
  const projectedSuffix = fitStringToBytes(suffixText, suffixBudget, direction);

  const projected: ModelMessageContentBlock[] = [
    pair.image,
    pair.imageRef,
    ...(projectedSuffix ? [{ type: "text" as const, text: projectedSuffix }] : []),
    ...(projectedMarker ? [{ type: "text" as const, text: projectedMarker }] : []),
  ];
  return {
    content: projected,
    truncated: true,
  };
}

export function appendHookWithoutReorderingStructuredContent(
  serialization: ToolResultSerialization,
  hookContext: string,
  suffix: string,
  maxModelBytes: number,
): ToolResultSerialization {
  const modelContent = serialization.modelContent ?? serialization.content;
  if (!Array.isArray(modelContent)) return serialization;

  const currentBytes = Buffer.byteLength(serialization.content, "utf8");
  const remainingBytes = Math.max(0, maxModelBytes - currentBytes);
  const separator = "\n\n";
  const separatorBytes = Buffer.byteLength(separator, "utf8");
  const fittedHookContext =
    remainingBytes > separatorBytes
      ? fitStringToBytes(hookContext, remainingBytes - separatorBytes, "head")
      : "";
  const fittedSuffix = fittedHookContext.length > 0 ? `${separator}${fittedHookContext}` : "";
  const hookTruncated = Buffer.byteLength(suffix, "utf8") > remainingBytes;
  const content = `${serialization.content}${fittedSuffix}`;

  return {
    ...serialization,
    content,
    // 只能在原始块之后追加 hook。这样 raster 仍然是首块、image_ref 仍紧随其后，
    // 即使 hook 超出预算也不会把文本搬到图片前或用字符串替换图片。
    modelContent:
      fittedHookContext.length > 0
        ? [...modelContent, { type: "text", text: fittedHookContext }]
        : modelContent,
    // returnedBytes 已包含受保护 raster；追加 hook 只增加实际新增的文本 bytes，
    // 避免重新拆分文本/媒体并维护第二份计量状态。
    returnedBytes: serialization.returnedBytes + Buffer.byteLength(fittedSuffix, "utf8"),
    truncated: serialization.truncated || hookTruncated,
  };
}

export function appendHookToStringContent(
  content: string,
  suffix: string,
  maxBytes: number,
  previewDirection: "head" | "tail",
): HookStringProjection {
  const augmentedContent = `${content}${suffix}`;
  if (Buffer.byteLength(augmentedContent, "utf8") <= maxBytes) {
    return { content: augmentedContent, truncated: false };
  }
  return {
    content: fitContentWithSuffix(content, maxBytes, suffix, previewDirection),
    truncated: true,
  };
}

export function appendHookToPersistedArtifactPreview(
  content: string,
  suffix: string,
  maxHookBytes: number,
): HookStringProjection {
  const fittedSuffix = fitStringToBytes(suffix, maxHookBytes, "head");
  return {
    content: `${content}${fittedSuffix}`,
    truncated: Buffer.byteLength(suffix, "utf8") > maxHookBytes,
  };
}

export function projectHookAugmentedModelContent(input: {
  artifactPreview: boolean;
  contentProjection: HookStringProjection;
  hookContext: string;
  maxModelBytes: number;
  modelContent: ModelMessageContent;
  previewDirection: "head" | "tail";
  suffix: string;
}): ModelMessageContent {
  if (input.artifactPreview) return input.contentProjection.content;
  if (!input.contentProjection.truncated) {
    return appendHookContextToModelContent(input.modelContent, input.hookContext);
  }
  if (!hasPreservedStructuredBlocks(input.modelContent)) return input.contentProjection.content;

  const textContent = budgetedTextFromStructuredContent(input.modelContent);
  const budgetedText = fitContentWithSuffix(
    textContent,
    input.maxModelBytes,
    input.suffix,
    input.previewDirection,
  );
  return [
    ...input.modelContent.filter(shouldPreserveStructuredBlock),
    ...(budgetedText.length > 0 ? [{ type: "text" as const, text: budgetedText }] : []),
  ];
}

export function fitContentWithSuffix(
  content: string,
  maxBytes: number,
  suffix: string,
  direction: "head" | "tail",
): string {
  if (maxBytes <= 0) return "";
  const suffixContent = fitStringToBytes(suffix, maxBytes, "head");
  const remainingBytes = maxBytes - Buffer.byteLength(suffixContent, "utf8");
  if (remainingBytes <= 0) return suffixContent;
  return `${fitStringToBytes(content, remainingBytes, direction)}${suffixContent}`;
}

function joinTextBlocks(content: ModelMessageContentBlock[]): string {
  return content
    .filter(
      (block): block is Extract<ModelMessageContentBlock, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function stringifyModelContentForSerialization(content: ModelMessageContent): string {
  return typeof content === "string" ? content : modelMessageContentToText(content);
}

function appendHookContextToModelContent(
  content: ModelMessageContent,
  hookContext: string,
): ModelMessageContent {
  if (typeof content === "string") return `${content}\n\n${hookContext}`;
  return [...content, { type: "text", text: hookContext }];
}

function hasPreservedStructuredBlocks(
  content: ModelMessageContent,
): content is ModelMessageContentBlock[] {
  return Array.isArray(content) && content.some(shouldPreserveStructuredBlock);
}

function shouldPreserveStructuredBlock(block: ModelMessageContentBlock): boolean {
  if (block.type === "text") return false;
  if (block.type === "file" && typeof block.text === "string" && block.text.length > 0) {
    return false;
  }
  return true;
}

function budgetedTextFromStructuredContent(content: ModelMessageContentBlock[]): string {
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "file" && typeof block.text === "string") return block.text;
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n\n");
}

const UTF8_MAX_BYTES_PER_CODE_UNIT = 3;
const UTF8_SINGLE_BYTE_MAX_CODE_UNIT = 0x7f;
const UTF8_TWO_BYTE_MAX_CODE_UNIT = 0x7ff;
const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;

function fitStringToBytes(value: string, maxBytes: number, direction: "head" | "tail"): string {
  if (maxBytes <= 0) return "";
  if (value.length * UTF8_MAX_BYTES_PER_CODE_UNIT <= maxBytes) return value;
  // 文本长度本身受预算约束时保留原生快路，避免可容纳的 ASCII 退化为逐码元扫描。
  if (value.length <= maxBytes && Buffer.byteLength(value, "utf8") <= maxBytes) return value;

  const fromTail = direction === "tail";
  let cursor = fromTail ? value.length : 0;
  let bytes = 0;
  while (fromTail ? cursor > 0 : cursor < value.length) {
    const codeUnit = value.charCodeAt(fromTail ? cursor - 1 : cursor);
    let codeUnits = 1;
    let codePointBytes =
      codeUnit <= UTF8_SINGLE_BYTE_MAX_CODE_UNIT
        ? 1
        : codeUnit <= UTF8_TWO_BYTE_MAX_CODE_UNIT
          ? 2
          : UTF8_MAX_BYTES_PER_CODE_UNIT;
    // 合法代理对不可拆开；孤立代理项计 3 字节但保留原码元，不能经 UTF-8 解码替换。
    const possiblePair = fromTail
      ? codeUnit >= LOW_SURROGATE_START && codeUnit <= LOW_SURROGATE_END && cursor > 1
      : codeUnit >= HIGH_SURROGATE_START &&
        codeUnit <= HIGH_SURROGATE_END &&
        cursor + 1 < value.length;
    if (possiblePair) {
      const adjacent = value.charCodeAt(fromTail ? cursor - 2 : cursor + 1);
      const paired = fromTail
        ? adjacent >= HIGH_SURROGATE_START && adjacent <= HIGH_SURROGATE_END
        : adjacent >= LOW_SURROGATE_START && adjacent <= LOW_SURROGATE_END;
      if (paired) {
        codeUnits = 2;
        codePointBytes = 4;
      }
    }
    // 沿用 <=：正小数不取整，NaN 也自然保留旧实现的空结果。
    if (!(bytes + codePointBytes <= maxBytes)) break;
    bytes += codePointBytes;
    cursor += fromTail ? -codeUnits : codeUnits;
  }
  return fromTail ? value.slice(cursor) : value.slice(0, cursor);
}
