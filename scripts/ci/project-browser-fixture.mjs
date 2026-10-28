import { access, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertProjectPath,
  createProjectTestSandbox,
  projectRoot,
} from "./project-test-sandbox.mjs";

let environmentLeased = false;

async function boundedClose(promise) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("PROJECT_BROWSER_CLOSE_TIMEOUT")), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function startProjectBrowserFixture({ label, entry, tailwind = true }) {
  if (environmentLeased) throw new Error("PROJECT_BROWSER_FIXTURE_ACTIVE");
  environmentLeased = true;
  const previous = { ...process.env };
  const restoreEnvironment = () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
    environmentLeased = false;
  };
  let server;
  let closing;
  const close = () => {
    closing ??= (async () => {
      if (!server) {
        restoreEnvironment();
        return;
      }
      const stopped = Promise.resolve()
        .then(async () => {
          // HTTP keep-alive 不能拖住环境 owner；只断开本夹具持有的连接。
          server.httpServer?.closeAllConnections();
          await server.close();
        })
        .then(restoreEnvironment);
      await boundedClose(stopped);
    })();
    return closing;
  };
  try {
    const entryPath = await assertProjectPath(resolve(projectRoot, entry));
    await access(entryPath);
    const sandbox = await createProjectTestSandbox(label);
    // Vite/esbuild 可能在导入时捕获 TEMP；依赖必须在项目环境绑定后才装载。
    for (const key of Object.keys(process.env)) {
      if (!(key in sandbox.env)) delete process.env[key];
    }
    Object.assign(process.env, sandbox.env);
    const [{ createServer }, { default: react }] = await Promise.all([
      import("vite"),
      import("@vitejs/plugin-react"),
    ]);
    const plugins = [react()];
    if (tailwind) {
      const { default: tailwindcss } = await import("@tailwindcss/vite");
      plugins.push(tailwindcss());
    }
    server = await createServer({
      configFile: false,
      root: projectRoot,
      cacheDir: join(sandbox.cache, "vite"),
      optimizeDeps: {
        noDiscovery: true,
        include: [
          "react",
          "react-dom",
          "react-dom/client",
          "react/jsx-runtime",
          "react/jsx-dev-runtime",
          "@lexical/react/LexicalComposer",
          "@lexical/react/LexicalComposerContext",
          "@lexical/react/LexicalContentEditable",
          "@lexical/react/LexicalHistoryPlugin",
          "@lexical/react/LexicalPlainTextPlugin",
          "@pierre/diffs",
          "@tanstack/react-virtual",
          "class-variance-authority",
          "clsx",
          "croner",
          "lexical",
          "lucide-react",
          "radix-ui",
          "tailwind-merge",
          "zod",
          "zustand",
          "zustand/react/shallow",
        ],
      },
      plugins,
      resolve: {
        alias: { "@": join(projectRoot, "packages/ui/src") },
        dedupe: ["react", "react-dom"],
      },
      server: {
        host: "127.0.0.1",
        port: 5173,
        hmr: false,
        watch: null,
        fs: { deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**"] },
      },
      logLevel: "error",
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
      throw new Error("PROJECT_BROWSER_ADDRESS_REJECTED");
    }
    const origin = `http://127.0.0.1:${address.port}/`;
    const url = new URL(entry, origin).href;
    await writeFile(join(sandbox.root, "fixture.json"), JSON.stringify({ url, entry }), {
      flag: "wx",
    });
    return { server, sandbox, origin, url, close };
  } catch (error) {
    try {
      await close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], error.message);
    }
    throw error;
  }
}

export async function runProjectBrowserFixture(options) {
  const fixture = await startProjectBrowserFixture(options);
  process.stdout.write(`${fixture.url}\n${fixture.sandbox.root}\n`);
  const stop = () => {
    void fixture.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
