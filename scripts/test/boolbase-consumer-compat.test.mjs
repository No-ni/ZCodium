import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const requireFromConsumer = createRequire(require.resolve("css-select"));

function fixtureList() {
  const list = { type: "tag", name: "ul", attribs: {}, children: [], parent: null };
  for (let index = 0; index < 5; index++) {
    list.children.push({
      type: "tag",
      name: "li",
      attribs: { id: String(index), class: index === 2 ? "skip" : "" },
      children: [],
      parent: list,
      prev: null,
      next: null,
    });
  }
  for (let index = 0; index < list.children.length; index++) {
    list.children[index].prev = list.children[index - 1] ?? null;
    list.children[index].next = list.children[index + 1] ?? null;
  }
  return list;
}

function assertSelectors(consumer) {
  const list = fixtureList();
  for (const [selector, expected] of [
    ["li:nth-child(odd)", ["0", "2", "4"]],
    ["li:nth-child(-n+2)", ["0", "1"]],
    ["li:nth-child(0)", []],
    ["li:not(.skip)", ["0", "1", "3", "4"]],
    ['li[id^=""]', []],
    ["li", ["0", "1", "2", "3", "4"]],
  ]) {
    assert.deepEqual(
      consumer.selectAll(selector, [list]).map((element) => element.attribs.id),
      expected,
      selector,
    );
  }
}

test("boolbase compatibility default preserves named function identities for the existing consumer", async () => {
  const cjs = requireFromConsumer("boolbase");
  const esm = await import("boolbase");
  // 老消费者比较 trueFunc/falseFunc 的引用，兼容对象不能重新创建两个函数。
  assert.equal(cjs.default, esm.default);
  assert.equal(esm.default.trueFunc, esm.trueFunc);
  assert.equal(esm.default.falseFunc, esm.falseFunc);
});

test("CSS selector consumers work through CommonJS and ESM", async () => {
  assertSelectors(require("css-select"));
  assertSelectors(await import("css-select"));
});

test("the browser bundle resolves the existing ESM default imports and executes selectors", async () => {
  const result = await build({
    stdin: {
      contents: 'export { selectAll } from "css-select";',
      resolveDir: fileURLToPath(new URL("../..", import.meta.url)),
      sourcefile: "boolbase-consumer-fixture.mjs",
    },
    platform: "browser",
    format: "esm",
    bundle: true,
    write: false,
    logLevel: "silent",
  });
  const consumer = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
  );
  assertSelectors(consumer);
});
