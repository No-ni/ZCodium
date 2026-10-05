import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

// 界面验收夹具仅监听本机；用浏览器完成 spec 的 E2E 场景后按 Ctrl-C 退出。
const root = resolve(import.meta.dirname, "../..");
const { outputFiles } = await build({
  entryPoints: [resolve(import.meta.dirname, "fixtures/summary-model-settings.jsx")],
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  alias: { "@": resolve(root, "packages/ui/src") },
  loader: { ".css": "empty", ".png": "dataurl", ".svg": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"' },
});
const assets =
  process.env.ZCODE_TEST_RENDERER_ASSETS || resolve(root, "packages/desktop/out/renderer/assets");
const cssName = (await readdir(assets)).find((name) => /^styles-.*\.css$/.test(name));
const css = await readFile(resolve(assets, cssName), "utf8");
const server = createServer((request, response) => {
  if (request.url === "/fixture.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(outputFiles[0].contents);
  } else if (request.url === "/styles.css") {
    response.setHeader("Content-Type", "text/css");
    response.end(css);
  } else if (request.url?.startsWith("/assets/")) {
    response.writeHead(404);
    response.end();
  } else {
    response.setHeader("Content-Type", "text/html");
    response.end(
      '<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/styles.css"><div id="root"></div><script type="module" src="/fixture.js"></script>',
    );
  }
});
server.listen(0, "127.0.0.1", () =>
  console.log(
    JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${server.address().port}` }),
  ),
);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close());
