/** 原图引用属于 canonical FilePart，不能从压缩内核或摘要扩展附件归属。 */
export function readFilePartOriginalImageArtifactUri(data: string): string | null {
  try {
    const part: unknown = JSON.parse(data);
    if (!part || typeof part !== "object" || Array.isArray(part)) return null;
    const file = part as Record<string, unknown>;
    if (file.type !== "file") return null;
    const metadata = file.metadata as { image?: { originalArtifactUri?: unknown } } | undefined;
    const uri = metadata?.image?.originalArtifactUri;
    return typeof uri === "string" && uri.startsWith("zcode-artifact://") ? uri : null;
  } catch {
    // 历史 JSON 的斜杠转义必须先解码；畸形 metadata 仍交由既有 URI 扫描处理。
    return null;
  }
}
