import { describe, expect, it } from "vitest";
import { parseManifestUpdateInfo } from "./manifestUpdateProvider.js";

describe("parseManifestUpdateInfo", () => {
  it("keeps the current file-list manifest shape and release metadata", () => {
    const update = parseManifestUpdateInfo(
      {
        version: "3.15.2",
        releaseDate: "2026-10-18T00:00:00.000Z",
        files: [{ url: "desktop-win-x64.exe", sha512: "checksum", size: 123 }],
        packages: {
          x64: { path: "desktop-win-x64.7z", sha512: "package-checksum" },
        },
        releaseNotes: "Bug fixes",
      },
      "stable",
    );

    expect(update).toMatchObject({
      version: "3.15.2",
      releaseDate: "2026-10-18T00:00:00.000Z",
      path: "desktop-win-x64.exe",
      sha512: "checksum",
      files: [{ url: "desktop-win-x64.exe", sha512: "checksum", size: 123 }],
      packages: {
        x64: { path: "desktop-win-x64.7z", sha512: "package-checksum" },
      },
      zcodeReleaseChannel: "stable",
    });
  });

  it("normalizes the supported legacy path manifest", () => {
    const update = parseManifestUpdateInfo(
      { version: "3.15.2", path: "desktop.dmg", sha512: "checksum" },
      "preview",
    );

    expect(update.files).toEqual([{ url: "desktop.dmg", sha512: "checksum" }]);
    expect(update.zcodeReleaseChannel).toBe("preview");
  });

  it.each([
    ["missing version", { files: [{ url: "desktop.dmg", sha512: "checksum" }] }],
    ["missing files", { version: "3.15.2" }],
    ["missing checksum", { version: "3.15.2", files: [{ url: "desktop.dmg" }] }],
    [
      "invalid package",
      {
        version: "3.15.2",
        files: [{ url: "desktop.dmg", sha512: "checksum" }],
        packages: { x64: { path: "desktop.7z" } },
      },
    ],
  ])("rejects %s at the manifest boundary", (_description, manifest) => {
    expect(() => parseManifestUpdateInfo(manifest, "stable")).toThrow(
      "Invalid electron update manifest",
    );
  });
});
