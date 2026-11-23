// 保留官方基础范围，按当前公开入口与实际验证命令补齐来源，避免把 bundle 当作另一份源码。
import { readFile, access, glob } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import { parse } from "yaml";
const root = import.meta.dirname;
const original = JSON.parse(await readFile(join(root, "knip.json"), "utf8"));
const config = { ...original, workspaces: { ...original.workspaces } };
config.paths = { ...(config.paths ?? {}), "@/*": ["packages/ui/src/*"] };
config.paths["/packages/*"] = ["packages/*"];
// knip 的 release-it 默认 glob 不包含 mjs；本仓发布配置实际位于此处。
config.workspaces["."]["release-it"] = { config: [".release-it.mjs"] };
// 浏览器 evaluate 内的 Vite 根地址只在静态分析输入中映射；不存在的文件仍会报 unresolved。
config.compilers = {
  ...config.compilers,
  ".mjs": (source, file) =>
    source.replace(
      /(\bimport\(\s*["'])\/packages\/([^"']+)(["']\s*\))/g,
      (_, prefix, target, suffix) => {
        const path = relative(dirname(file), join(root, "packages", target)).replaceAll("\\", "/");
        return prefix + (path.startsWith(".") ? path : "./" + path) + suffix;
      },
    ),
};
const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
};
const values = (value) =>
  typeof value === "string"
    ? [value]
    : value && typeof value === "object"
      ? Object.values(value).flatMap(values)
      : [];
const policy = parse(await readFile(join(root, "architecture-policy.yaml"), "utf8"));
const packagePaths = [];
for (const parent of ["packages", "apps", "apps/zcode-cli/packages", "apps/zcode-cli/tools"])
  for await (const path of glob(parent + "/*/package.json", { cwd: root }))
    packagePaths.push(path.replaceAll("\\", "/"));
for (const packagePath of packagePaths) {
  const workspace = packagePath.slice(0, -"/package.json".length),
    dir = join(root, workspace),
    manifest = JSON.parse(await readFile(join(root, packagePath), "utf8"));
  const entry = new Set(config.workspaces[workspace]?.entry ?? []);
  for (const target of [
    ...values(manifest.exports),
    ...values(manifest.bin),
    ...values(manifest.main),
    ...values(manifest.types),
  ]) {
    // bundle 的 dist 不是另一份源码入口；找不到同名 source 时使用真实的 package main source。
    const candidates = [
      target
        .replace(/^\.\/dist\//, "./src/")
        .replace(/\.d\.ts$/, ".ts")
        .replace(/\.(?:js|cjs|mjs)$/, ".ts"),
      target.replace(/^\.\/dist\//, "./src/").replace(/\.js$/, ".tsx"),
      ...(!target.startsWith("./dist/") ? [target] : []),
      ...(manifest.name === "@zcode/cli" || manifest.name === "@zcode/server-cli"
        ? ["src/main.ts"]
        : []),
    ];
    for (const candidate of candidates) {
      if (candidate.includes("*")) {
        entry.add(candidate);
        break;
      }
      if (await exists(join(dir, candidate))) {
        entry.add(candidate);
        break;
      }
    }
  }
  const publicMap = manifest.exports ?? { ".": manifest.main };
  for (const [name, target] of Object.entries(publicMap)) {
    for (const item of values(target)) {
      const candidate = item
        .replace(/^\.\/dist\//, "./src/")
        .replace(/\.d\.ts$/, ".ts")
        .replace(/\.js$/, ".ts");
      if ((await exists(join(dir, candidate))) || candidate.includes("*")) {
        config.paths[manifest.name + (name === "." ? "" : "/" + name.replace(/^\.\//, ""))] = [
          workspace + "/" + candidate.replace(/^\.\//, ""),
        ];
        break;
      }
    }
  }
  for (const module of policy.modules.filter((m) => m.managed))
    for (const path of module.publicEntrypoints ?? [])
      if (path.startsWith(workspace + "/"))
        entry.add(relative(dir, join(root, path)).replaceAll("\\", "/"));
  for (const module of policy.modules.filter((m) => m.managed))
    for (const base of module.roots ?? [])
      if (base.startsWith(workspace + "/"))
        for (const filename of ["module.ts", "contract.example.ts"]) {
          const path = join(root, base, filename);
          if (await exists(path)) entry.add(relative(dir, path).replaceAll("\\", "/"));
        }
  for (const path of [
    "test/**/*.test.{ts,tsx,mjs,cjs}",
    "tests/**/*.test.{ts,tsx,mjs,cjs}",
    "scripts/*.{ts,mjs,cjs}",
    "src/**/*.html",
    "test/**/*.html",
    "test/**/*.fixture.{tsx,jsx}",
    "*.html",
  ])
    entry.add(path);
  config.workspaces[workspace] = { ...config.workspaces[workspace], entry: [...entry] };
  if (manifest.name === "@zcode/cli")
    config.workspaces[workspace].ignore = [
      ...new Set([...(config.workspaces[workspace].ignore ?? []), "dist/zcode.cjs"]),
    ];
  if (manifest.name === "@zcode/server-cli")
    config.workspaces[workspace].ignore = [
      ...new Set([...(config.workspaces[workspace].ignore ?? []), "dist/server-cli.js"]),
    ];
  // 设计系统导入器只读取该文件的文本；它含执行哨兵，不能当作 Tailwind 配置或 JS 程序。
  if (manifest.name === "@zcode/design-plugin") {
    config.workspaces[workspace].tailwind = false;
    config.workspaces[workspace].ignore = [
      ...new Set([
        ...(config.workspaces[workspace].ignore ?? []),
        "test/fixtures/frontend/tailwind.config.js",
      ]),
    ];
  }
}
const rootEntry = new Set(config.workspaces["."].entry);
for (const pattern of [
  "scripts/**/*.test.{ts,mjs}",
  "scripts/ci/fixtures/*.{html,jsx,tsx}",
  "scripts/ci/*.mjs",
  "scripts/windows-runtime-host/*.cjs",
  "scripts/test/*.mjs",
])
  rootEntry.add(pattern);
config.workspaces["."] = { ...config.workspaces["."], entry: [...rootEntry] };
export default config;
