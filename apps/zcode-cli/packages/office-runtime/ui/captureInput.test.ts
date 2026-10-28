import { expect, it } from "vitest";
import { parseCaptureInput, CAPTURE_INPUT } from "#ui/captureInput.ts";
import { parseAssetManifest, parseFontManifest, verifyScriptParts } from "#ui/resourceManifest.ts";

it("checks capture arguments against the advertised page schema", () => {
  expect(CAPTURE_INPUT.additionalProperties).toBe(false);
  expect(parseCaptureInput({ anchor: "docs/report.docx#p:1", maxWidth: 320 })).toEqual({
    anchor: "docs/report.docx#p:1",
    maxWidth: 320,
  });
  for (const value of [
    { anchor: " " },
    { maxWidth: 319 },
    { maxWidth: 2001 },
    { maxWidth: 400.5 },
    { other: true },
  ])
    expect(() => parseCaptureInput(value)).toThrow();
});
it("rejects reordered, duplicated and mismatched UTF-8 script resources", () => {
  expect(() => parseAssetManifest({ scripts: ["bundle-1.txt"], scriptBytes: 1 })).toThrow();
  expect(() =>
    parseAssetManifest({ scripts: ["bundle-0.txt", "bundle-0.txt"], scriptBytes: 1 }),
  ).toThrow();
  expect(() => verifyScriptParts(["中文"], 6)).not.toThrow();
  expect(() => verifyScriptParts(["中文"], 2)).toThrow();
});
it("rejects duplicate fonts, invalid unicode ranges and outside-plane ranges", () => {
  const face = { file: "fonts/noto-sans-sc-1-400-normal.woff2", unicodeRange: "U+4E00-9FFF" };
  expect(() => parseFontManifest({ faces: [face, face] })).toThrow();
  for (const unicodeRange of ["U+9FFF-4E00", "U+110000", "url(https://example.invalid)"])
    expect(() => parseFontManifest({ faces: [{ ...face, unicodeRange }] })).toThrow();
});
