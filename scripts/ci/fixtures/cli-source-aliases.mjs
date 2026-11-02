import { access, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveBuildAliases } from "../../../apps/zcode-cli/packages/cli/scripts/build.mjs";

/** 回归入口只解析各包真实公开 exports 对应的源码，避免混入上次构建的 dist。 */
export async function resolveCliSourceAliases() {
  const root = resolve(import.meta.dirname, "../../..");
  const packages = join(root, "apps/zcode-cli/packages");
  const aliases = { ...resolveBuildAliases() };
  for (const entry of await readdir(packages, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(packages, entry.name);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const [subpath, exported] of Object.entries(manifest.exports ?? {})) {
      if (!subpath.startsWith(".") || subpath.includes("*")) continue;
      const target =
        typeof exported === "string" ? exported : (exported.import ?? exported.default);
      if (typeof target !== "string" || !target.startsWith("./dist/")) continue;
      const candidates = [
        target.replace("./dist/", "./src/").replace(/\.js$/, ".ts"),
        target.replace("./dist/", "./src/").replace(/\.js$/, ".tsx"),
      ];
      for (const candidate of candidates) {
        const file = resolve(directory, candidate);
        try {
          await access(file);
        } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        aliases[subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`] = file;
        break;
      }
    }
  }
  return Object.fromEntries(Object.entries(aliases).sort(([a], [b]) => b.length - a.length));
}
