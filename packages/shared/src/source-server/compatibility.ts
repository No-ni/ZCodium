import { z } from "zod";
import { ZCODE_VERSION } from "../version.js";

export const compatibilityManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    productVersion: z.string().trim().min(1),
    minCompatibleVersion: z.string().trim().min(1),
  })
  .strict();
export type CompatibilityManifest = z.infer<typeof compatibilityManifestSchema>;
export function createCompatibilityManifest(
  productVersion = ZCODE_VERSION,
  minCompatibleVersion = ZCODE_VERSION,
): CompatibilityManifest {
  return compatibilityManifestSchema.parse({
    schemaVersion: 1,
    productVersion,
    minCompatibleVersion,
  });
}
export const ZCODE_COMPATIBILITY_MANIFEST = Object.freeze(createCompatibilityManifest());
export function compareCompatibilityVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
    if (!match) throw new Error("Invalid Source compatibility version");
    return {
      parts: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4]?.split(".") ?? [],
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = a.parts[index]! - b.parts[index]!;
    if (difference !== 0) return difference;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0)
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) - Number(y);
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
export function evaluateSourceServerCompatibility(
  controller: CompatibilityManifest,
  server: CompatibilityManifest,
) {
  const order = compareCompatibilityVersions(controller.productVersion, server.productVersion);
  // 两端最低版本都是契约；只检查较新端会放过损坏或不一致的旧端 manifest。
  const compatible =
    compareCompatibilityVersions(server.productVersion, controller.minCompatibleVersion) >= 0 &&
    compareCompatibilityVersions(controller.productVersion, server.minCompatibleVersion) >= 0;
  return {
    compatible,
    updateAvailable: order !== 0,
    upgradeTarget: order >= 0 ? ("server" as const) : ("controller" as const),
    minimumVersion: order >= 0 ? controller.minCompatibleVersion : server.minCompatibleVersion,
  };
}
