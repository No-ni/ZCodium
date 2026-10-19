// 修改前的纯函数，仅作兼容性与性能对照；不要与生产实现同步修改。
type AssistantTextRange = readonly [start: number, end: number];

function mergeRanges(ranges: AssistantTextRange[]): AssistantTextRange[] {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1]) {
      previous[1] = Math.max(previous[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

export function referenceMarkdownCodeRanges(content: string): AssistantTextRange[] {
  const ranges: Array<[number, number]> = [];
  const fencedRanges: Array<[number, number]> = [];
  let fence: { character: "`" | "~"; length: number; start: number } | null = null;
  let lineStart = 0;
  // CommonMark 支持 LF/CRLF/CR；单次顺序扫描保留原始下标，避免把 CR 后的代码引用当正文。
  const lines = /\r\n|\r|\n/gu;

  while (lineStart < content.length) {
    const newline = lines.exec(content);
    const lineEnd = newline ? lines.lastIndex : content.length;
    const line = content.slice(lineStart, newline?.index ?? content.length);
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    const marker = match?.[1];
    if (marker) {
      if (!fence) {
        if (marker[0] === "`" && match?.[2]?.includes("`")) {
          lineStart = lineEnd;
          continue;
        }
        fence = {
          character: marker[0] as "`" | "~",
          length: marker.length,
          start: lineStart,
        };
      } else if (
        marker[0] === fence.character &&
        marker.length >= fence.length &&
        /^[ \t]*$/u.test(match?.[2] ?? "")
      ) {
        // CommonMark 关闭围栏只能带空白；把 ```后缀 当作关闭会让代码里的引用示例被改写。
        fencedRanges.push([fence.start, lineEnd]);
        fence = null;
      }
    }
    lineStart = lineEnd;
  }
  if (fence) fencedRanges.push([fence.start, content.length]);
  ranges.push(...fencedRanges);

  for (const match of content.matchAll(/<(code|pre)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi)) {
    const start = match.index ?? 0;
    ranges.push([start, start + (match[0]?.length ?? 0)]);
  }

  const isFenced = (index: number) =>
    fencedRanges.some(([start, end]) => index >= start && index < end);
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "`" || isFenced(index)) continue;
    let markerLength = 1;
    while (content[index + markerLength] === "`") markerLength += 1;
    const marker = "`".repeat(markerLength);
    const closingIndex = content.indexOf(marker, index + markerLength);
    if (closingIndex < 0 || isFenced(closingIndex)) {
      index += markerLength - 1;
      continue;
    }
    ranges.push([index, closingIndex + markerLength]);
    index = closingIndex + markerLength - 1;
  }

  return mergeRanges(ranges);
}
