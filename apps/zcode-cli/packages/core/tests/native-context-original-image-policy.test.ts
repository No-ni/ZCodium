import { describe, expect, it, vi } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  createTurnId,
  type ToolArtifactStorePort,
} from "@zcode/contracts";
import { createRecommendedNativeContextParameters } from "@zcode/shared/native-context-compression";
import { resolveTurnAttachments } from "../src/runtime/helpers/attachments.js";
import { readImageFile } from "../src/tool/handlers/read-image.js";
import type { ToolExecutionContext } from "../src/tool/types.js";
import { normalizeMcpToolResultForModel } from "../src/mcp/image-normalization.js";
import { getHostOriginalImageProvenance } from "../src/media/original-image/index.js";

const bytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfukAAAAASUVORK5CYII=",
  "base64",
);
const sessionId = createSessionId("native-original-policy-test");
const turnId = createTurnId("native-original-policy-test");
const trace = createRootTraceContext({ sessionId, turnId });
const images = createRecommendedNativeContextParameters().images;

function fixture(content = bytes) {
  const originals: Buffer[] = [];
  const prepareForModel = vi.fn();
  const artifactStore = {
    async writeToolResultBinaryArtifact(request) {
      originals.push(Buffer.from(request.content));
      return {
        id: "original",
        uri: `zcode-artifact://${sessionId}/original-${originals.length}`,
        bytes: request.content.byteLength,
        contentType: request.contentType,
        createdAt: new Date(0),
      };
    },
    async writeToolResultArtifact(request) {
      return {
        id: "canonical",
        uri: `zcode-artifact://${sessionId}/canonical`,
        bytes: Buffer.byteLength(request.content),
        contentType: request.contentType ?? "text/plain",
        createdAt: new Date(0),
      };
    },
  } as ToolArtifactStorePort;
  const context = {
    toolCallId: "original-policy",
    sessionId,
    turnId,
    traceId: trace.traceId,
    abortSignal: new AbortController().signal,
    artifactStore,
    imageProcessorPort: { prepareForModel },
    nativeContextCompression: { getImagePolicy: () => images },
    fileSystemPort: {
      async readBinaryFile() {
        return { content, sizeBytes: content.byteLength };
      },
    },
  } as unknown as ToolExecutionContext;
  return { originals, prepareForModel, artifactStore, context };
}

describe("native original image canonical admission", () => {
  it("retains raw attachment content through the full resolver instead of applying the old resize policy", async () => {
    const { originals, prepareForModel, artifactStore } = fixture();
    const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
    const result = await resolveTurnAttachments([{ type: "image", content: dataUrl }], {
      sessionId,
      turnId,
      artifactStore,
      nativeContextImages: images,
      imageProcessorPort: { prepareForModel } as never,
      traceContext: trace,
      workingDirectory: "/synthetic-workspace",
    });
    expect(originals).toEqual([bytes]);
    expect(result[0]?.contentBlock).toMatchObject({
      type: "image",
      dataUrl,
      source: { originalImage: { bytes: bytes.length, mediaType: "image/png" } },
    });
    expect(prepareForModel).not.toHaveBeenCalled();
  });

  it("persists and returns raw Read bytes when the final projection owns the image policy", async () => {
    const { context, originals, prepareForModel } = fixture();
    const result = await readImageFile("/synthetic-workspace/image.png", "image/png", context);
    expect(result.base64).toBe(bytes.toString("base64"));
    expect(result.originalImage).toMatchObject({
      bytes: bytes.length,
      mediaType: "image/png",
      sourceKind: "read",
    });
    expect(originals).toEqual([bytes]);
    expect(prepareForModel).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "retains oversized MCP image identity before final budgeting (legacy host compression=%s)",
    async (compressOversizedImages) => {
      // 此场景只校验原 bytes 的持久化与归属，故意不用图像解码器消费合成负载。
      const raw = Buffer.alloc(180 * 1024, 0x42);
      const { context, originals, prepareForModel } = fixture(raw);
      const data = raw.toString("base64");
      const result = await normalizeMcpToolResultForModel({
        compressOversizedImages,
        context,
        descriptor: { serverName: "synthetic", toolName: "image" } as never,
        result: { content: [{ type: "image", data, mimeType: "image/png" }] },
        toolName: "mcp__synthetic__image",
      });
      expect(result.content[0]).toMatchObject({ type: "image", data });
      expect(originals).toEqual([raw]);
      expect(getHostOriginalImageProvenance(result.content[0])).toMatchObject({
        bytes: raw.length,
        sourceKind: "mcp",
      });
      expect(prepareForModel).not.toHaveBeenCalled();
    },
  );

  it("keeps raw oversized MCP bytes without claiming a retrievable original when there is no store", async () => {
    const { context, prepareForModel } = fixture();
    delete context.artifactStore;
    const data = Buffer.alloc(180 * 1024, 0x42).toString("base64");
    const result = await normalizeMcpToolResultForModel({
      compressOversizedImages: false,
      context,
      descriptor: { serverName: "synthetic", toolName: "image" } as never,
      result: { content: [{ type: "image", data, mimeType: "image/png" }] },
      toolName: "mcp__synthetic__image",
    });
    expect(result.content[0]).toMatchObject({ type: "image", data });
    expect(getHostOriginalImageProvenance(result.content[0])).toBeUndefined();
    expect(prepareForModel).not.toHaveBeenCalled();
  });
});
