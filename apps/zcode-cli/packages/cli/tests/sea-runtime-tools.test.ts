import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { ensureSeaRuntimeTools, type SeaRuntimeModule } from "../src/sea-runtime-tools.js";

const fixturePlatform = process.platform === "win32" ? "win32" : "darwin";
const fixtureArch = fixturePlatform === "win32" ? "x64" : "arm64";
const fixtureTarget = fixturePlatform === "win32" ? "win-x64" : "darwin-arm64";

type ToolFixture = {
  binaryName: string;
  bytes: Buffer;
  id: "bfs" | "ripgrep" | "ugrep";
  version: string;
};

test("does nothing outside a SEA runtime", async () => {
  const result = await ensureSeaRuntimeTools({
    sea: {
      getAsset: () => {
        throw new Error("unexpected manifest read");
      },
      getRawAsset: () => {
        throw new Error("unexpected asset read");
      },
      isSea: () => false,
    },
  });

  assert.deepEqual(result, {});
});

test("extracts target tools into version and hash addressed cache directories", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcode-sea-runtime-cache-"));
  const fixture = createSeaFixture({
    target: fixtureTarget,
    tools: defaultToolFixtures(),
  });

  try {
    const runtimeEnv = await ensureSeaRuntimeTools({
      arch: fixtureArch,
      platform: fixturePlatform,
      sea: fixture.sea,
      storageRoot,
    });

    for (const tool of fixture.tools) {
      const envVar = envVarFor(tool.id);
      const binaryPath = runtimeEnv[envVar];
      assert.ok(binaryPath);
      assert.equal(
        binaryPath,
        join(
          storageRoot,
          "cache",
          "runtime_tools",
          fixtureTarget,
          tool.id,
          `${tool.version}-${tool.sha256}`,
          tool.binaryName,
        ),
      );
      assert.deepEqual(await readFile(binaryPath), tool.bytes);
      if (fixturePlatform !== "win32") assert.notEqual((await stat(binaryPath)).mode & 0o111, 0);
    }
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test("reuses unchanged tools when another tool changes", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcode-sea-runtime-reuse-"));
  const firstFixture = createSeaFixture({
    target: fixtureTarget,
    tools: defaultToolFixtures(),
  });
  const changedFixtures = defaultToolFixtures().map((tool) =>
    tool.id === "ugrep" ? { ...tool, bytes: Buffer.from("ugrep-next") } : tool,
  );
  const secondFixture = createSeaFixture({
    target: fixtureTarget,
    tools: changedFixtures,
  });

  try {
    const first = await ensureSeaRuntimeTools({
      arch: fixtureArch,
      platform: fixturePlatform,
      sea: firstFixture.sea,
      storageRoot,
    });
    const firstBfsStat = await stat(assertPath(first.ZCODE_BFS_BINARY));

    const second = await ensureSeaRuntimeTools({
      arch: fixtureArch,
      platform: fixturePlatform,
      sea: secondFixture.sea,
      storageRoot,
    });
    const secondBfsStat = await stat(assertPath(second.ZCODE_BFS_BINARY));

    assert.equal(second.ZCODE_BFS_BINARY, first.ZCODE_BFS_BINARY);
    assert.equal(secondBfsStat.ino, firstBfsStat.ino);
    assert.notEqual(second.ZCODE_UGREP_BINARY, first.ZCODE_UGREP_BINARY);
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test("repairs caches with invalid size, hash, marker, or executable mode", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcode-sea-runtime-repair-"));
  const fixture = createSeaFixture({
    target: fixtureTarget,
    tools: defaultToolFixtures(),
  });
  const options = {
    arch: fixtureArch,
    platform: fixturePlatform,
    sea: fixture.sea,
    storageRoot,
  };

  try {
    const first = await ensureSeaRuntimeTools(options);
    if (fixturePlatform !== "win32") await chmod(assertPath(first.ZCODE_BFS_BINARY), 0o644);
    await writeFile(assertPath(first.ZCODE_RG_BINARY), "short");
    await writeFile(
      join(assertPath(first.ZCODE_UGREP_BINARY), "..", ".zcodium-runtime-tool.json"),
      "{}",
    );

    const repaired = await ensureSeaRuntimeTools(options);

    if (fixturePlatform !== "win32") assert.notEqual((await stat(assertPath(repaired.ZCODE_BFS_BINARY))).mode & 0o111, 0);
    for (const tool of fixture.tools) {
      assert.deepEqual(await readFile(assertPath(repaired[envVarFor(tool.id)])), tool.bytes);
    }

    await writeFile(assertPath(repaired.ZCODE_RG_BINARY), "corrupt");
    const hashRepaired = await ensureSeaRuntimeTools(options);
    assert.deepEqual(
      await readFile(assertPath(hashRepaired.ZCODE_RG_BINARY)),
      Buffer.from("ripgrep"),
    );
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test("concurrent first runs converge without temporary cache residue", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcode-sea-runtime-race-"));
  const fixture = createSeaFixture({
    target: fixtureTarget,
    tools: defaultToolFixtures(),
  });
  const options = {
    arch: fixtureArch,
    platform: fixturePlatform,
    sea: fixture.sea,
    storageRoot,
  };

  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => ensureSeaRuntimeTools(options)),
    );

    for (const result of results.slice(1)) assert.deepEqual(result, results[0]);
    const runtimeRoot = join(storageRoot, "cache", "runtime_tools", fixtureTarget);
    const entries = await collectEntries(runtimeRoot);
    assert.equal(
      entries.some((entry) => entry.includes(".tmp-")),
      false,
    );
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});


test("concurrent repairs preserve the published cache and release all owners", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcodium-sea-repair-race-"));
  const fixture = createSeaFixture({ target: fixtureTarget, tools: defaultToolFixtures() });
  const options = { arch: fixtureArch, platform: fixturePlatform, sea: fixture.sea, storageRoot };
  try {
    const first = await ensureSeaRuntimeTools(options);
    await writeFile(assertPath(first.ZCODE_RG_BINARY), "broken");
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => ensureSeaRuntimeTools(options)));
    for (const result of results) {
      assert.equal(result.status, "fulfilled");
      if (result.status === "fulfilled") assert.deepEqual(result.value, first);
    }
    assert.deepEqual(await readFile(assertPath(first.ZCODE_RG_BINARY)), Buffer.from("ripgrep"));
    const entries = await collectEntries(join(storageRoot, "cache"));
    assert.equal(entries.some((entry) => entry.includes(".tmp-") || entry.endsWith(".lock")), false);
  } finally { await rm(storageRoot, { force: true, recursive: true }); }
});

test("a non-directory cache target is preserved during repair", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcodium-sea-linked-cache-"));
  const fixture = createSeaFixture({ target: fixtureTarget, tools: defaultToolFixtures() });
  const options = { arch: fixtureArch, platform: fixturePlatform, sea: fixture.sea, storageRoot };
  try {
    const first = await ensureSeaRuntimeTools(options);
    const cache = dirname(assertPath(first.ZCODE_RG_BINARY));
    await rm(cache, { recursive: true });
    await writeFile(cache, "retain");
    await assert.rejects(ensureSeaRuntimeTools(options));
    assert.equal((await lstat(cache)).isFile(), true);
    assert.equal(await readFile(cache, "utf8"), "retain");
  } finally { await rm(storageRoot, { force: true, recursive: true }); }
});

test("preserves explicit runtime tool overrides", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcode-sea-runtime-override-"));
  const fixture = createSeaFixture({
    target: fixtureTarget,
    tools: defaultToolFixtures(),
  });

  try {
    const runtimeEnv = await ensureSeaRuntimeTools({
      arch: fixtureArch,
      env: { ZCODE_BFS_BINARY: "/custom/bfs" },
      platform: fixturePlatform,
      sea: fixture.sea,
      storageRoot,
    });

    assert.equal(runtimeEnv.ZCODE_BFS_BINARY, undefined);
    assert.ok(runtimeEnv.ZCODE_RG_BINARY);
    assert.ok(runtimeEnv.ZCODE_UGREP_BINARY);
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test("extracts Windows SEA tools using the win target and executable name", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcode-sea-runtime-win-"));
  const fixture = createSeaFixture({
    target: "win-x64",
    tools: [
      {
        binaryName: "rg.exe",
        bytes: Buffer.from("windows-rg"),
        id: "ripgrep",
        version: "14.1.1",
      },
      {
        binaryName: "ugrep.exe",
        bytes: Buffer.from("windows-ugrep"),
        id: "ugrep",
        version: "7.8.4",
      },
    ],
  });

  try {
    const runtimeEnv = await ensureSeaRuntimeTools({
      arch: "x64",
      platform: "win32",
      sea: fixture.sea,
      storageRoot,
    });

    assert.match(assertPath(runtimeEnv.ZCODE_RG_BINARY), /runtime_tools[/\\]win-x64[/\\]ripgrep/u);
    assert.equal(assertPath(runtimeEnv.ZCODE_RG_BINARY).endsWith("rg.exe"), true);
    assert.match(assertPath(runtimeEnv.ZCODE_UGREP_BINARY), /runtime_tools[/\\]win-x64[/\\]ugrep/u);
    assert.equal(assertPath(runtimeEnv.ZCODE_UGREP_BINARY).endsWith("ugrep.exe"), true);
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test("rejects corrupt assets and target mismatches", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcode-sea-runtime-invalid-"));
  const fixture = createSeaFixture({
    target: fixtureTarget,
    tools: defaultToolFixtures(),
  });
  const corruptSea: SeaRuntimeModule = {
    ...fixture.sea,
    getRawAsset: (key) =>
      key.includes("/bfs/") ? toArrayBuffer(Buffer.from("bad")) : fixture.sea.getRawAsset(key),
  };

  try {
    await assert.rejects(
      ensureSeaRuntimeTools({
        arch: fixtureArch,
        platform: fixturePlatform,
        sea: corruptSea,
        storageRoot,
      }),
      /SEA runtime tool hash mismatch for bfs/,
    );
    await assert.rejects(
      ensureSeaRuntimeTools({
        arch: fixtureArch === "x64" ? "arm64" : "x64",
        platform: fixturePlatform,
        sea: fixture.sea,
        storageRoot,
      }),
      /SEA runtime tool target mismatch/,
    );
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});

function defaultToolFixtures(): ToolFixture[] {
  return [
    { binaryName: "bfs", bytes: Buffer.from("bfs"), id: "bfs", version: "4.1.1" },
    {
      binaryName: "rg",
      bytes: Buffer.from("ripgrep"),
      id: "ripgrep",
      version: "14.1.1",
    },
    { binaryName: "ugrep", bytes: Buffer.from("ugrep"), id: "ugrep", version: "7.8.4" },
  ];
}

function createSeaFixture(input: { target: string; tools: ToolFixture[] }): {
  sea: SeaRuntimeModule;
  tools: Array<ToolFixture & { assetKey: string; sha256: string }>;
} {
  const assets = new Map<string, Buffer>();
  const tools = input.tools.map((tool) => {
    const sha256 = createHash("sha256").update(tool.bytes).digest("hex");
    const assetKey = `zcode-runtime-tools/${tool.id}/${sha256}/${tool.binaryName}`;
    assets.set(assetKey, tool.bytes);
    return { ...tool, assetKey, sha256 };
  });
  const manifestTools = tools.map((tool) => ({
    binaryName: tool.binaryName,
    id: tool.id,
    sha256: tool.sha256,
    size: tool.bytes.byteLength,
    version: tool.version,
  }));
  const manifest = JSON.stringify({
    target: input.target,
    tools: manifestTools,
    version: 1,
  });

  return {
    sea: {
      getAsset: () => manifest,
      getRawAsset: (key) => {
        const bytes = assets.get(key);
        if (!bytes) throw new Error(`missing fake SEA asset ${key}`);
        return toArrayBuffer(bytes);
      },
      isSea: () => true,
    },
    tools,
  };
}

function envVarFor(toolId: ToolFixture["id"]): string {
  switch (toolId) {
    case "bfs":
      return "ZCODE_BFS_BINARY";
    case "ripgrep":
      return "ZCODE_RG_BINARY";
    case "ugrep":
      return "ZCODE_UGREP_BINARY";
  }
}

function assertPath(value: string | undefined): string {
  assert.ok(value);
  return value;
}

function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

async function collectEntries(root: string): Promise<string[]> {
  const entries: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    entries.push(path);
    if (entry.isDirectory()) entries.push(...(await collectEntries(path)));
  }
  return entries;
}
