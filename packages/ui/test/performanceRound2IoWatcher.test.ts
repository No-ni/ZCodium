import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import type { FileWatchEvent } from "@zcode/shared";
import { createFileWatcherService } from "../../services/src/fileWatcher/fileWatcherService.js";

const fake = vi.hoisted(() => ({ watch: vi.fn() }));
vi.mock("node:fs", () => ({ watch: fake.watch }));
vi.mock("node:path", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:path")>();
  return { ...original, resolve: vi.fn(original.resolve) };
});
let callback: (event: string, fileName: string | null) => void;
let watcher: EventEmitter & { close: ReturnType<typeof vi.fn> };
let service: ReturnType<typeof createFileWatcherService>;
beforeEach(() => {
  vi.useFakeTimers();
  watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
  fake.watch.mockImplementation((_path, _options, listener) => {
    callback = listener;
    return watcher;
  });
  service = createFileWatcherService({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  });
});
afterEach(() => {
  service.disposeAll();
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("preserves one-path precision and collapses large or unknown change batches", async () => {
  const path = resolve("synthetic-watcher");
  const { id } = await service.watch({ path, recursive: true });
  const events: FileWatchEvent[] = [];
  service.onDynamicChange(id)((event) => events.push(event));
  callback("change", "one.txt");
  callback("change", "one.txt");
  await vi.advanceTimersByTimeAsync(150);
  expect(events).toEqual([{ dirPath: path, changedPath: resolve(path, "one.txt") }]);
  vi.mocked(resolve).mockClear();
  for (let i = 0; i < 10_000; i++) callback("rename", `file-${i}.txt`);
  expect(resolve).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(150);
  expect(events.at(-1)).toEqual({ dirPath: path });
  callback("change", "one.txt");
  callback("change", null);
  callback("change", "one.txt");
  await vi.advanceTimersByTimeAsync(150);
  expect(events.at(-1)).toEqual({ dirPath: path });
  callback("change", "next.txt");
  await vi.advanceTimersByTimeAsync(150);
  expect(events.at(-1)).toEqual({ dirPath: path, changedPath: resolve(path, "next.txt") });
});

it.each(["unwatch", "error", "dispose"] as const)("cleans pending events on %s", async (mode) => {
  const path = resolve("synthetic-watcher");
  const { id } = await service.watch({ path });
  const events: FileWatchEvent[] = [];
  service.onDynamicChange(id)((event) => events.push(event));
  callback("change", "one.txt");
  if (mode === "unwatch") await service.unwatch({ id });
  else if (mode === "error") watcher.emit("error", new Error("synthetic watcher error"));
  else service.disposeAll();
  await vi.advanceTimersByTimeAsync(500);
  expect(watcher.close).toHaveBeenCalledTimes(1);
  expect(events).toEqual(mode === "error" ? [{ dirPath: path }] : []);
});
