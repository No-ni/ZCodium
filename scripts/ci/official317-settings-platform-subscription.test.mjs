import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
test("shared platform settings subscription refreshes its cache keys and releases exactly once", async () => {
  const text = await readFile(
    new URL("../../packages/ui/src/hooks/useSettingService.ts", import.meta.url),
    "utf8",
  );
  const file = ts.createSourceFile("settings.ts", text, ts.ScriptTarget.Latest, true);
  const source = file.statements
    .filter((n) => !ts.isImportDeclaration(n))
    .map((n) => n.getText(file).replace(/^export\s+/, ""))
    .join("\n");
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  const { acquire, snapshot } = new Function(
    js +
      "\nreturn { acquire: acquirePlatformSettingsSubscription, snapshot: getSettingsSnapshot };",
  )();
  let listener,
    registrations = 0,
    disposals = 0,
    reads = 0;
  const service = {
    async get() {
      reads++;
      return { locale: "zh-CN" };
    },
  };
  const platform = {
    onSettingsChanged(fn) {
      registrations++;
      listener = fn;
      return () => {
        disposals++;
      };
    },
  };
  const releaseA = acquire(service, platform, "a");
  const releaseB = acquire(service, platform, "b");
  const releaseA2 = acquire(service, platform, "a");
  assert.equal(registrations, 1);
  listener();
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2);
  assert.equal(snapshot("a").settings.locale, "zh-CN");
  assert.equal(snapshot("b").settings.locale, "zh-CN");
  releaseA();
  releaseA();
  releaseA2();
  assert.equal(disposals, 0);
  releaseB();
  releaseB();
  assert.equal(disposals, 1);
  acquire(service, platform, "a")();
  assert.equal(registrations, 2);
  assert.equal(disposals, 2);
});
