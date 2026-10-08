import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { build } from "vite";

test("desktop HTML resolves the public startup stylesheet in a production bundle", async () => {
  // 只编译真实首屏 HTML/CSS；无需桌面打包，也不能靠夹具重写 URL 掩盖 Vite 资源解析错误。
  const result = await build({
    configFile: false,
    root: resolve(import.meta.dirname, "../../packages/desktop/src/renderer"),
    base: "./",
    logLevel: "error",
    plugins: [
      {
        name: "startup-assets-only",
        transformIndexHtml: {
          order: "pre",
          handler: (html) =>
            html.replace('<script type="module" src="./src/main.tsx"></script>', ""),
        },
      },
    ],
    build: { write: false, minify: false },
  });
  const html = result.output.find((asset) => asset.fileName === "index.html").source;
  const css = result.output
    .filter((asset) => asset.fileName.endsWith(".css"))
    .map((asset) => asset.source)
    .join("\n");
  assert.ok(!html.includes("@zcode/ui/"), "package stylesheet must resolve to a bundled URL");
  assert.match(html, /href="\.\/assets\/.*\.css"/);
  assert.match(html, /src="\.\/logo\/icons\/512x512.png"/);
  assert.match(css, /zcodium-startup-enter/);
  assert.match(css, /prefers-reduced-motion/);
});
