import assert from "node:assert/strict";
import { once } from "node:events";
import fs, { mkdir, readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { mock, test } from "node:test";
import {
  assertProjectPath,
  createProjectTestFixture,
} from "../../../scripts/ci/project-test-sandbox.mjs";
import { isInsideDirectory, resolveStaticFile } from "../src/httpStaticFiles.js";

for (const [name, paths, root] of [
  ["POSIX", path.posix, "/fixture/static"],
  ["Windows", path.win32, "C:/fixture/static"],
] as const) {
  const cases: [string, string, boolean][] = [
    ["root", root, true],
    ["child", paths.join(root, "dir", "asset.js"), true],
    ["dot-prefixed name", paths.join(root, "..asset.js"), true],
    ["dot-suffixed directory name", paths.join(root, "dir..", "asset.js"), true],
    ["normalized child", paths.resolve(root, "dir", "..", "asset.js"), true],
    ["parent", paths.dirname(root), false],
    ["outside file", paths.resolve(root, "..", "outside", "secret.txt"), false],
    ["sibling with same prefix", root + "-other/secret.txt", false],
  ];
  for (const [label, candidate, expected] of cases) {
    test(name + " directory containment: " + label, () => {
      assert.equal(isInsideDirectory(root, candidate, paths), expected);
    });
  }
}

test("Windows rejects a different drive without any filesystem IO", () => {
  assert.equal(isInsideDirectory("C:/fixture/static", "D:/fixture/secret.txt", path.win32), false);
});

test("Windows rejects a UNC path from a drive root without filesystem IO", () => {
  assert.equal(
    isInsideDirectory("C:/fixture/static", "//other-host/share/secret.txt", path.win32),
    false,
  );
});

test("Windows accepts a child on the same UNC share", () => {
  assert.equal(
    isInsideDirectory("//static-host/share/dist", "//static-host/share/dist/asset.js", path.win32),
    true,
  );
});

test("Windows rejects a different UNC share without filesystem IO", () => {
  assert.equal(
    isInsideDirectory("//static-host/share/dist", "//static-host/other/secret.txt", path.win32),
    false,
  );
});

async function fixture() {
  const root = await createProjectTestFixture("http-static");
  const staticRoot = await assertProjectPath(path.join(root, "static"));
  const outside = await assertProjectPath(path.join(root, "outside"));
  await mkdir(staticRoot);
  await mkdir(outside);
  const nested = await assertProjectPath(path.join(staticRoot, "nested"));
  await mkdir(nested);
  for (const [file, body] of [
    [path.join(staticRoot, "index.html"), "APP INDEX"],
    [path.join(staticRoot, "asset.js"), "SAFE ASSET"],
    [path.join(staticRoot, "..asset.js"), "SAFE DOT ASSET"],
    [path.join(staticRoot, "asset name.js"), "ENCODED ASSET"],
    [path.join(nested, "index.html"), "NESTED INDEX"],
    [path.join(outside, "secret.txt"), "SYNTHETIC OUTSIDE FILE"],
    [path.join(outside, "index.html"), "SYNTHETIC OUTSIDE INDEX"],
  ] as const) {
    await writeFile(await assertProjectPath(file), body, { flag: "wx" });
  }
  return { root, staticRoot, outside, nested };
}

async function contentAt(file: string | null) {
  assert.notEqual(file, null);
  return readFile(file!, "utf8");
}

test("resolves normal, encoded and directory index files", async () => {
  const f = await fixture();
  assert.equal(
    await contentAt(await resolveStaticFile(f.staticRoot, "/asset.js", false)),
    "SAFE ASSET",
  );
  assert.equal(
    await contentAt(await resolveStaticFile(f.staticRoot, "/asset%20name.js", false)),
    "ENCODED ASSET",
  );
  assert.equal(
    await contentAt(await resolveStaticFile(f.staticRoot, "/nested/", false)),
    "NESTED INDEX",
  );
  assert.equal(await contentAt(await resolveStaticFile(f.staticRoot, "/", false)), "APP INDEX");
});

test("serves a legitimate dot-prefixed filename", async () => {
  const f = await fixture();
  assert.equal(
    await contentAt(await resolveStaticFile(f.staticRoot, "/..asset.js", false)),
    "SAFE DOT ASSET",
  );
});

test("preserves SPA deep-link fallback and its disabled state", async () => {
  const f = await fixture();
  assert.equal(
    await contentAt(await resolveStaticFile(f.staticRoot, "/deep/link", true)),
    "APP INDEX",
  );
  assert.equal(await resolveStaticFile(f.staticRoot, "/deep/link", false), null);
});

test("lexical traversal is not eligible for SPA fallback", async () => {
  const f = await fixture();
  assert.equal(await resolveStaticFile(f.staticRoot, "/%2e%2e/outside/secret.txt", true), null);
});

test("a missing static root remains a miss", async () => {
  const f = await fixture();
  assert.equal(await resolveStaticFile(path.join(f.root, "missing"), "/asset.js", true), null);
});

// Node 的局部写权限不允许创建真实 symlink。只模拟本次项目 fixture 间的
// realpath/stat/readFile 映射，所有原生 IO 仍落到已校验的合成文件，禁止放宽权限。
async function withAliases<T>(aliases: [string, string][], run: () => Promise<T>): Promise<T> {
  const original = { realpath: fs.realpath, stat: fs.stat, readFile: fs.readFile };
  const remap = <Input>(input: Input): Input => {
    if (typeof input !== "string") return input;
    for (const [alias, target] of aliases) {
      if (input === alias || input.startsWith(alias + path.sep)) {
        return path.resolve(target, path.relative(alias, input)) as Input;
      }
    }
    return input;
  };
  const mocks = [
    mock.method(fs, "realpath", (...[input, options]: Parameters<typeof original.realpath>) =>
      original.realpath(remap(input), options),
    ),
    mock.method(fs, "stat", (...[input, options]: Parameters<typeof original.stat>) =>
      original.stat(remap(input), options),
    ),
    mock.method(fs, "readFile", (...[input, options]: Parameters<typeof original.readFile>) =>
      original.readFile(remap(input), options),
    ),
  ];
  syncBuiltinESMExports();
  try {
    return await run();
  } finally {
    for (const context of mocks) context.mock.restore();
    syncBuiltinESMExports();
  }
}

test("rejects a simulated outside directory junction even when SPA fallback is enabled", async () => {
  const f = await fixture();
  const alias = await assertProjectPath(path.join(f.staticRoot, "escape"));
  await withAliases([[alias, f.outside]], async () => {
    assert.equal(await resolveStaticFile(f.staticRoot, "/escape/secret.txt", true), null);
    assert.equal(await resolveStaticFile(f.staticRoot, "/escape/", true), null);
  });
});

test("preserves simulated aliases that stay inside the canonical root", async () => {
  const f = await fixture();
  const alias = await assertProjectPath(path.join(f.staticRoot, "alias"));
  await withAliases([[alias, f.nested]], async () => {
    assert.equal(
      await contentAt(await resolveStaticFile(f.staticRoot, "/alias/", false)),
      "NESTED INDEX",
    );
  });
});

test("preserves a configured static root that is a simulated directory alias", async () => {
  const f = await fixture();
  const alias = await assertProjectPath(path.join(f.root, "static-alias"));
  await withAliases([[alias, f.staticRoot]], async () => {
    assert.equal(await contentAt(await resolveStaticFile(alias, "/asset.js", false)), "SAFE ASSET");
  });
});

async function withHttpFixture(
  run: (base: string, f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
) {
  const f = await fixture();
  const alias = await assertProjectPath(path.join(f.staticRoot, "escape"));
  await withAliases([[alias, f.outside]], async () => {
    const { ServiceCollection } = await import("@zcode/services");
    const { createHttpServer } = await import("../src/http.js");
    const server = createHttpServer(new ServiceCollection(), 0, {
      host: "127.0.0.1",
      staticRoot: f.staticRoot,
    });
    try {
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      await run("http://127.0.0.1:" + address.port, f);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
}

test("real HTTP retains file content, headers, SPA and protected route semantics", async () => {
  await withHttpFixture(async (base) => {
    const asset = await fetch(base + "/asset.js");
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), "SAFE ASSET");
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
    const spa = await fetch(base + "/deep/link");
    assert.equal(spa.status, 200);
    assert.equal(await spa.text(), "APP INDEX");
    assert.equal(spa.headers.get("cache-control"), "no-cache");
    const api = await fetch(base + "/api/not-a-route");
    assert.equal(api.status, 404);
    await api.text();
  });
});

test("real HTTP serves an encoded legitimate dot-prefixed filename", async () => {
  await withHttpFixture(async (base) => {
    const response = await fetch(base + "/%2e%2easset.js");
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "SAFE DOT ASSET");
  });
});

test("real HTTP refuses a simulated junction escape instead of reading a sibling fixture", async () => {
  await withHttpFixture(async (base) => {
    const response = await fetch(base + "/escape/secret.txt");
    assert.equal(response.status, 404);
    assert.notEqual(await response.text(), "SYNTHETIC OUTSIDE FILE");
  });
});

test("Windows rejects another UNC host without filesystem IO", () => {
  assert.equal(
    isInsideDirectory("//static-host/share/dist", "//other-host/share/secret.txt", path.win32),
    false,
  );
});

test("SPA index cannot be a simulated file alias outside the root", async () => {
  const f = await fixture();
  await withAliases(
    [[path.join(f.staticRoot, "index.html"), path.join(f.outside, "index.html")]],
    async () => {
      assert.equal(await resolveStaticFile(f.staticRoot, "/missing", true), null);
    },
  );
});

test("directory index cannot be a simulated file alias outside the root", async () => {
  const f = await fixture();
  await withAliases(
    [[path.join(f.nested, "index.html"), path.join(f.outside, "index.html")]],
    async () => {
      assert.equal(await resolveStaticFile(f.staticRoot, "/nested/", true), null);
    },
  );
});

test("real HTTP keeps MIME and index cache semantics for an allowed file alias", async () => {
  await withHttpFixture(async (base, f) => {
    await withAliases(
      [
        [path.join(f.staticRoot, "asset.js"), path.join(f.nested, "index.html")],
        [path.join(f.staticRoot, "index.html"), path.join(f.staticRoot, "asset name.js")],
      ],
      async () => {
        const asset = await fetch(base + "/asset.js");
        assert.equal(asset.status, 200);
        assert.equal(await asset.text(), "NESTED INDEX");
        assert.equal(asset.headers.get("content-type"), "text/javascript; charset=utf-8");
        const index = await fetch(base + "/");
        assert.equal(index.status, 200);
        assert.equal(await index.text(), "ENCODED ASSET");
        assert.equal(index.headers.get("content-type"), "text/html; charset=utf-8");
        assert.equal(index.headers.get("cache-control"), "no-cache");
      },
    );
  });
});
