import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { build } from "esbuild";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { createRequire } from "node:module";

const root = resolve(import.meta.dirname, "../..");
const desktopRequire = createRequire(resolve(root, "packages/desktop/package.json"));

// 仅在内存编译 UI 和样式，不打包桌面、不连接用户数据库；浏览器测试复用同一服务。
export async function createStartupAnimationPreview() {
  const [bundle, sourceCss, startupCss, desktopHtml, logo, controls] = await Promise.all([
    build({
      entryPoints: [resolve(import.meta.dirname, "fixtures/startup-animation.jsx")],
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      alias: {
        "@": resolve(root, "packages/ui/src"),
        "@zcode/ui/startup-presentation": desktopRequire.resolve("@zcode/ui/startup-presentation"),
      },
      loader: { ".css": "empty", ".png": "dataurl", ".svg": "dataurl" },
      define: { "process.env.NODE_ENV": '"production"' },
    }),
    readFile(resolve(root, "packages/ui/src/styles.css"), "utf8"),
    readFile(resolve(root, "packages/ui/src/root/startupPresentation.css"), "utf8"),
    readFile(resolve(root, "packages/desktop/src/renderer/index.html"), "utf8"),
    readFile(resolve(root, "public/logo/icons/512x512.png")),
    readFile(resolve(import.meta.dirname, "fixtures/startup-animation-preview.html"), "utf8"),
  ]);
  const compiler = await compile(sourceCss, {
    base: resolve(root, "packages/ui/src"),
    onDependency() {},
  });
  const scanner = new Scanner({
    sources: [
      ...compiler.sources,
      { base: resolve(root, "packages/ui/src"), pattern: "**/*.{ts,tsx}", negated: false },
      {
        base: resolve(import.meta.dirname, "fixtures"),
        pattern: "startup-animation.jsx",
        negated: false,
      },
    ],
  });
  const css = compiler.build(scanner.scan());
  const sceneHtml = desktopHtml
    .replace('href="@zcode/ui/startup-presentation.css"', 'href="/startup.css"')
    .replace('src="./src/main.tsx"', 'src="/fixture.js"')
    .replace("</head>", '<link rel="stylesheet" href="/styles.css"></head>');
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const resources = {
      "/fixture.js": ["text/javascript", bundle.outputFiles[0].contents],
      "/styles.css": ["text/css", css],
      "/startup.css": ["text/css", startupCss],
      "/logo/icons/512x512.png": ["image/png", logo],
      "/public/logo/icons/512x512.png": ["image/png", logo],
      "/": ["text/html", controls],
    };
    if (url.pathname === "/scene") {
      const theme =
        url.searchParams.get("theme") === "system"
          ? "system"
          : url.searchParams.get("theme") === "light"
            ? "zai-light"
            : "zai-dark";
      const reduced =
        url.searchParams.get("reduced") === "1"
          ? `<style>.zcodium-startup-mark,.zcodium-startup-mark img{animation:none!important}</style><script>
          const nativeMatchMedia = window.matchMedia.bind(window);
          window.matchMedia = query => {
            const result = nativeMatchMedia(query);
            if (query === "(prefers-reduced-motion: reduce)") Object.defineProperty(result, "matches", { value: true });
            return result;
          };
        </script>`
          : "";
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      // 只在测试页面注入主题；生产仍读取现有用户设置。
      response.end(
        sceneHtml.replace(
          "<head>",
          `<head>${reduced}<script>localStorage.setItem("zcode-theme", ${JSON.stringify(theme)});</script>`,
        ),
      );
      return;
    }
    const resource = resources[url.pathname];
    if (!resource) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.setHeader("Content-Type", `${resource[0]}; charset=utf-8`);
    response.end(resource[1]);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((done) => {
        server.close(done);
        server.closeAllConnections();
      }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const preview = await createStartupAnimationPreview();
  console.log(`Startup animation preview: ${preview.url}`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void preview.close());
}
