const ARTIFACT_IMAGE_RENDER_PREFIX = "/__zcode_artifact_image__/";
// Windows 行尾保留在 split 后的行中；忽略末尾 CR 才能识别围栏，避免改写代码示例。
const FENCE_PATTERN = /^( {0,3})(`{3,}|~{3,})(.*)\r?$/u;
const ARTIFACT_IMAGE_PATTERN =
  /(!\[[^\]\n]*\]\(\s*(?:<)?)(zcode-artifact:\/\/[^\s)>]+)(?:>)?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/gu;

function mapOutsideMarkdownFences(markdown: string, transform: (line: string) => string): string {
  let activeMarker: "`" | "~" | null = null;
  let activeLength = 0;
  return markdown
    .split("\n")
    .map((line) => {
      const fence = line.match(FENCE_PATTERN);
      if (fence?.[2]) {
        const run = fence[2];
        const marker = run[0] as "`" | "~";
        const suffix = fence[3] ?? "";
        if (activeMarker === marker && run.length >= activeLength && suffix.trim() === "") {
          activeMarker = null;
          activeLength = 0;
        } else if (!activeMarker && (marker === "~" || !suffix.includes("`"))) {
          activeMarker = marker;
          activeLength = run.length;
        }
        return line;
      }
      return activeMarker ? line : transform(line);
    })
    .join("\n");
}

export function extractMarkdownArtifactImageRefs(markdown: string): string[] {
  if (!markdown.includes("zcode-artifact://")) return [];
  const refs = new Set<string>();
  mapOutsideMarkdownFences(markdown, (line) => {
    for (const match of line.matchAll(ARTIFACT_IMAGE_PATTERN)) {
      if (match[2]) refs.add(match[2]);
    }
    return line;
  });
  return [...refs];
}

export function rewriteMarkdownArtifactImageSources(markdown: string): string {
  // 流式普通正文不含 artifact 时跳过逐行数组分配；有引用仍沿用相同的围栏扫描。
  if (!markdown.includes("zcode-artifact://")) return markdown;
  return mapOutsideMarkdownFences(markdown, (line) =>
    line.replace(
      ARTIFACT_IMAGE_PATTERN,
      (image, prefix: string, ref: string) =>
        // alt 可能包含相同 ref，必须按目标捕获位置替换，不能对整个图片文本再次搜索。
        `${prefix}${ARTIFACT_IMAGE_RENDER_PREFIX}${encodeURIComponent(ref)}${image.slice(prefix.length + ref.length)}`,
    ),
  );
}

export function decodeMarkdownArtifactImageSource(source: string): string | null {
  if (!source.startsWith(ARTIFACT_IMAGE_RENDER_PREFIX)) return null;
  try {
    const ref = decodeURIComponent(source.slice(ARTIFACT_IMAGE_RENDER_PREFIX.length));
    return ref.startsWith("zcode-artifact://") ? ref : null;
  } catch {
    return null;
  }
}
