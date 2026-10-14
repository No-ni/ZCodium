import { describe, expect, it } from "vitest";
import { unified } from "unified";
import { defaultRehypePlugins } from "streamdown";
import { rewriteLocalFileMarkdownTargetsRehypePlugin } from "./message.js";
import { resolveMarkdownFileLink } from "@/lib/markdownFileLink.js";

async function processTarget(
  target: string,
  tagName: "a" | "img" = "a",
  options = {
    fileReferenceRootPath: "/workspace/session/docs",
    workspacePath: "/workspace",
  },
) {
  const property = tagName === "a" ? "href" : "src";
  const node = {
    type: "element" as const,
    tagName,
    properties: { [property]: target },
    children: [],
  };
  const tree = { type: "root" as const, children: [node] };
  const processor = unified().use(rewriteLocalFileMarkdownTargetsRehypePlugin, options);
  processor.use(Object.values(defaultRehypePlugins));
  await processor.run(tree);
  return node.properties[property];
}

describe("Markdown file targets through actual Streamdown hardening", () => {
  it("preserves the document parent directory and line suffix", async () => {
    const href = await processTarget("../schema.json:12");
    expect(
      resolveMarkdownFileLink("/workspace/session/docs", href ?? "", {
        workspaceRootPath: "/workspace",
      }),
    ).toEqual({ path: "/workspace/session/schema.json", lineNumber: 12, columnNumber: null });
  });

  it("preserves parent image paths and bare filenames", async () => {
    expect(await processTarget("../chart.png", "img")).toBe("/workspace/session/chart.png");
    expect(await processTarget("README.md")).toBe("/workspace/session/docs/README.md");
  });

  it("removes escaped links and image paths before harden can lose the traversal", async () => {
    expect(await processTarget("../../../outside.json")).toBeUndefined();
    expect(await processTarget("../../../outside.png", "img")).toBeUndefined();
  });

  it("keeps ordinary external links and data images unchanged", async () => {
    expect(await processTarget("https://example.com/report")).toBe("https://example.com/report");
    expect(await processTarget("data:image/png;base64,AAAA", "img")).toBe(
      "data:image/png;base64,AAAA",
    );
  });

  it.each(
    [
      {
        fileReferenceRootPath: "c:\\WORKSPACE\\session\\docs",
        workspacePath: "C:\\workspace",
        expected: "C:/workspace/session/chart.png",
      },
      {
        fileReferenceRootPath: "\\\\SERVER\\Share\\session\\docs",
        workspacePath: "\\\\server\\share",
        expected: "//server/share/session/chart.png",
      },
    ].flatMap((scope) => (["a", "img"] as const).map((tagName) => ({ ...scope, tagName }))),
  )(
    "keeps Windows $tagName targets under $workspacePath despite casing differences",
    async ({ tagName, expected, ...options }) => {
      const href = await processTarget("../chart.png", tagName, options);
      expect(
        resolveMarkdownFileLink(options.fileReferenceRootPath, href ?? "", {
          workspaceRootPath: options.workspacePath,
        })?.path,
      ).toBe(expected);
      expect(await processTarget("../../../outside.png", tagName, options)).toBeUndefined();
    },
  );

  it("decodes path escapes only once across rewriting and the final file renderer", async () => {
    for (const [input, expected] of [
      ["./file%2520name.json", "file%20name.json"],
      ["./file%20name.json", "file name.json"],
    ] as const) {
      const href = await processTarget(input);
      expect(
        resolveMarkdownFileLink("/workspace/session/docs", href ?? "", {
          workspaceRootPath: "/workspace",
        })?.path,
      ).toBe(`/workspace/session/docs/${expected}`);
    }
    const windowsHref = await processTarget("C:\\repo\\file%2520name.json:7:2");
    expect(resolveMarkdownFileLink("C:\\repo", windowsHref ?? "")).toEqual({
      path: "C:/repo/file%20name.json",
      lineNumber: 7,
      columnNumber: 2,
    });
    const fileHref = await processTarget("file:///workspace/session/docs/file%2520name.json");
    expect(resolveMarkdownFileLink("/workspace", fileHref ?? "")?.path).toBe(
      "/workspace/session/docs/file%20name.json",
    );
  });

  it("round-trips absolute UNC paths, line numbers and literal escapes through harden", async () => {
    const options = {
      fileReferenceRootPath: "//server/share/session/docs",
      workspacePath: "//server/share",
    };
    for (const target of [
      "\\\\server\\share\\session\\docs\\file%2520name.png:7:2",
      "file://server/share/session/docs/file%2520name.png:7:2",
    ]) {
      const href = await processTarget(target, "a", options);
      expect(
        resolveMarkdownFileLink(options.fileReferenceRootPath, href ?? "", {
          workspaceRootPath: options.workspacePath,
        }),
      ).toEqual({
        path: "//server/share/session/docs/file%20name.png",
        lineNumber: 7,
        columnNumber: 2,
      });
      expect(resolveMarkdownFileLink("/workspace", href ?? "")).toBeNull();
    }
  });
});
