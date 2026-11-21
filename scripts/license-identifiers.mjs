const allowedLicenseIdentifierPattern =
  /^(MIT|MIT-0|ISC|BSD-2-Clause|BSD-3-Clause|BSD-4-Clause|0BSD|Unlicense|Apache-2\.0|Zlib|WTFPL|Artistic-2\.0|BlueOak-1\.0\.0|CC0-1\.0|CC-BY-4\.0|CC-BY-3\.0|OFL-1\.1|BSD|Python-2\.0)$/i;

export function isAllowedLicenseIdentifier(value) {
  return allowedLicenseIdentifierPattern.test(value);
}

// 旧 npm 包的许可字段缺失或使用非 SPDX 拼写，不能因此给所有版本或未知包放行。
// 原作者补充的同版 metadata 和发布包证据见 third-party/README.md。
const reviewed = new Set(["buffers@0.1.1", "chainsaw@0.1.0"]);

export function legacyLicenseIdentifier(pkg) {
  return pkg.name === "buffers" && pkg.version === "0.1.1" ? "MIT/X11" : undefined;
}

export function isReviewedLegacyLicense(pkg) {
  return reviewed.has(`${pkg.name}@${pkg.version}`) && pkg.license === "MIT/X11";
}
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function readRuntimeLicenseReview(root) {
  const review = JSON.parse(
    await readFile(resolve(root, "third-party/cua-driver/review.json"), "utf8"),
  );
  if (review.schemaVersion !== 1 || !review.materials?.length || !review.packages?.length)
    throw new Error("Invalid runtime license review");
  // 原因：精确版本复核必须绑定已取得的原始材料，不能只改标识名单让门禁通过。
  for (const material of review.materials) {
    if (!/^third-party\/[a-zA-Z0-9/._-]+$/u.test(material.file) || material.file.includes(".."))
      throw new Error("Invalid runtime license material path");
    const bytes = await readFile(resolve(root, material.file));
    if (createHash("sha256").update(bytes).digest("hex") !== material.sha256)
      throw new Error(`Changed runtime license material: ${material.file}`);
  }
  const packages = new Map();
  for (const item of review.packages) {
    if (packages.has(item.id) || !item.license || !item.reason)
      throw new Error("Invalid runtime license package review");
    packages.set(item.id, item);
  }
  return { review, packages };
}

export function isReviewedRuntimeLicense(pkg, packages) {
  const item = packages.get(`${pkg.name}@${pkg.version}`);
  return Boolean(item && item.license === pkg.license);
}
