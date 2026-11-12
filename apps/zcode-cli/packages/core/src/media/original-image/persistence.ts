import { createHash } from "node:crypto";
import {
  OriginalImagePersistenceError,
  type OriginalImagePersistenceRequest,
  type OriginalImagePersistenceResult,
} from "./contract.js";

export async function persistOriginalImage(
  request: OriginalImagePersistenceRequest,
): Promise<OriginalImagePersistenceResult | undefined> {
  request.signal?.throwIfAborted();
  if (!request.artifactStore || !request.sessionId) return undefined;
  const write = request.artifactStore.writeToolResultBinaryArtifact;
  if (!write) throw new OriginalImagePersistenceError("unavailable");

  // 输入和发送副本可能随后被原地处理；持久化只使用收到时冻结的独立字节。
  const data = Buffer.from(request.data);
  if (data.byteLength === 0 || !request.mediaType.startsWith("image/")) {
    throw new OriginalImagePersistenceError("invalid-result");
  }
  const sha256 = createHash("sha256").update(data).digest("hex");
  let artifact;
  try {
    artifact = await write.call(
      request.artifactStore,
      {
        content: data,
        contentType: request.mediaType,
        extension: imageExtension(request.mediaType),
        retention: "session",
        sessionId: request.sessionId,
        turnId: request.turnId,
        toolCallId: `${request.toolCallId}-original-image`,
        toolName: request.toolName,
        trace: request.trace,
      },
      { signal: request.signal },
    );
  } catch (error) {
    if (request.signal?.aborted) throw error;
    throw new OriginalImagePersistenceError("failed", error);
  }
  request.signal?.throwIfAborted();
  if (!artifact.uri.startsWith("zcode-artifact://") || artifact.bytes !== data.byteLength) {
    throw new OriginalImagePersistenceError("invalid-result");
  }
  return {
    originalImage: {
      artifactUri: artifact.uri,
      sha256,
      bytes: data.byteLength,
      mediaType: request.mediaType,
      sourceKind: request.sourceKind,
      ...(request.preserveRaster !== undefined ? { preserveRaster: request.preserveRaster } : {}),
    },
    ...(artifact.path ? { path: artifact.path } : {}),
  };
}

function imageExtension(mediaType: string): string {
  switch (mediaType.toLowerCase().split(";", 1)[0]) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/bmp":
      return ".bmp";
    default:
      return ".bin";
  }
}
