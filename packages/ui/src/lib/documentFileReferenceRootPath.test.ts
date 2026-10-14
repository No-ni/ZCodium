import { describe, expect, it } from "vitest";
import { resolveDocumentFileReferenceRootPath } from "@/lib/path.js";

describe("resolveDocumentFileReferenceRootPath", () => {
  it("uses the containing directory of an absolute document path", () => {
    expect(
      resolveDocumentFileReferenceRootPath(
        "/workspace/2026-10-11/a1b2c3d4/docs/report.md",
        "/workspace/2026-10-11/a1b2c3d4",
      ),
    ).toBe("/workspace/2026-10-11/a1b2c3d4/docs");
  });

  it("handles Windows document paths", () => {
    expect(
      resolveDocumentFileReferenceRootPath(
        "C:\\Users\\me\\workspace\\docs\\report.md",
        "C:\\Users\\me\\workspace",
      ),
    ).toBe("C:\\Users\\me\\workspace\\docs");
  });

  it("resolves relative source paths against the frozen root and falls back when missing", () => {
    expect(resolveDocumentFileReferenceRootPath(undefined, "/session/cwd")).toBe("/session/cwd");
    expect(resolveDocumentFileReferenceRootPath("docs/report.md", "/session/cwd")).toBe(
      "/session/cwd/docs",
    );
    expect(resolveDocumentFileReferenceRootPath("docs\\report.md", "C:\\session\\cwd")).toBe(
      "C:\\session\\cwd\\docs",
    );
    expect(
      resolveDocumentFileReferenceRootPath("docs/report.md", "\\\\server\\share\\session"),
    ).toBe("\\\\server\\share\\session\\docs");
  });

  it("keeps the fallback when no document path exists", () => {
    expect(resolveDocumentFileReferenceRootPath(undefined, undefined)).toBeUndefined();
  });
});
