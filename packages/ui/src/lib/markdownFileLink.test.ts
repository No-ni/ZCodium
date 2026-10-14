import { describe, expect, it } from "vitest";
import { resolveMarkdownFileLink } from "@/lib/markdownFileLink.js";

describe("resolveMarkdownFileLink containment", () => {
  it("resolves parent links from a document directory while keeping the workspace boundary", () => {
    expect(
      resolveMarkdownFileLink("/workspace/session/docs", "../schema.json", {
        workspaceRootPath: "/workspace",
      })?.path,
    ).toBe("/workspace/session/schema.json");
  });

  it("rejects parent links that escape the workspace boundary", () => {
    expect(
      resolveMarkdownFileLink("/workspace/session/docs", "../../../outside.json", {
        workspaceRootPath: "/workspace",
      }),
    ).toBeNull();
  });

  it("keeps the old strict behavior when no separate workspace boundary is provided", () => {
    expect(resolveMarkdownFileLink("/workspace/session/docs", "../schema.json")).toBeNull();
  });

  it("resolves Windows parent links without allowing a drive-root escape", () => {
    expect(
      resolveMarkdownFileLink("C:\\workspace\\session\\docs", "..\\schema.json", {
        workspaceRootPath: "C:\\workspace",
      })?.path,
    ).toBe("C:\\workspace\\session\\schema.json");

    expect(
      resolveMarkdownFileLink("C:\\workspace\\session\\docs", "..\\..\\..\\outside.json", {
        workspaceRootPath: "C:\\workspace",
      }),
    ).toBeNull();
  });

  it("recognizes an absolute path under the identity root even when outside the document directory", () => {
    expect(
      resolveMarkdownFileLink("/workspace/session/docs", "/workspace/session/schema.json", {
        workspaceRootPath: "/workspace",
      })?.path,
    ).toBe("/workspace/session/schema.json");
  });

  it.each([
    ["c:\\WORKSPACE\\session\\docs", "C:\\workspace", "C:\\workspace\\session\\schema.json"],
    [
      "\\\\SERVER\\Share\\SESSION\\docs",
      "\\\\server\\share",
      "\\\\server\\share\\SESSION\\schema.json",
    ],
  ])("accepts Windows document casing differences (%s)", (documentPath, root, expected) => {
    expect(
      resolveMarkdownFileLink(documentPath, "../schema.json", { workspaceRootPath: root })?.path,
    ).toBe(expected);
  });

  it.each([
    ["D:\\workspace\\session", "C:\\workspace"],
    ["C:\\workspace-other\\session", "c:\\WORKSPACE"],
    ["\\\\server\\other\\session", "\\\\SERVER\\share"],
    ["/WORKSPACE/session", "/workspace"],
  ])("rejects a document outside its identity root (%s)", (documentPath, root) => {
    expect(
      resolveMarkdownFileLink(documentPath, "./chart.png", { workspaceRootPath: root }),
    ).toBeNull();
  });

  it("preserves absolute UNC targets under a document directory", () => {
    expect(
      resolveMarkdownFileLink("\\\\server\\share\\docs", "\\\\server\\share\\chart.png", {
        workspaceRootPath: "\\\\server\\share",
      })?.path,
    ).toBe("//server/share/chart.png");
  });
});
