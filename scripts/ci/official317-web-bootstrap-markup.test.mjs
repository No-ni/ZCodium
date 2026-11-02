import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Web 启动壳只有一个正文与 root，logo CSS 留在 head 样式中", async () => {
  const html = await readFile(new URL("../../packages/web/index.html", import.meta.url), "utf8");
  for (const tag of ["head", "body", "style"])
    assert.equal((html.match(new RegExp(`<${tag}(?:\\s|>)`, "g")) ?? []).length, 1, tag);
  assert.equal((html.match(/id="root"/g) ?? []).length, 1);
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
  assert.ok(style?.includes(".zcode-boot-loading__logo-shell"));
  assert.match(html, /<div id="root">[\s\S]*?zcode-boot-loading/);
  assert.equal((html.match(/src="\/src\/main\.tsx"/g) ?? []).length, 1);
});
