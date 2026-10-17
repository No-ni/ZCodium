import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import {
  createSkillSyncArchive,
  extractSkillSyncArchive,
} from "../../services/src/skill-sync/skillSyncArchive.js";

const fake = vi.hoisted(() => ({ createGunzip: vi.fn() }));
vi.mock("node:zlib", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:zlib")>();
  return {
    ...original,
    createGunzip: (...args: Parameters<typeof original.createGunzip>) =>
      fake.createGunzip.getMockImplementation()
        ? fake.createGunzip(...args)
        : original.createGunzip(...args),
  };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  fake.createGunzip.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "zcodium-archive-performance-"));
  roots.push(root);
  return root;
}

function header(name: string, size: number, type = "0") {
  const value = Buffer.alloc(512);
  value.write(name, 0, 100, "utf8");
  value.write(size.toString(8).padStart(11, "0"), 124, 11, "ascii");
  value.write(type, 156, 1, "ascii");
  return value;
}

function entry(name: string, data: Buffer, type = "0") {
  return Buffer.concat([
    header(name, data.length, type),
    data,
    Buffer.alloc((512 - (data.length % 512)) % 512),
  ]);
}

function streamChunks(raw: Buffer, chunkBytes: number, trailingError?: Error) {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < raw.length; offset += chunkBytes) {
    chunks.push(raw.subarray(offset, offset + chunkBytes));
  }
  const stream = new PassThrough();
  stream[Symbol.asyncIterator] = async function* () {
    yield* chunks;
    if (trailingError) throw trailingError;
  };
  fake.createGunzip.mockReturnValue(stream);
  return { stream, chunks };
}

function observeBufferQueue(chunks: Buffer[]) {
  const sourceChunks = new Set(chunks);
  const counters = { peakChunks: 0, movedReferences: 0 };
  const originalPush = Array.prototype.push;
  const originalShift = Array.prototype.shift;
  const originalSplice = Array.prototype.splice;
  Array.prototype.push = function (this: unknown[], ...items) {
    if (items.length === 1 && sourceChunks.has(items[0] as Buffer)) {
      counters.peakChunks = Math.max(counters.peakChunks, this.length + 1);
    }
    return originalPush.apply(this, items);
  };
  Array.prototype.shift = function (this: unknown[]) {
    if (Buffer.isBuffer(this[0])) counters.movedReferences += Math.max(0, this.length - 1);
    return originalShift.call(this);
  };
  Array.prototype.splice = function (
    this: unknown[],
    ...args: [start: number, deleteCount?: number, ...items: unknown[]]
  ) {
    const [start, deleteCount] = args;
    if (start === 0 && Buffer.isBuffer(this[0])) {
      const removed = args.length === 1 ? this.length : (deleteCount ?? 0);
      counters.movedReferences += Math.max(0, this.length - removed);
    }
    return Reflect.apply(originalSplice, this, args);
  };
  return {
    counters,
    restore() {
      Array.prototype.push = originalPush;
      Array.prototype.shift = originalShift;
      Array.prototype.splice = originalSplice;
    },
  };
}

it("round trips real gzip with empty, Unicode and multi-chunk binary files", async () => {
  const root = await tempRoot();
  const source = join(root, "source");
  await mkdir(source);
  const binary = Buffer.from(Array.from({ length: 180_001 }, (_, index) => index % 251));
  await Promise.all([
    writeFile(join(source, "空文件.txt"), ""),
    writeFile(join(source, "SKILL.md"), "# 测试技能\n跨分块 UTF-8 ✅\n"),
    writeFile(join(source, "payload.bin"), binary),
  ]);
  const archive = await createSkillSyncArchive([{ sourcePath: source, archivePath: "demo" }]);
  const target = join(root, "target");
  await extractSkillSyncArchive(archive, target, { maxExtractedBytes: 200_000 });
  expect(await readFile(join(target, "demo", "payload.bin"))).toEqual(binary);
  expect(await readFile(join(target, "demo", "空文件.txt"), "utf8")).toBe("");
  expect(await readFile(join(target, "demo", "SKILL.md"), "utf8")).toBe(
    "# 测试技能\n跨分块 UTF-8 ✅\n",
  );
});

it("consumes a large file with linear queue work and preserves adjacent entry boundaries", async () => {
  const root = await tempRoot();
  const payload = Buffer.alloc(512 * 1024 + 17, 71);
  const raw = Buffer.concat([
    entry("large.bin", payload),
    entry("next.txt", Buffer.from("next")),
    Buffer.alloc(1024),
  ]);
  const { chunks, stream } = streamChunks(raw, 509);
  const observer = observeBufferQueue(chunks);
  try {
    await extractSkillSyncArchive(Buffer.from("mock"), root);
  } finally {
    observer.restore();
  }
  expect(await readFile(join(root, "large.bin"))).toEqual(payload);
  expect(await readFile(join(root, "next.txt"), "utf8")).toBe("next");
  expect(observer.counters.movedReferences).toBeLessThan(chunks.length * 2);
  expect(stream.destroyed).toBe(true);
});

it("skips directory payload with bounded buffering without consuming the next file", async () => {
  const root = await tempRoot();
  const raw = Buffer.concat([
    entry("directory/", Buffer.alloc(512 * 1024 + 1, 71), "5"),
    entry("directory/next.txt", Buffer.from("after skip")),
    Buffer.alloc(1024),
  ]);
  const { chunks, stream } = streamChunks(raw, 512);
  const observer = observeBufferQueue(chunks);
  try {
    await extractSkillSyncArchive(Buffer.from("mock"), root);
  } finally {
    observer.restore();
  }
  expect(await readFile(join(root, "directory", "next.txt"), "utf8")).toBe("after skip");
  expect(observer.counters.peakChunks).toBeLessThanOrEqual(2);
  expect(stream.destroyed).toBe(true);
});

it.each([
  ["header", Buffer.alloc(1)],
  ["file", Buffer.concat([header("file.bin", 513), Buffer.alloc(512)])],
  ["padding", Buffer.concat([header("file.bin", 1), Buffer.alloc(1)])],
  ["directory", Buffer.concat([header("directory/", 513, "5"), Buffer.alloc(512)])],
] as const)("rejects truncated %s and destroys the source stream", async (_kind, raw) => {
  const root = await tempRoot();
  const { stream } = streamChunks(raw, 127);
  const inputs = vi.spyOn(Readable, "from");
  await expect(extractSkillSyncArchive(Buffer.from("mock"), root)).rejects.toThrow("truncated");
  expect(stream.destroyed).toBe(true);
  expect(inputs.mock.results[0].value.destroyed).toBe(true);
});

it.each([
  ["limit", entry("large.bin", Buffer.alloc(2048)), /size limit exceeded/],
  ["path", entry("../escape", Buffer.from("no")), /unsafe skill archive path/],
  ["type", entry("link", Buffer.from("no"), "2"), /unsupported skill archive entry type/],
] as const)("preserves %s rejection and destroys the stream", async (_kind, raw, error) => {
  const root = await tempRoot();
  const { stream } = streamChunks(raw, 127);
  const inputs = vi.spyOn(Readable, "from");
  await expect(
    extractSkillSyncArchive(Buffer.from("mock"), root, { maxExtractedBytes: 1024 }),
  ).rejects.toThrow(error);
  expect(stream.destroyed).toBe(true);
  expect(inputs.mock.results[0].value.destroyed).toBe(true);
});

it.each([false, true])(
  "propagates upstream errors, including after the end block (%s)",
  async (end) => {
    const root = await tempRoot();
    const raw = end ? Buffer.alloc(512) : Buffer.alloc(10);
    const { stream } = streamChunks(raw, 127, new Error("synthetic gzip failure"));
    await expect(extractSkillSyncArchive(Buffer.from("mock"), root)).rejects.toThrow(
      "synthetic gzip failure",
    );
    expect(stream.destroyed).toBe(true);
  },
);
