import { describe, expect, it, vi, afterEach } from "vitest";
import { installLinkGuard, safeExternalUrl } from "#ui/dom.ts";
import * as manifest from "#ui/resourceManifest.ts";

afterEach(() => vi.unstubAllGlobals());

describe("Office panel has no external navigation", () => {
  it("removes rendered outbound hrefs so native context-menu navigation cannot bypass click guards", () => {
    class Link {
      readonly attributes = new Map([
        ["href", "https://example.invalid"],
        ["target", "_blank"],
      ]);
      getAttribute(name: string) {
        return this.attributes.get(name) ?? null;
      }
      removeAttribute(name: string) {
        this.attributes.delete(name);
      }
      setAttribute(name: string, value: string) {
        this.attributes.set(name, value);
      }
    }
    const external = new Link();
    const bookmark = new Link();
    bookmark.attributes.set("href", "#section-1");
    let update!: () => void;
    class Observer {
      constructor(callback: () => void) {
        update = callback;
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("MutationObserver", Observer);
    const root = {
      querySelectorAll: () => [external, bookmark],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLElement;
    const stop = installLinkGuard(root, () => true);
    expect(external.getAttribute("href")).toBeNull();
    expect(external.getAttribute("target")).toBeNull();
    expect(bookmark.getAttribute("href")).toBe("#section-1");
    external.setAttribute("href", "https://example.invalid/late");
    update();
    expect(external.getAttribute("href")).toBeNull();
    stop();
  });
  it("blocks http(s), mailto, scripts, file paths and protocol-relative links", () => {
    for (const value of [
      "https://example.invalid",
      "http://example.invalid",
      "mailto:reader@example.invalid",
      "javascript:alert(1)",
      "file:///fixture.pdf",
      "//example.invalid/x",
    ])
      expect(safeExternalUrl(value)).toBeNull();
  });
});

describe("local resource manifest validation", () => {
  it("accepts bounded bundle resources and rejects URL/traversal/over-budget entries", () => {
    expect(
      manifest.parseAssetManifest({ scripts: ["bundle-0.txt"], scriptBytes: 12 }).scripts,
    ).toEqual(["bundle-0.txt"]);
    for (const value of [
      { scripts: ["https://example.invalid/x.js"], scriptBytes: 12 },
      { scripts: ["../server.mjs"], scriptBytes: 12 },
      { scripts: ["bundle-0.txt"], scriptBytes: 128 * 1024 * 1024 },
      { scripts: Array.from({ length: 100 }, () => "bundle-0.txt"), scriptBytes: 12 },
    ])
      expect(() => manifest.parseAssetManifest(value)).toThrow();
  });
  it("allows only bundled font slices, never remote font URLs", () => {
    expect(
      manifest.parseFontManifest({
        faces: [{ file: "fonts/noto-sans-sc-1-400-normal.woff2", unicodeRange: "U+0000-00FF" }],
      }).faces,
    ).toHaveLength(1);
    expect(() =>
      manifest.parseFontManifest({
        faces: [{ file: "https://example.invalid/font.woff2", unicodeRange: "U+0000-00FF" }],
      }),
    ).toThrow();
    expect(() =>
      manifest.parseFontManifest({
        faces: [{ file: "fonts/a.woff2", unicodeRange: "url(https://example.invalid)" }],
      }),
    ).toThrow();
  });
});
