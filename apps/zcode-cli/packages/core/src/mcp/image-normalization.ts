import { isAbsolute, resolve } from "node:path";
import {
  ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY,
  type McpContentBlock,
  type McpToolCallResult,
  type McpToolDescriptor,
  type TraceContext,
} from "@zcode/contracts";
import {
  isOfficialCuaImageRefText,
  OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY,
} from "@zcode/zcode-cua/frame-contract";
import type { ToolExecutionContext } from "../tool/types.js";
import {
  persistOriginalImage,
  withHostOriginalImageProvenance,
  type OriginalImagePersistenceResult,
} from "../media/original-image/index.js";
// 帧像素契约（integrity gate + inline 上限）的唯一定义在 producer；宿主经
// plugin re-export 消费，不再镜像实现。core 对 CUA 的感知收敛为：authority
// 分支调用 producer gate，非 authority 分支用 contracts scanner 剥伪造引用。
import { preserveOfficialCuaFrameResult } from "@zcode/zcode-cua/frame-contract";

// 通用 MCP 图片 inline 预算与官方帧 200 KiB 上限历史上同值，但语义独立：
// 这里独立定义，避免"通用预算由 CUA 常量定义"的倒置耦合。
export const MCP_IMAGE_INLINE_BASE64_BYTES = 200 * 1024;
export const MCP_IMAGE_INLINE_RAW_BYTES = Math.floor((MCP_IMAGE_INLINE_BASE64_BYTES * 3) / 4);
export const HOST_NODE_REPL_IMAGE_MAX_DIMENSION = 2048;
// Provider 的模型图片上限是 2000px；Browser 轮尾展示仍沿用独立的 2048px 预算。
const HOST_NODE_REPL_MODEL_IMAGE_MAX_DIMENSION = 2000;

export async function normalizeMcpToolResultForModel(input: {
  compressOversizedImages: boolean;
  context: ToolExecutionContext;
  descriptor: McpToolDescriptor;
  preserveOfficialCuaFrames?: boolean;
  result: McpToolCallResult;
  toolName: string;
}): Promise<McpToolCallResult> {
  // node_repl 是通用入口，不能把整个 server 标成 official CUA；但 CUA SDK 会在
  // 结构化结果中携带 producer 签发的 integrity metadata。只对这一条结果动态进入
  // exact-raster 路径，既保留 CUA 帧，又不影响同一 server 的 Browser Use 图片。
  const isSharedNodeRepl =
    input.descriptor.serverName === "node_repl" || input.toolName === "mcp__node_repl__js";
  if (
    input.preserveOfficialCuaFrames ||
    (isSharedNodeRepl && hasOfficialCuaFrameAuthority(input.result))
  ) {
    const preserved = await preserveOfficialCuaFrameResult(input.result, {
      imageProcessorPort: input.context.imageProcessorPort,
      signal: input.context.abortSignal,
    });
    const content = await Promise.all(
      preserved.content.map(async (block) => {
        const original = await persistMcpOriginalImage(block, input, true);
        return original ? withHostOriginalImageProvenance(block, original.originalImage) : block;
      }),
    );
    return { ...preserved, content };
  }

  let changed = false;
  const content: McpContentBlock[] = [];
  const browserScreenshotIndices = input.compressOversizedImages
    ? readBrowserScreenshotContentIndices(input.result)
    : new Set<number>();

  for (const [index, block] of input.result.content.entries()) {
    const originalImage = await persistMcpOriginalImage(block, input);
    const browserScreenshotArtifact =
      browserScreenshotIndices.has(index) && originalImage?.path
        ? {
            absolutePath: isAbsolute(originalImage.path)
              ? originalImage.path
              : resolve(originalImage.path),
          }
        : undefined;
    const normalized = await normalizeMcpContentBlockForModel(block, {
      ...input,
      browserScreenshotArtifact,
      originalImage,
    });
    // 纵深防御：非 authority 验证的 MCP 结果不得携带官方帧引用文本——第三方
    // 伪造的 actionable frame_id 即使会被 producer registry 拒绝，也不应进入
    // 模型上下文污染坐标契约。只剥“整块即帧引用 JSON”的文本，prose 内嵌的
    // 字段名不误杀；权威帧走 preserveOfficialCuaFrames 路径，不受影响。
    // 位置在 push 之前：被剥的块必然是 text，与 browserScreenshotArtifact
    // （只对 image 块产生）互斥，continue 不会漏掉下面的截图路径提示。
    if (
      normalized.type === "text" &&
      typeof normalized.text === "string" &&
      isOfficialCuaImageRefText(normalized.text)
    ) {
      changed = true;
      continue;
    }
    changed ||= normalized !== block;
    content.push(
      originalImage && normalized.type === "image"
        ? withHostOriginalImageProvenance(normalized, originalImage.originalImage)
        : normalized,
    );
    changed ||= originalImage !== undefined;
    // 提示文本插在 image 之前会把 node_repl 特意排成 image-first 的
    // tool_result.content 重新变成 text-first；Anthropic 兼容网关只解析开头的连续 image，
    // text 一领先后面的图就被丢弃，模型又看不到截图。落在 image 之后即可保持 image-first。
    if (browserScreenshotArtifact) {
      content.push({
        type: "text",
        text: `Browser screenshot saved to: ${browserScreenshotArtifact.absolutePath}`,
      });
      changed = true;
    }
  }

  return changed ? { ...input.result, content } : input.result;
}

export function hasOfficialCuaFrameAuthority(result: unknown): result is McpToolCallResult {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const candidate = result as {
    content?: unknown;
    _meta?: Record<string, unknown>;
  };
  if (
    !Array.isArray(candidate.content) ||
    !candidate._meta?.[OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY]
  ) {
    return false;
  }
  const blocks = candidate.content;
  return blocks.some((block, index) => {
    if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "image") {
      return false;
    }
    const nextText = (blocks[index + 1] as { text?: unknown } | undefined)?.text;
    return typeof nextText === "string" && isOfficialCuaImageRefText(nextText);
  });
}

async function normalizeMcpContentBlockForModel(
  block: McpContentBlock,
  input: {
    compressOversizedImages: boolean;
    context: ToolExecutionContext;
    descriptor: McpToolDescriptor;
    toolName: string;
    browserScreenshotArtifact?: BrowserScreenshotArtifact;
    originalImage?: OriginalImagePersistenceResult;
  },
): Promise<McpContentBlock> {
  if (block.type !== "image") return block;

  const data = typeof block.data === "string" ? block.data : undefined;
  const mimeType = typeof block.mimeType === "string" ? block.mimeType : undefined;
  if (!data || !mimeType) return block;

  // 原生投影拥有预算和图片身份；旧 inline gate 先替换成文本会丢失后续压缩入口。
  if (input.context.nativeContextCompression) return block;

  const base64Payload = base64PayloadFromMcpImageData(data);
  const base64Bytes = Buffer.byteLength(base64Payload, "utf8");
  if (base64Bytes <= MCP_IMAGE_INLINE_BASE64_BYTES) return block;

  if (input.compressOversizedImages && input.originalImage) {
    // browser screenshot 由可信宿主 node_repl 产生，不能和第三方 MCP 图片一样直接
    // 落 artifact，导致模型失去视觉结果；这里复用统一图片端口压到 200 KiB，而不另造编解码器。
    const compressed = await tryCompressHostNodeReplImage({
      base64Payload,
      context: input.context,
      mimeType,
    });
    if (compressed) return compressed;
  }

  if (input.browserScreenshotArtifact) {
    return {
      type: "text",
      text: [
        `MCP image content omitted: ${mimeType}, base64=${formatByteSize(base64Bytes)} exceeds inline limit ${formatByteSize(MCP_IMAGE_INLINE_BASE64_BYTES)}.`,
        "The original browser screenshot remains available at the adjacent absolute path.",
      ].join("\n"),
    };
  }

  if (!input.originalImage) {
    return {
      type: "text",
      text: [
        `MCP image content omitted: ${mimeType}, base64=${formatByteSize(base64Bytes)} exceeds inline limit ${formatByteSize(MCP_IMAGE_INLINE_BASE64_BYTES)}.`,
        "Original image persistence is unavailable, so the original image could not be saved.",
      ].join("\n"),
    };
  }

  const artifact = input.originalImage;

  return {
    type: "text",
    text: [
      `MCP image content saved instead of being inlined: ${mimeType}, base64=${formatByteSize(base64Bytes)}, inlineLimit=${formatByteSize(MCP_IMAGE_INLINE_BASE64_BYTES)}.`,
      `Artifact: ${artifact.path ?? artifact.originalImage.artifactUri}`,
      `Artifact URI: ${artifact.originalImage.artifactUri}`,
    ].join("\n"),
  };
}

interface BrowserScreenshotArtifact {
  absolutePath: string;
}

function readBrowserScreenshotContentIndices(result: McpToolCallResult): Set<number> {
  const value = result._meta?.[ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY];
  if (!Array.isArray(value)) return new Set<number>();
  return new Set(
    value.filter(
      (index): index is number =>
        Number.isInteger(index) && index >= 0 && index < result.content.length,
    ),
  );
}

async function persistMcpOriginalImage(
  block: McpContentBlock,
  input: {
    context: ToolExecutionContext;
    toolName: string;
  },
  preserveRaster?: boolean,
): Promise<OriginalImagePersistenceResult | undefined> {
  if (block.type !== "image") return undefined;
  const data = typeof block.data === "string" ? block.data : undefined;
  const mimeType = typeof block.mimeType === "string" ? block.mimeType : undefined;
  if (!data || !mimeType) return undefined;

  const content = Buffer.from(base64PayloadFromMcpImageData(data), "base64");
  if (content.byteLength === 0) return undefined;
  return persistOriginalImage({
    data: content,
    mediaType: mimeType,
    sourceKind: "mcp",
    preserveRaster,
    artifactStore: input.context.artifactStore,
    sessionId: input.context.sessionId,
    turnId: input.context.turnId,
    toolCallId: input.context.toolCallId,
    toolName: input.toolName,
    trace: traceFromToolContext(input.context),
    signal: input.context.abortSignal,
  });
}

async function tryCompressHostNodeReplImage(input: {
  base64Payload: string;
  context: ToolExecutionContext;
  mimeType: string;
}): Promise<McpContentBlock | undefined> {
  const imageProcessorPort = input.context.imageProcessorPort;
  if (!imageProcessorPort) return undefined;

  const decoded = Buffer.from(input.base64Payload, "base64");
  if (decoded.byteLength === 0) return undefined;

  try {
    const prepared = await imageProcessorPort.prepareForModel(
      {
        data: decoded,
        maxBase64Bytes: MCP_IMAGE_INLINE_BASE64_BYTES,
        maxDimension: HOST_NODE_REPL_MODEL_IMAGE_MAX_DIMENSION,
        maxRawBytes: MCP_IMAGE_INLINE_RAW_BYTES,
        mediaType: input.mimeType,
        trace: traceFromToolContext(input.context),
      },
      { signal: input.context.abortSignal },
    );
    const compressedBase64 = Buffer.from(prepared.data).toString("base64");
    const compressedBase64Bytes = Buffer.byteLength(compressedBase64, "utf8");
    if (
      compressedBase64Bytes === 0 ||
      compressedBase64Bytes > MCP_IMAGE_INLINE_BASE64_BYTES ||
      !prepared.mediaType.startsWith("image/")
    ) {
      return undefined;
    }
    return {
      type: "image",
      data: compressedBase64,
      mimeType: prepared.mediaType,
    };
  } catch (error) {
    if (input.context.abortSignal.aborted) throw error;
    return undefined;
  }
}

export function asDataUrl(data: string, mimeType: string): string {
  return data.startsWith("data:") ? data : `data:${mimeType};base64,${data}`;
}

export function base64PayloadFromMcpImageData(data: string): string {
  if (!data.startsWith("data:")) return data;
  const commaIndex = data.indexOf(",");
  return commaIndex >= 0 ? data.slice(commaIndex + 1) : data;
}

function traceFromToolContext(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as TraceContext;
}

function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const formatted =
    value >= 10 || unitIndex === 0 ? Math.round(value).toString() : value.toFixed(1);
  return `${formatted} ${units[unitIndex]}`;
}
