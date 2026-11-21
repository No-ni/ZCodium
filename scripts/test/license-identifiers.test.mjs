import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isAllowedLicenseIdentifier,
  legacyLicenseIdentifier,
  isReviewedLegacyLicense,
  readRuntimeLicenseReview,
  isReviewedRuntimeLicense,
} from "../license-identifiers.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createProjectTestSandbox } from "../ci/project-test-sandbox.mjs";

test("标准开放字体许可属于允许分类", () => {
  assert.equal(isAllowedLicenseIdentifier("OFL-1.1"), true);
  assert.equal(isAllowedLicenseIdentifier("AGPL-3.0"), false);
});

test("缺失的历史许可标识仅补齐已核验的精确版本", () => {
  assert.equal(legacyLicenseIdentifier({ name: "buffers", version: "0.1.1" }), "MIT/X11");
  assert.equal(legacyLicenseIdentifier({ name: "buffers", version: "0.1.2" }), undefined);
  assert.equal(legacyLicenseIdentifier({ name: "unrelated", version: "0.1.1" }), undefined);
});

test("旧标识复核不能放行其他版本、其他包或已变化的许可", () => {
  for (const [name, version] of [
    ["buffers", "0.1.1"],
    ["chainsaw", "0.1.0"],
  ]) {
    assert.equal(isReviewedLegacyLicense({ name, version, license: "MIT/X11" }), true);
    assert.equal(isReviewedLegacyLicense({ name, version, license: "AGPL-3.0" }), false);
    assert.equal(isReviewedLegacyLicense({ name, version: "9.9.9", license: "MIT/X11" }), false);
  }
  assert.equal(
    isReviewedLegacyLicense({ name: "unknown", version: "0.1.0", license: "MIT/X11" }),
    false,
  );
});

test("CUA/UBJS 复核绑定实际原文，不放行变更版本、表达式或相邻平台", async () => {
  const root = resolve(import.meta.dirname, "../..");
  const { review, packages } = await readRuntimeLicenseReview(root);
  assert.equal(packages.size, 10);
  for (const item of review.packages) {
    const split = item.id.lastIndexOf("@");
    const pkg = {
      name: item.id.slice(0, split),
      version: item.id.slice(split + 1),
      license: item.license,
    };
    const installed = JSON.parse(
      await readFile(join(root, "node_modules", pkg.name, "package.json"), "utf8"),
    );
    assert.equal(installed.version, pkg.version);
    assert.equal(installed.license, pkg.license);
    assert.equal(isReviewedRuntimeLicense(pkg, packages), true);
    assert.equal(isReviewedRuntimeLicense({ ...pkg, version: "99.0.0" }, packages), false);
    assert.equal(isReviewedRuntimeLicense({ ...pkg, license: "AGPL-3.0" }, packages), false);
  }
  assert.equal(
    isReviewedRuntimeLicense(
      { name: "@ubjs/node-linux-x64-gnu", version: "0.31.0-3", license: "MPL-2.0" },
      packages,
    ),
    false,
  );
  const sandbox = await createProjectTestSandbox("runtime-license-evidence");
  const reviewPath = join(sandbox.root, "third-party/cua-driver/review.json");
  await mkdir(dirname(reviewPath), { recursive: true });
  await writeFile(reviewPath, JSON.stringify(review));
  for (const material of review.materials) {
    const target = join(sandbox.root, material.file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(join(root, material.file)));
  }
  assert.equal((await readRuntimeLicenseReview(sandbox.root)).packages.size, 10);
  await writeFile(join(sandbox.root, review.materials[0].file), "altered material");
  await assert.rejects(readRuntimeLicenseReview(sandbox.root), /Changed runtime license material/u);
});
