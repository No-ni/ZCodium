import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readShareDerivationBody } from "./performanceShareInactive.source.js";

// 运行 corepack pnpm exec tsx packages/ui/test/performance-share-inactive.serve.ts，
// 再用官方浏览器打开打印的 URL；不启动外部浏览器或读取真实 Host/用户数据。
const root = fileURLToPath(new URL("../../../", import.meta.url));
const cacheDir = await mkdtemp(join(tmpdir(), "zcodium-share-inactive-"));
const body = await readShareDerivationBody();
const declaration = [
  "shareActive",
  "snapshot",
  "useMemo",
  "buildConversationTurnRenderUnits",
  "buildConversationTurnNavigatorItems",
  "intl",
  body,
]
  .map((value) => JSON.stringify(value))
  .join(",");
const server = await createServer({
  configFile: false,
  root,
  cacheDir,
  plugins: [
    react(),
    {
      name: "share-source-injection",
      transformIndexHtml(html) {
        return html.replace(
          "</head>",
          `<script>window.shareDerivation = new Function(${declaration});</script></head>`,
        );
      },
    },
  ],
  resolve: { alias: { "@": resolve(root, "packages/ui/src") }, dedupe: ["react", "react-dom"] },
  optimizeDeps: { entries: [resolve(root, "packages/ui/test/performance-share-inactive.html")] },
  server: { host: "127.0.0.1", port: 0 },
  logLevel: "error",
});
async function close() {
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
await server.listen();
process.stdout.write(
  `${server.resolvedUrls!.local[0]}packages/ui/test/performance-share-inactive.html\n`,
);
