import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const vendorDir = new URL(
  "../../apps/zcode-cli/packages/visualize-plugin/skills/visualize/assets/vendor/",
  import.meta.url,
);
const manifestUrl = new URL("manifest.json", vendorDir);

const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));

/** Git 的 .gitattributes 只对 .mjs/.sh 等强制 eol；.js 未覆盖，Windows 检出会被转成 CRLF。 */
const VENDOR_JS_GLOBS = ["apps/zcode-cli/packages/visualize-plugin/skills/visualize/assets/**"];

test("Gen UI vendor 资源实际字节与 manifest 记录一致", async () => {
  for (const resource of manifest.resources) {
    const bytes = await readFile(new URL(resource.file, vendorDir));
    const actual = createHash("sha256").update(bytes).digest("hex");
    assert.equal(
      actual,
      resource.sha256,
      `${resource.file} 的 sha256 与 manifest 不一致：这会让 gen-ui-runtime-assets.mjs 在构建期抛 hash mismatch`,
    );
    const license = await readFile(new URL(resource.licenseFile, vendorDir));
    assert.equal(
      createHash("sha256").update(license).digest("hex"),
      resource.licenseSha256,
      `${resource.licenseFile} 的 sha256 与 manifest 不一致`,
    );
  }
});

test("Gen UI vendor 目录被 .gitattributes 按字节保存", async () => {
  // 若这条缺失：Windows runner 检出 .js 时转成 CRLF，上一条用例在本地仍绿（本地是 LF），
  // 但 CI 的 Build workspace and desktop 会抛 Gen UI vendor hash mismatch。
  const attrs = await readFile(new URL("../../.gitattributes", import.meta.url), "utf8");
  const normalized = attrs.replace(/\\/g, "/");
  for (const glob of VENDOR_JS_GLOBS) {
    assert.ok(
      normalized.includes(`${glob} -text`),
      `.gitattributes 未把 ${glob} 标记为 -text；Windows 检出会改写换行并破坏 sha256 校验`,
    );
  }
});
