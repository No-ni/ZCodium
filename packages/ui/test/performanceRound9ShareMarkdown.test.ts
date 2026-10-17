import { describe, expect, it } from "vitest";
import { normalizeConversationShareMarkdown } from "@/v4/conversationShareMarkdown.js";

class CountedNames extends Map<string, string> {
  reads = 0;
  override values(): MapIterator<string> {
    const iterator = super.values();
    const next = iterator.next.bind(iterator);
    iterator.next = () => {
      const result = next();
      if (!result.done) this.reads += 1;
      return result;
    };
    return iterator;
  }
}

const citation = (path: string) => `::zcode-file-citation{path=${JSON.stringify(path)}}`;

describe("share Markdown artifact-name lookup", () => {
  it("reads artifact names once across multiple citations", () => {
    const names = new CountedNames(
      Array.from({ length: 256 }, (_, index) => [`artifact-${index}`, `report-${index}.pdf`]),
    );
    const markdown = Array.from({ length: 32 }, (_, index) =>
      citation(`/work/report-${index}.pdf`),
    ).join("\n");
    const expected = Array.from({ length: 32 }, (_, index) => `report-${index}.pdf`).join("\n");
    expect(normalizeConversationShareMarkdown(markdown, names)).toBe(expected);
    expect(names.reads).toBeLessThanOrEqual(256);
  });

  it("does not inspect names when citations are absent or code-protected", () => {
    const names = new CountedNames([["a", "report.pdf"]]);
    expect(normalizeConversationShareMarkdown("No citation", names)).toBe("No citation");
    const code = `\`\`\`md\n${citation("/work/report.pdf")}\n\`\`\``;
    expect(normalizeConversationShareMarkdown(code, names)).toBe(code);
    expect(names.reads).toBe(0);
  });

  it("preserves complete pre-change results for citation and image combinations", () => {
    const names = new Map([
      ["a", "  Report.PDF "],
      ["b", "duplicate.pdf"],
      ["c", "DUPLICATE.pdf"],
      ["d", "identical.pdf"],
      ["e", "identical.pdf"],
      ["f", "图表.pdf"],
      ["g", ""],
    ]);
    const cases = [
      `Before ${citation("/work/report.pdf")} after ${citation("C:\\work\\图表.pdf")}`,
      `${citation("duplicate.pdf")} ${citation("identical.pdf")} ${citation("unknown.pdf")}`,
      `::zcode-file-citation{purpose="no path"} ${citation("")}`,
      `\`${citation("report.pdf")}\`\n${citation("REPORT.pdf")}`,
      `\`\`\`md\n${citation("report.pdf")}\n![protected](https://example.com/a.png)\n\`\`\`\n${citation("report.pdf")}`,
      `${citation("report.pdf")} ![remote](https://example.com/a.png "title") ![protocol](//example.com/b.png) ![local](a.png) ![data](data:image/png;base64,AA)`,
      `${citation("  /work/report.pdf ")} ${citation("report.pdf")} ${citation("report.pdf")}`,
      `${citation("unknown.pdf")}\n\`\`\`\n![unchanged](https://example.com/x.png)\n\`\`\``,
    ];
    expect(
      cases.map((markdown) => normalizeConversationShareMarkdown(markdown, names)),
    ).toMatchSnapshot();
    expect([...names.values()]).toEqual([
      "  Report.PDF ",
      "duplicate.pdf",
      "DUPLICATE.pdf",
      "identical.pdf",
      "identical.pdf",
      "图表.pdf",
      "",
    ]);
  });

  it("rebuilds the unique-name lookup for replacement Map entries", () => {
    const names = new Map([["a", "report.pdf"]]);
    const markdown = citation("/work/report.pdf");
    expect(normalizeConversationShareMarkdown(markdown, names)).toBe("report.pdf");
    names.set("b", "REPORT.pdf");
    expect(normalizeConversationShareMarkdown(markdown, names)).toBe("");
    names.delete("a");
    expect(normalizeConversationShareMarkdown(markdown, names)).toBe("REPORT.pdf");
  });
});
