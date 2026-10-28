import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { licenseSupplement } from "./license-supplements.mjs";

/** Collect full attribution from the modules and copied binary packages actually shipped. */
export async function writeNotices(metafiles, destination, additionalPackageRoots = []) {
  const packages = new Map();
  for (const directory of additionalPackageRoots)
    packages.set(directory, JSON.parse(await readFile(join(directory, "package.json"), "utf8")));
  for (const input of metafiles.flatMap((meta) => Object.keys(meta.inputs))) {
    if (!input.includes("node_modules/")) continue;
    let directory = dirname(resolve(input));
    while (directory.includes("node_modules")) {
      try {
        const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
        if (pkg.name) {
          packages.set(directory, pkg);
          break;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      directory = dirname(directory);
    }
  }
  const notices = [];
  const seen = new Set();
  for (const [directory, pkg] of [...packages].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const files = (await readdir(directory)).filter((name) =>
      /^(license|licence|copying|notice)([.-]|$)/i.test(name),
    );
    const texts = await Promise.all(files.map((file) => readFile(join(directory, file), "utf8")));
    const license =
      typeof pkg.license === "string" ? pkg.license : JSON.stringify(pkg.license ?? null);
    if (!texts.length) {
      // SPDX 只表达授权标识，不含 MIT 的版权/许可全文，不能把缺件静默当成完成。
      const readme = (await readdir(directory)).find((name) => /^readme\.(?:md|txt)$/i.test(name));
      if (readme) {
        const source = await readFile(join(directory, readme), "utf8");
        const match = /^#{1,6}\s+Licen[cs]e[^\n]*\n([\s\S]*?)(?=^#{1,6}\s|$(?![\s\S]))/im.exec(
          source,
        );
        if (
          match &&
          /Copyright/i.test(match[1]) &&
          /Permission is hereby granted/i.test(match[1]) &&
          /THE SOFTWARE IS PROVIDED/i.test(match[1])
        )
          texts.push(match[1].trim());
      }
      const supplement = licenseSupplement(key);
      if (!texts.length && supplement) texts.push(supplement);
      if (!texts.length) throw new Error(`Missing complete license for bundled dependency ${key}`);
    }
    notices.push(`${key} — ${license}\n${texts.join("\n\n")}`);
  }
  await writeFile(destination, notices.join("\n\n----------------------------------------\n\n"));
}
