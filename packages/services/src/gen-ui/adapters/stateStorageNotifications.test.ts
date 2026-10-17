import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildGenUiScopeKey,
  type GenUiStateTarget,
  type GenUiWidgetState,
} from "@zcode/shared/gen-ui";
import { createGenUiStateStorage } from "./stateStorage.js";

const watchControl = vi.hoisted(() => ({
  callbacks: new Map<string, (event: string, filename: string | null) => void>(),
  closes: [] as Array<ReturnType<typeof vi.fn>>,
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  watch: vi.fn(
    (
      directory: string,
      _options: unknown,
      callback: (event: string, filename: string | null) => void,
    ) => {
      watchControl.callbacks.set(directory, callback);
      const close = vi.fn(() => watchControl.callbacks.delete(directory));
      watchControl.closes.push(close);
      return { on: vi.fn(), close };
    },
  ),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readFile: vi.fn(original.readFile),
    stat: vi.fn(original.stat),
    rename: vi.fn(original.rename),
  };
});
vi.mock("../../logger/serviceLogger.js", () => ({
  createServiceLogger: () => ({ warn: vi.fn() }),
}));

const cleanup: Array<() => void | Promise<void>> = [];
const releases: Array<() => void> = [];
afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  for (const close of cleanup.splice(0).reverse()) await close();
  watchControl.callbacks.clear();
  watchControl.closes.length = 0;
  vi.restoreAllMocks();
});

const target: GenUiStateTarget = {
  workspacePath: "C:/synthetic/workspace",
  sessionId: "session",
  path: "C:/synthetic/workspace/chart.html",
};
const state = (value: number): GenUiWidgetState => ({
  modelContent: { value },
  privateContent: null,
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

async function fixture(targets = [target]) {
  const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(readFile).mockImplementation(original.readFile);
  vi.mocked(stat).mockImplementation(original.stat);
  vi.mocked(rename).mockImplementation(original.rename);
  const root = await mkdtemp(join(tmpdir(), "zcodium-round24-"));
  cleanup.push(async () => {
    const child = relative(tmpdir(), root);
    if (child.startsWith("..") || !basename(root).startsWith("zcodium-round24-"))
      throw new Error("Unexpected fixture root");
    await rm(root, { recursive: true, force: true });
  });
  const storage = createGenUiStateStorage(root);
  cleanup.push(() => storage.dispose());
  const fileFor = (item = target) =>
    join(root, hash(buildGenUiScopeKey(item)), `${hash(item.path)}.json`);
  for (const item of targets) await storage.set(item, state(0));
  const changed = vi.fn();
  const subscription = storage.onChanged(changed);
  cleanup.push(() => subscription.dispose());
  vi.mocked(readFile).mockClear();
  vi.mocked(stat).mockClear();
  const notify = (count = 1, item = target) => {
    const file = fileFor(item);
    const callback = watchControl.callbacks.get(dirname(file));
    if (!callback) throw new Error("No fixture watcher");
    for (let index = 0; index < count; index += 1) callback("change", basename(file));
  };
  const externalWrite = async (value: number, item = target) => {
    await writeFile(
      fileFor(item),
      JSON.stringify({ target: item, state: state(value), updatedAt: value + 1 }),
    );
  };
  const reads = (item = target) =>
    vi.mocked(readFile).mock.calls.filter(([path]) => path === fileFor(item)).length;
  const stats = (item = target) =>
    vi.mocked(stat).mock.calls.filter(([path]) => path === fileFor(item)).length;
  return { storage, changed, fileFor, notify, externalWrite, reads, stats, original };
}

async function holdNextRead(file: string) {
  const original = vi.mocked(readFile).getMockImplementation()!;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  releases.push(() => release.resolve());
  let captured = false;
  vi.mocked(readFile).mockImplementation(async (...args) => {
    const contents = await original(...args);
    if (args[0] === file && !captured) {
      captured = true;
      entered.resolve();
      await release.promise;
    }
    return contents;
  });
  return { entered: entered.promise, release: () => release.resolve() };
}

async function flushMicrotasks() {
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
}

describe("Gen UI notification read scheduling", () => {
  it("coalesces a burst before the first read instead of rereading every filesystem signal", async () => {
    const f = await fixture();
    await f.externalWrite(1);
    f.notify(256);
    // set 同时经过原子写入和同文件通知队列；返回时此前通知已完成，便于完整计量。
    await f.storage.set(target, state(1));
    expect(f.changed.mock.calls.map(([event]) => event.state)).toEqual([state(1)]);
    expect(f.reads()).toBeLessThanOrEqual(4);
    expect(f.stats()).toBeLessThanOrEqual(4);
  });

  it("keeps one follow-up read during slow IO and publishes old then new state in order", async () => {
    const f = await fixture();
    await f.externalWrite(1);
    const first = await holdNextRead(f.fileFor());
    f.notify();
    await first.entered;
    await f.externalWrite(2);
    f.notify(512);
    first.release();
    await f.storage.set(target, state(2));
    expect(f.changed.mock.calls.map(([event]) => event.state)).toEqual([state(1), state(2)]);
    expect(f.reads()).toBeLessThanOrEqual(5);
    expect(f.stats()).toBeLessThanOrEqual(5);
  });

  it("waits for a read after the durable write, but not for later notifications to become idle", async () => {
    const f = await fixture();
    const first = await holdNextRead(f.fileFor());
    f.notify();
    await first.entered;
    const committed = Promise.withResolvers<void>();
    vi.mocked(rename).mockImplementation(async (...args) => {
      await f.original.rename(...args);
      if (args[1] === f.fileFor()) committed.resolve();
    });
    let saved = false;
    const saving = f.storage.set(target, state(1)).then(() => {
      saved = true;
    });
    await committed.promise;
    await flushMicrotasks();
    const second = await holdNextRead(f.fileFor());
    first.release();
    await second.entered;
    expect(saved).toBe(false);
    const third = await holdNextRead(f.fileFor());
    f.notify(64);
    second.release();
    await saving;
    await third.entered;
    expect(saved).toBe(true);
    expect(f.changed.mock.calls.map(([event]) => event.state)).toEqual([state(1)]);
    third.release();
    await f.storage.set(target, state(1));
    expect(f.reads()).toBeLessThanOrEqual(7);
  });

  it.each([
    { ...target, path: "C:/synthetic/workspace/other.html" },
    { ...target, sessionId: "other-session" },
    { ...target, workspaceIdentity: "synthetic-remote" },
  ])("does not let a blocked file delay another scope: %j", async (other) => {
    const f = await fixture([target, other]);
    await f.externalWrite(1);
    const first = await holdNextRead(f.fileFor());
    f.notify();
    await first.entered;
    f.notify(128);
    await f.storage.set(other, state(3));
    expect(f.changed.mock.calls.map(([event]) => event)).toEqual([
      { target: other, state: state(3) },
    ]);
    first.release();
    await f.storage.set(target, state(1));
    expect(f.changed.mock.calls.at(-1)?.[0]).toEqual({ target, state: state(1) });
    expect(f.reads()).toBeLessThanOrEqual(5);
  });

  it("recovers a later batch after a read failure", async () => {
    const f = await fixture();
    const first = await holdNextRead(f.fileFor());
    f.notify();
    await first.entered;
    await writeFile(f.fileFor(), "invalid JSON");
    const original = vi.mocked(readFile).getMockImplementation()!;
    const failed = Promise.withResolvers<void>();
    vi.mocked(readFile).mockImplementation(async (...args) => {
      const contents = await original(...args);
      if (args[0] === f.fileFor() && contents === "invalid JSON") failed.resolve();
      return contents;
    });
    f.notify(128);
    first.release();
    await failed.promise;
    await f.externalWrite(4);
    await f.storage.set(target, state(4));
    expect(f.changed.mock.calls.at(-1)?.[0].state).toEqual(state(4));
    expect(f.reads()).toBeLessThanOrEqual(6);
  });

  it("preserves deletion and identical-state notification suppression", async () => {
    const f = await fixture();
    await rm(f.fileFor());
    const removed = Promise.withResolvers<void>();
    const off = f.storage.onChanged((event) => {
      if (event.state === null) removed.resolve();
    });
    f.notify(128);
    await removed.promise;
    await f.storage.set(target, state(0));
    expect(f.changed.mock.calls.map(([event]) => event.state)).toEqual([null, state(0)]);
    f.notify(128);
    await f.storage.set(target, state(0));
    expect(f.changed).toHaveBeenCalledTimes(2);
    expect(f.stats()).toBeLessThanOrEqual(8);
    off.dispose();
  });

  it("reports a write's notification read failure and lets the next write recover", async () => {
    const f = await fixture();
    const failure = new Error("synthetic notification read failure");
    let rejectNextPublishedRead = true;
    vi.mocked(readFile).mockImplementation(async (...args) => {
      const contents = await f.original.readFile(...args);
      if (
        args[0] === f.fileFor() &&
        rejectNextPublishedRead &&
        JSON.parse(String(contents)).state.modelContent.value === 1
      ) {
        rejectNextPublishedRead = false;
        throw failure;
      }
      return contents;
    });
    await expect(f.storage.set(target, state(1))).rejects.toBe(failure);
    expect(f.changed).not.toHaveBeenCalled();
    expect(await f.storage.get(target)).toEqual(state(1));
    await f.storage.set(target, state(2));
    expect(f.changed.mock.calls.map(([event]) => event.state)).toEqual([state(2)]);
  });

  it("does not publish or read queued work after disposal", async () => {
    const f = await fixture();
    await f.externalWrite(1);
    const first = await holdNextRead(f.fileFor());
    f.notify();
    await first.entered;
    f.notify(256);
    f.storage.dispose();
    first.release();
    await new Promise<void>((resolveDone) => setImmediate(resolveDone));
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.reads()).toBe(1);
    expect(watchControl.closes.every((close) => close.mock.calls.length === 1)).toBe(true);
  });
});
