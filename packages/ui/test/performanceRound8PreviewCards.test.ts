import { describe, expect, it } from "vitest";
import {
  buildAssistantPreviewCardsFromReferences,
  extractAssistantFileReferences,
  type AssistantFileReference,
} from "@/lib/assistantPreviewCards.js";

function reference(path: string, raw = path, start = 0): AssistantFileReference {
  return {
    path,
    raw,
    start,
    end: start + raw.length,
    kind: /\.html?$/.test(path) ? "html" : path.endsWith(".md") ? "markdown" : "pdf",
  };
}

function cards(paths: readonly string[], references: readonly AssistantFileReference[]) {
  return buildAssistantPreviewCardsFromReferences("Generated files", "/work", references, {
    changedFilePaths: paths,
  });
}

function countedPaths(paths: string[]) {
  let reads = 0;
  const source = Object.freeze(paths);
  return {
    paths: new Proxy(source, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key, receiver);
      },
    }),
    reads: () => reads,
  };
}

describe("preview cards changed-path lookup work", () => {
  it("reads each changed path at most twice across 32 references and shared projection", () => {
    const source = countedPaths(
      Array.from({ length: 512 }, (_, index) => `/work/file-${index}.md`),
    );
    const references = Object.freeze(
      Array.from({ length: 32 }, (_, index) =>
        Object.freeze(reference(`/work/file-${index}.md`, undefined, index)),
      ),
    );
    const result = cards(source.paths, references);
    expect(result).toHaveLength(15);
    expect(result.map((card) => "path" in card && card.path)).toEqual(
      Array.from({ length: 15 }, (_, index) => `/work/file-${31 - index}.md`),
    );
    expect(source.reads()).toBeLessThanOrEqual(1_024);
  });

  it("does not build the matcher for PDF-only or suppressed HTML references", () => {
    const source = countedPaths(["/work/report.md", "/work/index.html"]);
    expect(cards(source.paths, [reference("/work/report.pdf")])).toHaveLength(1);
    // 共享候选投影仍保留原本的 fileChanges 读取，只有匹配索引必须惰性建立。
    expect(source.reads()).toBe(2);
    const suppressed = countedPaths(["/work/index.html"]);
    expect(
      buildAssistantPreviewCardsFromReferences(
        "http://localhost:3000/index.html",
        "/work",
        [reference("/work/index.html")],
        { changedFilePaths: suppressed.paths, suppressWebRemoteCards: true },
      ),
    ).toEqual([]);
    expect(suppressed.reads()).toBe(1);
  });

  it("shares one index between localhost HTML URLs and Markdown references", () => {
    const source = countedPaths(
      Array.from({ length: 512 }, (_, index) =>
        index < 256 ? `/work/file-${index}.md` : `/work/page-${index - 256}.html`,
      ),
    );
    const content = Array.from(
      { length: 8 },
      (_, index) => `http://localhost:3000/page-${index}.html`,
    ).join(" ");
    const references = Array.from({ length: 8 }, (_, index) =>
      reference(`/work/file-${index}.md`, undefined, index),
    );
    const result = buildAssistantPreviewCardsFromReferences(content, "/work", references, {
      changedFilePaths: source.paths,
    });
    expect(result).toHaveLength(15);
    expect(
      result.some((card) => card.type === "website" && card.filePath === "/work/page-7.html"),
    ).toBe(true);
    expect(result.some((card) => card.type === "markdown")).toBe(true);
    expect(source.reads()).toBeLessThanOrEqual(1_024);
  });
});

describe("preview cards changed-path compatibility", () => {
  it("keeps first exact path and counts duplicate leaf entries as ambiguous", () => {
    expect(
      cards(["/work/docs//report.md", "/work/docs/report.md"], [reference("/work/docs/report.md")]),
    ).toMatchObject([{ path: "/work/docs//report.md" }]);
    expect(
      cards(["/work/docs/report.md"], [reference("/work/report.md", "report.md")]),
    ).toMatchObject([{ path: "/work/docs/report.md" }]);
    expect(
      cards(
        ["/work/docs/report.md", "/work/docs/report.md"],
        [reference("/work/report.md", "report.md")],
      ),
    ).toEqual([]);
    expect(
      cards(["/work/docs/report.md"], [reference("/work/other/report.md", "other/report.md")]),
    ).toEqual([]);
    expect(cards(["/work/docs/report.md"], [reference("/work/REPORT.md", "REPORT.md")])).toEqual(
      [],
    );
  });

  it("rebuilds from new inputs without changing frozen references", () => {
    const references = Object.freeze([Object.freeze(reference("/work/report.md", "report.md"))]);
    expect(cards(Object.freeze(["/work/old/report.md"]), references)).toMatchObject([
      { path: "/work/old/report.md" },
    ]);
    expect(cards(Object.freeze(["/work/new/report.md"]), references)).toMatchObject([
      { path: "/work/new/report.md" },
    ]);
    expect(cards(Object.freeze([]), references)).toEqual([]);
    expect(references[0]?.path).toBe("/work/report.md");
  });

  it("matches complete pre-change outputs for supported path and card combinations", () => {
    const cases = [
      {
        root: "/work",
        content: "[Report](report.md) [Other](nested/other.md) report.pdf",
        paths: ["docs/report.md", "nested/other.md"],
      },
      {
        root: "/work",
        content: "[Report](report.md) [Other](nested/other.md)",
        paths: ["docs/report.md", "more/report.md", "nested/other.md"],
      },
      {
        root: "C:\\work",
        content: "[Report](docs/report.md) [PDF](report.pdf)",
        paths: ["C:\\work\\docs\\report.md"],
      },
      {
        root: "/work",
        content: "[Preview](http://localhost:3000/site/index.html) [HTML](site/index.html)",
        paths: ["site/index.html"],
      },
      {
        root: "/work",
        content: "[Preview](http://localhost:3000/site/index.html) [HTML](site/index.html)",
        paths: [],
      },
      {
        root: "/work",
        content: "http://localhost:3000/ http://localhost:3000/ [HTML](site/index.html) report.pdf",
        paths: ["site/index.html"],
      },
      {
        root: "/work",
        content: "[HTML](site/index.html) [Report](report.md) [PDF](report.pdf)",
        paths: ["site/index.html", "docs/report.md"],
        suppressWebRemoteCards: true,
      },
      {
        root: "/work",
        content: "[Home](~/report.md) [File](file:///work/local.md)",
        paths: ["/home/user/report.md", "/work/local.md"],
        homePath: "/home/user",
      },
      {
        root: "/work",
        content: Array.from({ length: 20 }, (_, index) => `[${index}](file-${index}.md)`).join(" "),
        paths: Array.from({ length: 20 }, (_, index) => `file-${index}.md`),
      },
      {
        root: "/work",
        content: "[First](report.md) [Duplicate](report.md) [HTML](site/index.html)",
        paths: ["report.md", "site/index.html"],
      },
    ];
    const outputs = cases.map(({ root, content, paths, homePath, suppressWebRemoteCards }) => {
      const references = Object.freeze(
        extractAssistantFileReferences(content, root, { homePath }).map((entry) =>
          Object.freeze(entry),
        ),
      );
      return buildAssistantPreviewCardsFromReferences(content, root, references, {
        changedFilePaths: Object.freeze(paths),
        homePath,
        suppressWebRemoteCards,
      });
    });
    expect(outputs).toMatchSnapshot();
  });
});
