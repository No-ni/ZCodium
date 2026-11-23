export interface RemoteServerBundleValidationInput {
  bundledInputs: string[];
  source: string;
}

// keyring 需要按目标平台加载原生模块，不能被 esbuild 展开成所有平台的 .node 文件。
export const REMOTE_SERVER_NATIVE_EXTERNALS = ["@napi-rs/keyring"];

const unresolvedUndiciRuntimeImportPattern = /\b(?:require|import)\d*\(["']undici["']\)/;

/** Remote JS and native addon must come from the same pinned platform package. */
export function createRemotePtyBuildPlugin(root = resolve(import.meta.dirname, "../..")): Plugin {
  const require = createRequire(join(root, "packages/server/package.json"));
  const entry = require.resolve("@lydell/node-pty-linux-x64");
  const packageRoot = dirname(dirname(entry));
  return {
    name: "remote-pty-runtime",
    setup(builder) {
      // Server 原先内联 node-pty 1.1，却部署 1.2 beta 的 addon，resize 参数不兼容。
      // 此解析规则只用于远端 bundle，桌面 Electron 的 PTY 仍由桌面构建管理。
      builder.onResolve({ filter: /^node-pty(?:\/|$)/ }, ({ path }) => ({
        path:
          path === "node-pty"
            ? entry
            : require.resolve(join(packageRoot, path.slice("node-pty/".length))),
      }));
      builder.onLoad(
        { filter: /[/\\]node-pty-linux-x64[/\\]lib[/\\]index\.js$/ },
        async ({ path }) => ({
          // 平台裁剪包没有 windowsTerminal；仅对这个依赖入口固定其真实目标平台。
          contents: (await readFile(path, "utf8")).replaceAll("process.platform", '"linux"'),
          loader: "js",
        }),
      );
    },
  };
}

export function validateRemoteServerBundle({
  source,
  bundledInputs,
}: RemoteServerBundleValidationInput): void {
  // JS 和原生 addon 必须同源；拒绝再次把另一个 node-pty 版本混入远端包。
  if (bundledInputs.some((path) => /(?:^|[/\\])node-pty[/\\]lib[/\\]/.test(path))) {
    throw new Error("Remote server must use the dedicated @lydell/node-pty-linux-x64 JS runtime");
  }
  const hasUnresolvedUndiciRuntimeImport = unresolvedUndiciRuntimeImportPattern.test(source);

  if (hasUnresolvedUndiciRuntimeImport) {
    // remote deploy 只会上传单个 zcode-server.cjs 到 ~/.zcodium/server/。
    // 只有 bundle 里残留裸 undici 运行时导入才说明远端还依赖 node_modules；
    // 若当前代码已经不使用 undici，则不应把“无依赖”误判成“未内联”。
    throw new Error(
      'Remote server bundle must inline undici. Found unresolved runtime dependency "undici".',
    );
  }
}
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Plugin } from "esbuild";
