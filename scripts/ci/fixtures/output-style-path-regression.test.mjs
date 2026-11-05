import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createOutputStyleService } from "../../../packages/services/src/output-style/outputStyleService.ts";
import { createProjectTestFixture } from "../project-test-sandbox.mjs";

const config = (name) => ({ name, description: "fixture", content: "fixture content" });

async function fixture() {
  const home = await createProjectTestFixture("output-style");
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const styles = join(home, ".claude", "output-styles");
  await mkdir(styles, { recursive: true });
  const sentinel = join(home, ".claude", "sentinel.md");
  await writeFile(sentinel, "unchanged sentinel");
  return { service: createOutputStyleService(), styles, sentinel };
}

test("add rejects path names before touching the outside sentinel", async () => {
  const { service, styles, sentinel } = await fixture();
  for (const name of ["../sentinel", "..\\sentinel", "/sentinel", "C:\\sentinel", "bad\0name"]) {
    await assert.rejects(service.addStyle({ config: config(name) }));
    assert.equal(await readFile(sentinel, "utf8"), "unchanged sentinel");
  }
  assert.deepEqual(await readdir(styles), []);
});

test("update rejects path IDs before touching the outside sentinel", async () => {
  const { service, styles, sentinel } = await fixture();
  for (const id of [
    "custom-../sentinel",
    "custom-..\\sentinel",
    "../sentinel",
    "/sentinel",
    "C:\\sentinel",
    "custom-bad\0name",
  ]) {
    await assert.rejects(service.updateStyle({ id, config: config("Valid") }));
    assert.equal(await readFile(sentinel, "utf8"), "unchanged sentinel");
  }
  assert.deepEqual(await readdir(styles), []);
});

test("delete rejects path IDs before touching the outside sentinel", async () => {
  const { service, styles, sentinel } = await fixture();
  for (const id of [
    "custom-../sentinel",
    "custom-..\\sentinel",
    "../sentinel",
    "/sentinel",
    "C:\\sentinel",
    "custom-bad\0name",
  ]) {
    await assert.rejects(service.deleteStyle({ id }));
    assert.equal(await readFile(sentinel, "utf8"), "unchanged sentinel");
  }
  assert.deepEqual(await readdir(styles), []);
});

test("Unicode, spaces, legacy IDs and interior .md round-trip to the same file", async () => {
  const { service, styles } = await fixture();
  await service.addStyle({ config: config("审查 样式") });
  await writeFile(
    join(styles, "report.md.extra.md"),
    "name: Report\ndescription: fixture\n\noriginal",
  );
  await writeFile(join(styles, "Existing Style.md"), "name: Existing\n\noriginal");
  const { styles: listed } = await service.listStyles();
  assert.ok(listed.some((style) => style.id === "custom-审查-样式"));
  assert.ok(listed.some((style) => style.id === "custom-report.md.extra"));
  assert.ok(listed.some((style) => style.id === "custom-Existing Style"));
  await service.updateStyle({ id: "custom-report.md.extra", config: config("Updated") });
  assert.match(await readFile(join(styles, "report.md.extra.md"), "utf8"), /name: Updated/);
  await service.updateStyle({ id: "Existing Style", config: config("Legacy") });
  assert.match(await readFile(join(styles, "Existing Style.md"), "utf8"), /name: Legacy/);
  await service.deleteStyle({ id: "custom-report.md.extra" });
  await service.deleteStyle({ id: "Existing Style" });
  assert.deepEqual(await readdir(styles), ["审查-样式.md"]);
});
