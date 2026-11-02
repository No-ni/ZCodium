import { join, resolve } from "node:path";
import { assertProjectPath } from "../../../scripts/ci/project-test-sandbox.mjs";

// Vite 和 relay 的依赖在隔离 HOME/TEMP 绑定后才加载，禁止预构建缓存写到用户目录。
const sandbox = await assertProjectPath(process.env.PROJECT_TEST_SANDBOX_ROOT);
const webRoot = await assertProjectPath(resolve(import.meta.dirname, "../../web"));
const [{ createServer }, { startRelayServer }] = await Promise.all([
  import("vite"),
  import("@zcode/relay/server"),
]);
const requestedPort = Number(process.argv[2] ?? 0);
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535)
  throw new Error("MOBILE_FIXTURE_PORT_INVALID");
let relay;
let web;
let closing;
const close = () => {
  closing ??= (async () => {
    web?.httpServer?.closeAllConnections();
    await web?.close();
    await relay?.close();
  })();
  return closing;
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => void close().then(() => process.exit(0)));
}
try {
  relay = await startRelayServer({
    port: 0,
    host: "127.0.0.1",
    path: "/ws",
    maxPhysicalFrameBytes: 2 * 1024 * 1024,
    pairTtlMs: 60 * 60 * 1000,
    mobileDir: null,
    logger: { info() {}, warn() {} },
    rateLimiter: { allowConnect: () => true, allowFrame: () => true },
  });
  const relayOrigin = `http://127.0.0.1:${relay.port}`;
  web = await createServer({
    root: webRoot,
    configFile: resolve(webRoot, "vite.config.ts"),
    configLoader: "runner",
    cacheDir: await assertProjectPath(join(sandbox, "cache", "vite")),
    server: {
      host: "127.0.0.1",
      port: requestedPort,
      strictPort: requestedPort !== 0,
      proxy: {
        "/ws": { target: relayOrigin.replace("http:", "ws:"), ws: true },
        "/healthz": { target: relayOrigin },
      },
    },
    plugins: [
      {
        name: "anonymous-mobile-fixture",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const url = new URL(req.url ?? "/", "http://127.0.0.1");
            // 根因：旧 /remote/v4 入口加载工作台和官方登录态；现在只服务真实匿名手机入口。
            if (url.pathname === "/" || url.pathname === "/remote/v4")
              req.url = `/mobile.html${url.search}`;
            if (url.pathname.startsWith("/api/")) {
              res.writeHead(404);
              res.end();
              return;
            }
            next();
          });
        },
      },
    ],
    optimizeDeps: { include: ["@pierre/diffs/worker/worker.js"] },
  });
  await web.listen();
  // stdout 只发布无配对参数的监听 origin，不转发页面内容或 relay proof。
  const origin = web.resolvedUrls.local[0];
  process.stdout.write(`MOBILE_FIXTURE_READY ${origin}\n`);
} catch {
  await close();
  process.stderr.write("MOBILE_FIXTURE_START_FAILED\n");
  process.exitCode = 1;
}
