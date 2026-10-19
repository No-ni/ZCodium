import { bench, describe, expect } from "vitest";
import { findMarkdownCodeRanges } from "@/lib/assistantDirectiveParser.js";
import { referenceMarkdownCodeRanges } from "./performanceRound26MarkdownCodeRanges.reference.js";

function longAnswer(fences: number): string {
  return Array.from(
    { length: fences },
    (_, index) =>
      `正文 ${index}：\`inline\`\n\`\`\`ts\n${"const text = `value`;\n".repeat(12)}\`\`\`\n`,
  ).join("\n");
}

for (const [label, text] of [
  ["short prose", "这是一段普通回答，没有代码围栏。".repeat(8)],
  ["240 fences", longAnswer(240)],
  ["2000 fences stress", longAnswer(2000)],
] as const) {
  describe(`${label} (${text.length} UTF-16 units)`, () => {
    expect(findMarkdownCodeRanges(text)).toEqual(referenceMarkdownCodeRanges(text));
    bench(
      "reference",
      () => {
        referenceMarkdownCodeRanges(text);
      },
      { time: 500 },
    );
    bench(
      "current",
      () => {
        findMarkdownCodeRanges(text);
      },
      { time: 500 },
    );
  });
}
