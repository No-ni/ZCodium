import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("document visibility, cleanup and isolation regressions execute", async () => {
  const { tests } = await runSourceTests(["packages/ui/test/documentHiddenMotionPause.test.ts"]);
  assert.equal(tests, 4);
});

test("desktop, web and independent mobile entry install before any React root", async () => {
  const pkg = JSON.parse(await read("packages/ui/package.json"));
  assert.equal(
    pkg.exports["./document-hidden-motion-pause"],
    "./src/lib/documentHiddenMotionPause.ts",
  );
  for (const path of [
    "packages/desktop/src/renderer/src/main.tsx",
    "packages/web/src/main.tsx",
    "packages/web/src/mobile/main.tsx",
  ]) {
    const source = await read(path);
    assert.match(source, /from "@zcode\/ui\/document-hidden-motion-pause"/);
    const install = source.indexOf("installDocumentHiddenMotionPause();");
    const render = source.indexOf("createRoot(");
    assert.ok(install !== -1 && render > install, `${path}: install before rendering`);
    assert.match(source, /import\.meta\.hot\?\.dispose\(disposeDocumentHiddenMotionPause\)/);
  }
});

test("hidden CSS suppresses transitions and animations for descendants and pseudo elements", async () => {
  const css = await read("packages/ui/src/styles.css");
  assert.ok(
    /html\[data-document-hidden\] \*:not\(\[data-motion-persistent\], \[data-motion-persistent\] \*\),\s*html\[data-document-hidden\] \*:not\(\[data-motion-persistent\], \[data-motion-persistent\] \*\)::before,\s*html\[data-document-hidden\] \*:not\(\[data-motion-persistent\], \[data-motion-persistent\] \*\)::after\s*\{\s*transition: none !important;\s*animation: none !important;\s*\}/.test(
      css,
    ),
    "Hidden descendants and pseudo elements must disable CSS motion",
  );
});

test("常驻动画子树不参与 hidden 暂停，侧栏展开动画不会在恢复可见时重播", async () => {
  const css = await read("packages/ui/src/styles.css");
  const lib = await read("packages/ui/src/lib/documentHiddenMotionPause.ts");
  const sidebar = await read("packages/ui/src/project-sidebar/index.tsx");
  assert.match(
    lib,
    /export const DOCUMENT_MOTION_PERSISTENT_ATTRIBUTE = "data-motion-persistent";/,
    "常驻动画标记必须有唯一来源",
  );
  assert.match(
    sidebar,
    /data-motion-persistent=""/,
    "侧栏折叠动画是常驻进入动画，必须排除在 hidden 暂停之外",
  );
  // 豁免必须写在隐藏规则的选择器里：另一条规则无法「还原」被 !important 清掉的动画。
  assert.match(css, /:not\(\[data-motion-persistent\], \[data-motion-persistent\] \*\)/);
});
