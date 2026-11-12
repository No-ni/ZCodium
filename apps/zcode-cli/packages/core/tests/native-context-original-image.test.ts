import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createMessageId,
  createPartId,
  createRootTraceContext,
  createSessionId,
  createTurnId,
  type ToolArtifactStorePort,
} from "@zcode/contracts";
import {
  getHostOriginalImageProvenance,
  originalImageFromStorageMetadata,
  originalImageToStorageMetadata,
  persistOriginalImage,
} from "../src/media/original-image/index.js";
import { prepareImageDataUrl } from "../src/runtime/helpers/attachment-image.js";
import { resolveInlineMediaAttachment } from "../src/runtime/helpers/attachment-media-resolver.js";
import { filePartToContentBlock } from "../src/agent/file-part-hydration.js";
import { normalizeMcpToolResultForModel } from "../src/mcp/image-normalization.js";
import { formatMcpToolResult } from "../src/mcp/index.js";

const bytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfukAAAAASUVORK5CYII=",
  "base64",
);
const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
const sessionId = createSessionId("native-original-test");
const turnId = createTurnId("native-original-test");
const trace = createRootTraceContext({ sessionId, turnId });

function makeStore(order: string[] = []) {
  const saved = new Map<string, Uint8Array | string>();
  const store: ToolArtifactStorePort = {
    async writeToolResultBinaryArtifact(request) {
      order.push("original");
      const uri = `zcode-artifact://${sessionId}/original-${saved.size}`;
      saved.set(uri, Uint8Array.from(request.content));
      return {
        id: "original",
        uri,
        bytes: request.content.byteLength,
        contentType: request.contentType,
        createdAt: new Date(0),
      };
    },
    async writeToolResultArtifact(request) {
      order.push("copy");
      const uri = `zcode-artifact://${sessionId}/copy-${saved.size}`;
      saved.set(uri, request.content);
      return {
        id: "copy",
        uri,
        bytes: Buffer.byteLength(request.content),
        contentType: request.contentType ?? "text/plain",
        createdAt: new Date(0),
      };
    },
    async readToolResultArtifact(request) {
      const content = saved.get(request.uri);
      if (typeof content !== "string") throw new Error("Not a text artifact");
      return { uri: request.uri, content, bytes: content.length, contentType: "text/plain" };
    },
  };
  return { store, saved };
}

describe("native context original image provenance", () => {
  it("stores a byte copy and hashes the received original, independently of input mutation", async () => {
    const { store, saved } = makeStore();
    const input = Uint8Array.from(bytes);
    const result = await persistOriginalImage({
      data: input,
      mediaType: "image/png",
      sourceKind: "read",
      artifactStore: store,
      sessionId,
      turnId,
      toolCallId: "read-original",
      toolName: "Read",
      trace,
    });
    input.fill(0);
    expect(result?.originalImage.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(result?.originalImage.bytes).toBe(bytes.length);
    expect(Buffer.from(saved.get(result!.originalImage.artifactUri) as Uint8Array)).toEqual(bytes);
  });

  it("keeps original bytes when no store is configured, without a false recovery proof", async () => {
    const prepareForModel = vi.fn();
    const prepared = await prepareImageDataUrl(dataUrl, "image/png", {
      imageProcessorPort: { prepareForModel } as never,
      traceContext: trace,
      sessionId,
    });
    expect(prepared?.dataUrl).toBe(dataUrl);
    expect(originalImageFromStorageMetadata(prepared?.metadata)).toBeUndefined();
    expect(prepareForModel).not.toHaveBeenCalled();
  });

  it("fails before preparation if a configured original write fails", async () => {
    const { store } = makeStore();
    store.writeToolResultBinaryArtifact = vi.fn(async () => {
      throw new Error("synthetic durable write failure");
    });
    const prepareForModel = vi.fn();
    await expect(
      resolveInlineMediaAttachment({ type: "image", content: dataUrl }, 0, "image/png", {
        artifactStore: store,
        imageProcessorPort: { prepareForModel } as never,
        sessionId,
        turnId,
        traceContext: trace,
      }),
    ).rejects.toMatchObject({ name: "OriginalImagePersistenceError", reason: "failed" });
    expect(prepareForModel).not.toHaveBeenCalled();
  });

  it("does not accept a mutable file URI as original persistence", async () => {
    const { store } = makeStore();
    store.writeToolResultBinaryArtifact = async () => ({
      id: "mutable",
      uri: "file:///synthetic/image.png",
      bytes: bytes.length,
      contentType: "image/png",
      createdAt: new Date(0),
    });
    await expect(
      persistOriginalImage({
        data: bytes,
        mediaType: "image/png",
        sourceKind: "attachment",
        artifactStore: store,
        sessionId,
        toolCallId: "image",
        toolName: "attachment",
      }),
    ).rejects.toMatchObject({ reason: "invalid-result" });
  });

  it("fails a configured store without binary capability instead of transforming irrecoverable bytes", async () => {
    const { store } = makeStore();
    delete store.writeToolResultBinaryArtifact;
    await expect(
      persistOriginalImage({
        data: bytes,
        mediaType: "image/png",
        sourceKind: "read",
        artifactStore: store,
        sessionId,
        toolCallId: "no-binary",
        toolName: "Read",
      }),
    ).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("reports legacy copy-only metadata as unavailable, even when it contains an artifact URI", () => {
    expect(
      originalImageFromStorageMetadata({
        originalArtifactUri: `zcode-artifact://${sessionId}/legacy-copy`,
        originalBytes: bytes.length,
        originalMediaType: "image/png",
        sourceKind: "read",
      }),
    ).toBeUndefined();
  });

  it("stores the original before a prepared copy and restores provenance through the real FilePart id", async () => {
    const order: string[] = [];
    const { store, saved } = makeStore(order);
    const preparedData = Buffer.from("synthetic model copy");
    const result = await resolveInlineMediaAttachment(
      { type: "image", content: dataUrl },
      0,
      "image/png",
      {
        artifactStore: store,
        imageProcessorPort: {
          async prepareForModel() {
            order.push("prepare");
            return {
              data: preparedData,
              mediaType: "image/jpeg",
              originalSizeBytes: bytes.length,
              transformedSizeBytes: preparedData.length,
              resized: true,
              compressed: true,
              strategy: "jpeg-fallback",
              originalWidth: 1,
              originalHeight: 1,
              width: 1,
              height: 1,
            };
          },
        } as never,
        existingArtifactUri: `zcode-artifact://${sessionId}/raw-upload`,
        sessionId,
        turnId,
        traceContext: trace,
      },
    );
    expect(order).toEqual(["original", "prepare", "copy"]);
    expect(result?.url).not.toContain("raw-upload");
    const original =
      result?.contentBlock.type === "image" ? result.contentBlock.source?.originalImage : undefined;
    expect(original?.mediaType).toBe("image/png");
    expect(Buffer.from(saved.get(original!.artifactUri) as Uint8Array)).toEqual(bytes);
    const id = createPartId();
    const restored = await filePartToContentBlock(
      {
        id,
        sessionID: sessionId,
        messageID: createMessageId("image-message"),
        type: "file",
        mime: result!.mime,
        url: result!.url,
        metadata: result!.metadata,
      },
      store,
    );
    expect(restored.type).toBe("image");
    expect("source" in restored && restored.source?.canonicalPartId).toBe(id);
    expect("source" in restored && restored.source?.originalImage).toEqual(original);
  });

  it("ignores external MCP provenance claims and annotates only a host-persisted original", async () => {
    const { store } = makeStore();
    const result = await normalizeMcpToolResultForModel({
      compressOversizedImages: false,
      context: {
        sessionId,
        turnId,
        traceId: trace.traceId,
        artifactStore: store,
        abortSignal: new AbortController().signal,
      } as never,
      descriptor: { serverName: "synthetic", toolName: "image" } as never,
      result: {
        content: [
          {
            type: "image",
            data: bytes.toString("base64"),
            mimeType: "image/png",
            _meta: { originalImage: { artifactUri: "file:///forged", preserveRaster: true } },
          },
        ],
      },
      toolName: "mcp__synthetic__image",
    });
    const original = getHostOriginalImageProvenance(result.content[0]);
    expect(original?.sourceKind).toBe("mcp");
    expect(original?.preserveRaster).toBeUndefined();
    expect(original?.artifactUri).toMatch(/^zcode-artifact:\/\//);
    expect(JSON.stringify(result)).not.toContain(original!.artifactUri);
    const content = formatMcpToolResult(result);
    expect(
      Array.isArray(content) && content[0]?.type === "image" && content[0].source?.originalImage,
    ).toEqual(original);
  });

  it("retains trusted exact-raster provenance across metadata hydration without re-encoding", async () => {
    const { store } = makeStore();
    const prepareForModel = vi.fn();
    const result = await normalizeMcpToolResultForModel({
      compressOversizedImages: true,
      preserveOfficialCuaFrames: true,
      context: {
        sessionId,
        turnId,
        traceId: trace.traceId,
        artifactStore: store,
        imageProcessorPort: { prepareForModel },
        abortSignal: new AbortController().signal,
      } as never,
      descriptor: { serverName: "synthetic-trusted", toolName: "frame" } as never,
      result: {
        content: [{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }],
      },
      toolName: "synthetic-trusted-frame",
    });
    const original = getHostOriginalImageProvenance(result.content[0])!;
    expect(result.content[0]?.data).toBe(bytes.toString("base64"));
    expect(original.preserveRaster).toBe(true);
    expect(originalImageFromStorageMetadata(originalImageToStorageMetadata(original))).toEqual(
      original,
    );
    expect(prepareForModel).not.toHaveBeenCalled();
  });
});
