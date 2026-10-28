import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProjectTestFixture } from "../../../../../scripts/ci/project-test-sandbox.mjs";
import { writeNotices } from "./licenses.mjs";

// 项目内 fresh 合成样本：不写系统临时目录，不做整根递归清理（Office spec §9.5）。
async function fixture(name, version = "1") {
  const root = await createProjectTestFixture("office-license");
  const directory = join(root, "node_modules", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name, version, license: "MIT" }),
  );
  const input = join(directory, "index.js").replaceAll("\\", "/");
  return { directory, destination: join(root, "notices.txt"), meta: { inputs: { [input]: {} } } };
}

describe("complete Office bundled attribution", () => {
  it("takes a complete package README License section instead of a SPDX sentence", async () => {
    const f = await fixture("fixture-mit");
    const text =
      "(MIT)\nCopyright (c) 2000 Fixture Authors\nPermission is hereby granted, free of charge, to any person obtaining a copy\nTHE SOFTWARE IS PROVIDED AS IS.";
    await writeFile(join(f.directory, "README.md"), `# Fixture\n\n## License\n${text}\n`);
    await writeNotices([f.meta], f.destination);
    expect(await readFile(f.destination, "utf8")).toContain(text);
  });
  it("fails closed for an unknown package that has only a license identifier", async () => {
    const f = await fixture("fixture-missing");
    await expect(writeNotices([f.meta], f.destination)).rejects.toThrow(/complete license/i);
  });
  it("retains the saxes ISC and inherited copyright notices in full", async () => {
    const f = await fixture("saxes", "5.0.1");
    await writeNotices([f.meta], f.destination);
    const text = await readFile(f.destination, "utf8");
    expect(text).toContain("Copyright (c) Isaac Z. Schlueter and Contributors");
    expect(text).toContain("Copyright Mathias Bynens");
    expect(text).toContain("The ISC License");
  });
  it("includes the exact local supplement for each version whose npm archive omits its license", async () => {
    for (const [name, version, copyright] of [
      ["@nodable/entities", "3.1.0", "Copyright (c) 2026 Nodable"],
      ["@dukelib/sheets-wasm", "0.1.21", "Copyright (c) 2026 Gus Eggert"],
      ["isarray", "1.0.0", "Copyright (c) 2013 Julian Gruber"],
    ]) {
      const f = await fixture(name, version);
      await writeNotices([f.meta], f.destination);
      const text = await readFile(f.destination, "utf8");
      expect(text).toContain(copyright);
      expect(text).toContain("The above copyright notice and this permission notice");
      expect(text).toContain("THE SOFTWARE IS PROVIDED");
    }
  });
});
