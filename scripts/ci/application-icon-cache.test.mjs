import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "../..");
const electronMock = `
export const iconLoads = [];
export const app = {
  async getFileIcon(path) {
    iconLoads.push(path);
    return { isEmpty: () => false, toDataURL: () => "data:image/png;base64," + path };
  },
};
`;

const result = await build({
  stdin: {
    contents: `
      export { getApplicationIcon } from "./packages/desktop/src/main/applicationIcons.ts";
      export { iconLoads } from "electron";
      export { __testApplicationIconCache as applicationIconCache } from "./packages/desktop/src/main/applicationIcons.ts";
      export { __testCreateApplicationIconCache as createApplicationIconCache } from "./packages/desktop/src/main/applicationIcons.ts";
    `,
    resolveDir: root,
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "node24",
  define: { "process.platform": JSON.stringify("win32") },
  plugins: [
    {
      name: "application-icon-cache-fixtures",
      setup(builder) {
        builder.onLoad({ filter: /applicationIcons\.ts$/ }, async ({ path }) => ({
          contents: `${await readFile(path, "utf8")}\nexport { applicationIconCache as __testApplicationIconCache, createApplicationIconCache as __testCreateApplicationIconCache };`,
          loader: "ts",
        }));
        builder.onResolve({ filter: /^electron$/ }, () => ({
          path: "electron",
          namespace: "fixture-electron",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fixture-electron" }, () => ({
          contents: electronMock,
          loader: "js",
        }));
        builder.onResolve({ filter: /^(\.\/)?(editors|logger|windowsAumidIcon)\.js$/ }, (args) => ({
          path: args.path,
          namespace: "fixture-module",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fixture-module" }, ({ path }) => ({
          contents: path.endsWith("editors.js")
            ? "export async function getAppIconDataUrl() { return null; }"
            : path.endsWith("logger.js")
              ? "export const logger = { warn() {} };"
              : "export async function readWindowsAumidIcon() { return null; }",
          loader: "js",
        }));
      },
    },
  ],
});

const fixture = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`
);

test("the real icon entry keeps a 128-item cache and reuses or reloads by LRU", async () => {
  fixture.iconLoads.length = 0;
  for (let index = 0; index < 129; index += 1) {
    const value = await fixture.getApplicationIcon({
      locators: [{ kind: "windows-executable-path", value: `C:\\Apps\\app-${index}.exe` }],
    });
    assert.match(value.iconDataUrl, /^data:image\/png;base64,/);
  }
  assert.equal(fixture.iconLoads.length, 129);
  assert.equal(fixture.applicationIconCache.size, 128);
  assert.equal(
    await fixture
      .getApplicationIcon({
        locators: [{ kind: "windows-executable-path", value: "C:\\Apps\\app-128.exe" }],
      })
      .then((value) => value.iconDataUrl),
    "data:image/png;base64,C:\\Apps\\app-128.exe",
  );
  assert.equal(fixture.iconLoads.length, 129);
  await fixture.getApplicationIcon({
    locators: [{ kind: "windows-executable-path", value: "C:\\Apps\\app-0.exe" }],
  });
  assert.equal(fixture.iconLoads.length, 130);
  await fixture.getApplicationIcon({
    locators: [{ kind: "windows-executable-path", value: "C:\\Apps\\app-0.exe" }],
  });
  assert.equal(fixture.iconLoads.length, 130);
});

test("the cache factory refreshes hits and evicts the least recently used settled entry", async () => {
  const cache = fixture.createApplicationIconCache(2);
  const loads = [];
  const request = (key) =>
    cache.getOrLoad(key, async () => {
      loads.push(key);
      return key;
    });

  await request("a");
  await request("b");
  await request("a");
  await request("c");
  assert.equal(cache.size, 2);
  await request("b");
  assert.deepEqual(loads, ["a", "b", "c", "b"]);
});

test("out-of-order completion does not change LRU access order", async () => {
  const cache = fixture.createApplicationIconCache(2);
  const loads = [];
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  const firstRequest = cache.getOrLoad("first", () => {
    loads.push("first");
    return first.promise;
  });
  const secondRequest = cache.getOrLoad("second", () => {
    loads.push("second");
    return second.promise;
  });

  assert.equal(
    cache.getOrLoad("first", () => Promise.resolve("duplicate")),
    firstRequest,
  );
  first.resolve("first result");
  await firstRequest;
  second.resolve("second result");
  await secondRequest;

  await cache.getOrLoad("third", async () => {
    loads.push("third");
    return "third result";
  });
  await cache.getOrLoad("second", async () => {
    loads.push("second");
    return "second retry";
  });

  assert.deepEqual(loads, ["first", "second", "third", "second"]);
});

test("pending entries survive capacity pressure and same-key requests share work", async () => {
  const cache = fixture.createApplicationIconCache(1);
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  let firstLoads = 0;
  const firstRequest = cache.getOrLoad("first", () => {
    firstLoads += 1;
    return first.promise;
  });
  const secondRequest = cache.getOrLoad("second", () => second.promise);

  assert.equal(
    cache.getOrLoad("first", () => Promise.resolve("duplicate")),
    firstRequest,
  );
  assert.equal(firstLoads, 1);
  assert.equal(cache.size, 2);
  first.resolve("first result");
  assert.equal(await firstRequest, "first result");
  assert.equal(cache.size, 1);
  second.resolve("second result");
  assert.equal(await secondRequest, "second result");
  assert.equal(cache.size, 1);
});

test("rejected loads are removed so the next request can retry", async () => {
  const cache = fixture.createApplicationIconCache(2);
  const failure = Promise.withResolvers();
  const firstRequest = cache.getOrLoad("retry", () => failure.promise);
  failure.reject(new Error("temporary icon read failure"));

  await assert.rejects(firstRequest, /temporary icon read failure/);
  assert.equal(cache.size, 0);
  assert.equal(await cache.getOrLoad("retry", async () => "recovered"), "recovered");
});
